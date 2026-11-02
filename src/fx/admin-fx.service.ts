import { BadRequestException, HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import type { FxRateSource } from '../generated/prisma/client.js';
import { SINGLETON_FX_RATE_ID } from '../checkout/fx-rate.constants.js';
import { ApiException } from '../common/api-exception.js';
import { buildPageMeta } from '../common/pagination.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  FxAuditQueryDto,
  FxAuditResponseDto,
  FxHistoryQueryDto,
  FxHistoryResponseDto,
  FxLiveSourcesDto,
  FxSettingsResponseDto,
  FxStatusResponseDto,
  RefreshFxResponseDto,
  UpdateFxSettingsDto,
  UpdateFxSettingsResponseDto,
} from './dto/admin-fx.dto.js';
import type { FxProviderResult } from './fx-provider.js';
import {
  FxRefreshService,
  buildRejectedReading,
} from './fx-refresh.service.js';
import { evaluateReading } from './fx-validation.js';
import type { FxRejectReason } from './fx-validation.js';

const LIVE_SOURCES = ['BCV_USD', 'BCV_EUR', 'PARALELO_USD'] as const;
const HOUR_MS = 3600 * 1000;
/** Reasons the admin may override (everything else is structurally invalid). */
const ACCEPTABLE: readonly FxRejectReason[] = [
  'VARIATION_EXCEEDED',
  'DATE_REGRESSION',
  'DATE_NOT_NEWER',
];

interface LockedRow {
  source: FxRateSource;
  rejectedReading: Prisma.JsonValue | null;
}

/** Story 18.2 (AD-79 "Admin", AD-78 FxSettingAudit, FR-90/92/95). */
@Injectable()
export class AdminFxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refresher: FxRefreshService,
  ) {}

  async getSettings(): Promise<FxSettingsResponseDto> {
    const s = await this.loadSetting();
    return this.toSettings(s);
  }

  async updateSettings(
    dto: UpdateFxSettingsDto,
    adminUserId: string,
  ): Promise<UpdateFxSettingsResponseDto> {
    const manual = dto.manualVesPerUsd;
    if (
      dto.source === 'MANUAL' &&
      !(typeof manual === 'number' && manual > 0)
    ) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'FX_MANUAL_RATE_REQUIRED',
        'source=MANUAL requires manualVesPerUsd > 0.',
      );
    }
    if (manual !== undefined && !(manual > 0)) {
      throw new BadRequestException('manualVesPerUsd must be greater than 0.');
    }

    // Source change to a live feed: obtain the NEW source's reading BEFORE
    // committing anything (network outside any tx), so (source, rate) can be
    // written together. QA 18.3 fix: never leave source=B with source A's rate.
    let reading: FxProviderResult | undefined;
    if (dto.source !== 'MANUAL') {
      const pre = await this.prisma.fxRateSetting.findUnique({
        where: { id: SINGLETON_FX_RATE_ID },
        select: { source: true },
      });
      if (pre && pre.source !== dto.source) {
        reading = await this.refresher.fetchReading(dto.source);
      }
    }

    const outcome = await this.prisma.$transaction(async (tx) => {
      // Same lock as FxRefreshService (blocking here: the cron just waits us).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('fx:refresh', 0))`;
      const rows = await tx.$queryRaw<
        {
          source: FxRateSource;
          maxVariationPct: Prisma.Decimal;
        }[]
      >`
        SELECT "source", "maxVariationPct" FROM "Fx_Rate_Settings"
        WHERE "id" = ${SINGLETON_FX_RATE_ID} FOR UPDATE`;
      const current = rows[0];
      if (!current) this.unavailable();
      const now = new Date();
      const changed = current.source !== dto.source;
      const data: Prisma.FxRateSettingUpdateInput = { source: dto.source };
      if (manual !== undefined) {
        data.manualVesPerUsd = new Prisma.Decimal(manual);
      }
      if (dto.maxAgeHours !== undefined) data.maxAgeHours = dto.maxAgeHours;
      if (dto.maxVariationPct !== undefined) {
        data.maxVariationPct = new Prisma.Decimal(dto.maxVariationPct);
      }
      let refresh = 'MANUAL';
      let reason: string | null = null;
      let snapshotRow: {
        rate: Prisma.Decimal;
        providerUpdatedAt: Date;
        fetchedAt: Date;
      } | null = null;

      if (dto.source === 'MANUAL') {
        data.vesPerUsd = new Prisma.Decimal(manual as number);
        data.rateFetchedAt = now;
        data.providerUpdatedAt = null;
      } else if (changed) {
        const last = await tx.fxRateSnapshot.findFirst({
          where: { source: dto.source },
          orderBy: [{ providerUpdatedAt: 'desc' }, { fetchedAt: 'desc' }],
        });
        const maxVar =
          dto.maxVariationPct ?? current.maxVariationPct.toNumber();
        let applied = false;
        let lastError: string | null = null;
        let rejected: Prisma.InputJsonObject | null = null;
        if (reading?.ok) {
          const verdict = evaluateReading({
            reading: reading.reading,
            current: last
              ? {
                  rate: last.rate.toNumber(),
                  providerUpdatedAt: last.providerUpdatedAt,
                }
              : null,
            maxVariationPct: maxVar,
            now,
          });
          if (verdict.ok) {
            const rate = new Prisma.Decimal(
              reading.reading.rate,
            ).toDecimalPlaces(4);
            data.vesPerUsd = rate;
            data.providerUpdatedAt = reading.reading.providerUpdatedAt;
            data.rateFetchedAt = now;
            snapshotRow = {
              rate,
              providerUpdatedAt: reading.reading.providerUpdatedAt,
              fetchedAt: now,
            };
            applied = true;
            refresh = 'UPDATED';
          } else {
            refresh = 'REJECTED';
            reason = verdict.reason;
            lastError = `Reading rejected: ${verdict.reason}`;
            rejected = buildRejectedReading(
              dto.source,
              reading.reading,
              verdict.reason,
              now,
            );
          }
        } else {
          refresh = 'FAILED';
          const err = reading?.ok === false ? reading.error : 'no reading';
          reason = 'PROVIDER_ERROR';
          lastError = err.slice(0, 500);
        }
        if (!applied) {
          if (!last) {
            // Nothing coherent to switch to: keep source AND rate untouched.
            return {
              sourceChanged: false,
              refresh,
              reason: reason ?? 'NO_RATE_AVAILABLE',
              stale: true,
            };
          }
          // Fall back to the new source's own last snapshot, with its real
          // dates, so staleness is evaluated honestly (AD-80).
          data.vesPerUsd = last.rate;
          data.providerUpdatedAt = last.providerUpdatedAt;
          data.rateFetchedAt = last.fetchedAt;
          data.lastError = lastError;
          data.lastErrorAt = now;
          data.rejectedReading = rejected ?? Prisma.DbNull;
        }
      }
      if (dto.source === 'MANUAL' || (changed && !data.lastError)) {
        data.lastError = null;
        data.lastErrorAt = null;
        data.rejectedReading = Prisma.DbNull;
      }
      await tx.fxRateSetting.update({
        where: { id: SINGLETON_FX_RATE_ID },
        data,
      });
      if (snapshotRow) {
        await tx.$executeRaw`
          INSERT INTO "Fx_Rate_Snapshots" ("id", "source", "rate", "providerUpdatedAt", "fetchedAt")
          VALUES (gen_random_uuid(), ${dto.source}::"FxRateSource", ${snapshotRow.rate}, ${snapshotRow.providerUpdatedAt}, ${snapshotRow.fetchedAt})
          ON CONFLICT ("source", "providerUpdatedAt") DO NOTHING`;
      }
      // clock_timestamp(): audits of serialized PUTs order by commit order
      // (now() would be the tx START time, which can interleave).
      await tx.$executeRaw`
        INSERT INTO "Fx_Setting_Audits"
          ("id", "adminUserId", "fromSource", "toSource", "manualRate", "action", "createdAt")
        VALUES (gen_random_uuid(), ${adminUserId}::uuid,
          ${current.source}::"FxRateSource", ${dto.source}::"FxRateSource",
          ${dto.source === 'MANUAL' ? new Prisma.Decimal(manual as number) : null},
          'SETTINGS_UPDATED'::"FxSettingAction", clock_timestamp())`;
      return {
        sourceChanged: changed || undefined,
        refresh,
        reason,
        stale: !['UPDATED', 'MANUAL'].includes(refresh),
        // Same live source: no pair risk; refresh after the commit as before.
        needsRefresh: dto.source !== 'MANUAL' && !changed,
      };
    });

    let { refresh, stale } = outcome;
    if (outcome.needsRefresh) {
      try {
        refresh = (await this.refresher.refresh(dto.source)).status;
      } catch {
        refresh = 'FAILED';
      }
      stale = !['UPDATED', 'NOOP', 'MANUAL'].includes(refresh);
    }
    const s = await this.loadSetting();
    // Story 18.12: same threshold as getStatus() / checkout (maxAgeHours x 3).
    // A switch that fell back to an old snapshot can leave the checkout in 503.
    const hardStale =
      s.source !== 'MANUAL' &&
      Date.now() - (s.rateFetchedAt ?? s.updatedAt).getTime() >
        s.maxAgeHours * HOUR_MS * 3;
    return {
      ...this.toSettings(s),
      stale,
      hardStale,
      refresh,
      sourceChanged: outcome.sourceChanged ?? s.source === dto.source,
      reason: outcome.reason ?? null,
    };
  }

  async getStatus(): Promise<FxStatusResponseDto> {
    const s = await this.loadSetting();
    const sources = await this.liveSources();
    const fetched = s.rateFetchedAt ?? s.updatedAt;
    const age = Date.now() - fetched.getTime();
    const limit = s.maxAgeHours * HOUR_MS;
    const isManual = s.source === 'MANUAL';
    return {
      source: s.source,
      rate: s.vesPerUsd.toFixed(4),
      providerUpdatedAt: s.providerUpdatedAt?.toISOString() ?? null,
      fetchedAt: s.rateFetchedAt?.toISOString() ?? null,
      stale: !isManual && age > limit,
      hardStale: !isManual && age > limit * 3,
      lastError: s.lastError,
      rejectedReading:
        (s.rejectedReading as Record<string, unknown> | null) ?? null,
      sources,
    };
  }

  async refresh(): Promise<RefreshFxResponseDto> {
    const r = await this.refresher.refresh();
    if (r.status === 'IN_PROGRESS') {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'FX_REFRESH_IN_PROGRESS',
        'Another FX refresh is already running; try again in a moment.',
      );
    }
    return { ...(await this.getStatus()), result: r.status };
  }

  async acceptRejected(adminUserId: string): Promise<FxStatusResponseDto> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<LockedRow[]>`
        SELECT "source", "rejectedReading" FROM "Fx_Rate_Settings"
        WHERE "id" = ${SINGLETON_FX_RATE_ID} FOR UPDATE`;
      const row = rows[0];
      if (!row) this.unavailable();
      const rr = row.rejectedReading as {
        source?: string;
        rawRate?: string;
        providerUpdatedAt?: string | null;
        reason?: FxRejectReason;
      } | null;
      if (!rr || (rr.source && rr.source !== row.source)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'FX_NO_REJECTED_READING',
          'There is no rejected reading to accept for the active source.',
        );
      }
      const rawRate = Number(rr.rawRate);
      const at = rr.providerUpdatedAt ? new Date(rr.providerUpdatedAt) : null;
      const now = new Date();
      // Skips the variation / date comparison only; structure is re-checked.
      const structural =
        at && rr.reason && ACCEPTABLE.includes(rr.reason)
          ? evaluateReading({
              reading: { rate: rawRate, providerUpdatedAt: at },
              current: null,
              maxVariationPct: 100,
              now,
            })
          : { ok: false as const };
      if (!structural.ok || !at) {
        throw new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'FX_REJECTED_READING_NOT_ACCEPTABLE',
          'The rejected reading is structurally invalid and cannot be applied.',
        );
      }
      const rate = new Prisma.Decimal(rawRate).toDecimalPlaces(4);
      await tx.fxRateSetting.update({
        where: { id: SINGLETON_FX_RATE_ID },
        data: {
          vesPerUsd: rate,
          providerUpdatedAt: at,
          rateFetchedAt: now,
          lastError: null,
          lastErrorAt: null,
          rejectedReading: Prisma.DbNull,
        },
      });
      // Same (source, providerUpdatedAt) already stored (DATE_NOT_NEWER): the
      // explicit admin decision also corrects the stored rate (AD-79).
      await tx.$executeRaw`
        INSERT INTO "Fx_Rate_Snapshots" ("id", "source", "rate", "providerUpdatedAt", "fetchedAt")
        VALUES (gen_random_uuid(), ${row.source}::"FxRateSource", ${rate}, ${at}, ${now})
        ON CONFLICT ("source", "providerUpdatedAt") DO UPDATE SET "rate" = EXCLUDED."rate"`;
      await tx.$executeRaw`
        INSERT INTO "Fx_Setting_Audits"
          ("id", "adminUserId", "fromSource", "toSource", "manualRate", "action", "createdAt")
        VALUES (gen_random_uuid(), ${adminUserId}::uuid,
          ${row.source}::"FxRateSource", ${row.source}::"FxRateSource", NULL,
          'REJECTED_READING_ACCEPTED'::"FxSettingAction", clock_timestamp())`;
    });
    return this.getStatus();
  }

  async history(q: FxHistoryQueryDto): Promise<FxHistoryResponseDto> {
    const rows = await this.prisma.fxRateSnapshot.findMany({
      where: q.source ? { source: q.source } : undefined,
      orderBy: [{ fetchedAt: 'desc' }, { id: 'desc' }],
      take: q.limit,
    });
    return {
      data: rows.map((r) => ({
        id: r.id,
        source: r.source,
        rate: r.rate.toFixed(4),
        providerUpdatedAt: r.providerUpdatedAt.toISOString(),
        fetchedAt: r.fetchedAt.toISOString(),
      })),
    };
  }

  async audit(q: FxAuditQueryDto): Promise<FxAuditResponseDto> {
    const [total, rows] = await Promise.all([
      this.prisma.fxSettingAudit.count(),
      this.prisma.fxSettingAudit.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (q.page - 1) * q.limit,
        take: q.limit,
        include: { adminUser: { select: { id: true, email: true } } },
      }),
    ]);
    return {
      data: rows.map((r) => ({
        id: r.id,
        admin: r.adminUser
          ? { id: r.adminUser.id, email: r.adminUser.email }
          : null,
        fromSource: r.fromSource,
        toSource: r.toSource,
        manualRate: r.manualRate?.toFixed(4) ?? null,
        action: r.action,
        createdAt: r.createdAt.toISOString(),
      })),
      meta: buildPageMeta(q.page, q.limit, total),
    };
  }

  private async loadSetting() {
    const s = await this.prisma.fxRateSetting.findUnique({
      where: { id: SINGLETON_FX_RATE_ID },
    });
    if (!s) this.unavailable();
    return s;
  }

  private toSettings(
    s: Prisma.FxRateSettingGetPayload<object>,
  ): FxSettingsResponseDto {
    return {
      source: s.source,
      manualVesPerUsd: s.manualVesPerUsd?.toFixed(4) ?? null,
      maxAgeHours: s.maxAgeHours,
      maxVariationPct: s.maxVariationPct.toNumber(),
      vesPerUsd: s.vesPerUsd.toFixed(4),
    };
  }

  private async liveSources(): Promise<FxLiveSourcesDto> {
    const snaps = await Promise.all(
      LIVE_SOURCES.map((source) =>
        this.prisma.fxRateSnapshot.findFirst({
          where: { source },
          orderBy: [{ providerUpdatedAt: 'desc' }, { fetchedAt: 'desc' }],
        }),
      ),
    );
    const out = {} as FxLiveSourcesDto;
    LIVE_SOURCES.forEach((source, i) => {
      const r = snaps[i];
      out[source] = r
        ? {
            rate: r.rate.toFixed(4),
            providerUpdatedAt: r.providerUpdatedAt.toISOString(),
            fetchedAt: r.fetchedAt.toISOString(),
          }
        : null;
    });
    return out;
  }

  private unavailable(): never {
    throw new ApiException(
      HttpStatus.SERVICE_UNAVAILABLE,
      'FX_RATE_UNAVAILABLE',
      'The FX rate setting row is missing.',
    );
  }
}
