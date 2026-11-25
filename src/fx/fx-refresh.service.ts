import '../common/env-at-import.js';
import { cronFromEnv } from '../common/cron-expression.js';
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '../generated/prisma/client.js';
import type { FxRateSource } from '../generated/prisma/client.js';
import { SINGLETON_FX_RATE_ID } from '../checkout/fx-rate.constants.js';
import { AuditService, AUDIT_ERROR_CODE } from '../audit/audit.service.js';
import { SYSTEM_ACTOR, payload } from '../audit/audit-events.js';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { FX_PROVIDER } from './fx-provider.js';
import type { FxProvider, FxProviderResult } from './fx-provider.js';
import {
  FX_REFERENCE_MAX_AGE_HOURS_DEFAULT,
  FX_REFERENCE_MAX_AGE_HOURS_MAX,
  FX_REFERENCE_MAX_AGE_HOURS_MIN,
  decideReading,
  isSameReading,
  selectReference,
  type FxCandidate,
  type FxRejectReason,
} from './fx-validation.js';

export const FX_SNAPSHOT_RETENTION_DAYS = 400;

export type FxRefreshResult =
  | { status: 'UPDATED'; source: FxRateSource; rate: string }
  | { status: 'NOOP'; source: FxRateSource }
  | { status: 'REJECTED'; source: FxRateSource; reason: FxRejectReason }
  | { status: 'FAILED'; source: FxRateSource; error: string }
  | { status: 'IN_PROGRESS' }
  | { status: 'MANUAL' }
  | { status: 'SKIPPED' };

/** Story 22.2 (AD-110): `all` = the 3 live sources (cron, boot, POST refresh); `active` = only the active one (PUT settings). */
export type FxRefreshScope = 'all' | 'active';

export const FX_LIVE_SOURCES = ['BCV_USD', 'BCV_EUR', 'PARALELO_USD'] as const;

/** What one attempt left in `Fx_Source_States`. */
export interface FxStatePatch {
  now: Date;
  /** A valid, accepted reading was obtained this attempt (sets `lastSuccessAt`). */
  success: boolean;
  /** null clears `lastError`/`lastErrorAt`. */
  error: string | null;
  /** `'keep'` leaves the stored candidate untouched; null clears it. */
  rejected: 'keep' | null | Prisma.InputJsonObject;
}

type RawExecutor = Pick<Prisma.TransactionClient, '$executeRaw'>;

/** `INSERT ... ON CONFLICT (source) DO UPDATE` of one source's state (never Prisma `upsert`). */
export async function upsertSourceState(
  db: RawExecutor,
  source: FxRateSource,
  p: FxStatePatch,
): Promise<void> {
  const keep = p.rejected === 'keep';
  const rejectedJson =
    p.rejected === null || keep ? null : JSON.stringify(p.rejected);
  const error = p.error === null ? null : p.error.slice(0, 500);
  await db.$executeRaw`
    INSERT INTO "Fx_Source_States"
      ("source", "lastAttemptAt", "lastSuccessAt", "lastError", "lastErrorAt", "rejectedReading")
    VALUES (${source}::"FxRateSource", ${p.now}, ${p.success ? p.now : null}, ${error},
      ${error === null ? null : p.now}, ${rejectedJson}::jsonb)
    ON CONFLICT ("source") DO UPDATE SET
      "lastAttemptAt" = EXCLUDED."lastAttemptAt",
      "lastSuccessAt" = COALESCE(EXCLUDED."lastSuccessAt", "Fx_Source_States"."lastSuccessAt"),
      "lastError" = EXCLUDED."lastError",
      "lastErrorAt" = EXCLUDED."lastErrorAt",
      "rejectedReading" = CASE WHEN ${keep} THEN "Fx_Source_States"."rejectedReading" ELSE EXCLUDED."rejectedReading" END`;
}

/** Who asked for the refresh: the scheduler (cron / boot) or an admin pressing "refresh". */
export type FxRefreshOrigin = 'AUTO_REFRESH' | 'ADMIN_REFRESH';

interface LockedSetting {
  source: FxRateSource;
  vesPerUsd: Prisma.Decimal;
  maxVariationPct: Prisma.Decimal;
  providerUpdatedAt: Date | null;
  rejectedReading: unknown;
}

/** `rejectedReading` payload, always tagged with the source it belongs to. */
export function buildRejectedReading(
  source: FxRateSource,
  reading: { rate: number; providerUpdatedAt: Date },
  reason: FxRejectReason,
  now: Date,
): Prisma.InputJsonObject {
  return {
    source,
    rate: Number.isFinite(reading.rate) ? reading.rate : null,
    rawRate: String(reading.rate),
    providerUpdatedAt: Number.isNaN(reading.providerUpdatedAt.getTime())
      ? null
      : reading.providerUpdatedAt.toISOString(),
    reason,
    at: now.toISOString(),
  };
}

/** Parses the singleton's `rejectedReading` into a confirmation candidate (same source only). */
export function parseCandidate(
  raw: unknown,
  source: FxRateSource,
): FxCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as {
    source?: string;
    rate?: unknown;
    providerUpdatedAt?: unknown;
    reason?: unknown;
    at?: unknown;
  };
  if (r.source && r.source !== source) return null;
  if (typeof r.rate !== 'number' || !Number.isFinite(r.rate)) return null;
  if (typeof r.providerUpdatedAt !== 'string' || typeof r.at !== 'string') {
    return null;
  }
  const pu = new Date(r.providerUpdatedAt);
  const at = new Date(r.at);
  if (Number.isNaN(pu.getTime()) || Number.isNaN(at.getTime())) return null;
  return {
    rate: r.rate,
    providerUpdatedAt: pu,
    reason: typeof r.reason === 'string' ? r.reason : '',
    at,
  };
}

/**
 * Story 18.1 (AD-79): fetch -> validate -> persist the VES rate.
 *
 * The HTTP fetch happens OUTSIDE the DB transaction; decision + write happen
 * in one transaction guarded by a transaction-scoped advisory try-lock and a
 * `FOR UPDATE` re-read of the singleton row. Uniqueness of snapshots relies
 * on `INSERT ... ON CONFLICT DO NOTHING` (never Prisma `upsert`).
 *
 * `handleCron` only checks the flag and calls the public, testable
 * `refresh` (same shape as `TcgNightlySyncService`).
 */
@Injectable()
export class FxRefreshService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FxRefreshService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Inject(FX_PROVIDER) private readonly provider: FxProvider,
    private readonly audit: AuditService,
  ) {}

  /**
   * Story 22.1 (A114): hours a snapshot stays a valid variation reference.
   * `FX_VARIATION_REFERENCE_MAX_AGE_HOURS`, default 96, range 24..720;
   * an invalid value falls back to the default with a warning.
   */
  getReferenceMaxAgeHours(): number {
    const raw = this.config.get<string | number | undefined>(
      'FX_VARIATION_REFERENCE_MAX_AGE_HOURS',
    );
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return FX_REFERENCE_MAX_AGE_HOURS_DEFAULT;
    }
    const n = Number(String(raw).trim());
    if (
      !Number.isFinite(n) ||
      n < FX_REFERENCE_MAX_AGE_HOURS_MIN ||
      n > FX_REFERENCE_MAX_AGE_HOURS_MAX
    ) {
      this.logger.warn(
        `Invalid FX_VARIATION_REFERENCE_MAX_AGE_HOURS=${String(raw)} (allowed ${FX_REFERENCE_MAX_AGE_HOURS_MIN}..${FX_REFERENCE_MAX_AGE_HOURS_MAX}); using ${FX_REFERENCE_MAX_AGE_HOURS_DEFAULT}`,
      );
      return FX_REFERENCE_MAX_AGE_HOURS_DEFAULT;
    }
    return n;
  }

  /** `FX_REFRESH_ENABLED=false` disables it; default on (off under NODE_ENV=test). */
  isEnabled(): boolean {
    const v = String(this.config.get('FX_REFRESH_ENABLED') ?? '')
      .trim()
      .toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    return process.env.NODE_ENV !== 'test';
  }

  onApplicationBootstrap(): void {
    if (!this.isEnabled()) {
      this.logger.log('FX refresh is DISABLED (FX_REFRESH_ENABLED).');
      return;
    }
    // Non-blocking: heals a stale rate after a deploy without delaying boot.
    void this.safeRefresh('bootstrap');
  }

  // NOTE: the expression is read when the class is decorated, i.e. at import: `env-at-import` loads `.env` first
  // (Story 20.8 round 2: before, a value only in `.env` was ignored), and an invalid one stops the start naming
  // FX_REFRESH_CRON (`cronFromEnv`) instead of a bare CronError.
  @Cron(cronFromEnv('FX_REFRESH_CRON', '*/30 * * * *'), { name: 'fx-refresh' })
  async handleCron(): Promise<void> {
    if (!this.isEnabled()) return;
    await this.safeRefresh('cron');
  }

  @Cron('30 3 * * *', { name: 'fx-snapshot-purge', timeZone: 'UTC' })
  async handlePurgeCron(): Promise<void> {
    if (!this.isEnabled()) return;
    try {
      await this.purgeOldSnapshots();
    } catch (err) {
      this.logger.error(`FX snapshot purge failed: ${String(err)}`);
    }
  }

  /** Deletes snapshots older than 400 days; returns the deleted count. */
  async purgeOldSnapshots(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - FX_SNAPSHOT_RETENTION_DAYS * 24 * 3600 * 1000,
    );
    const { count } = await this.prisma.fxRateSnapshot.deleteMany({
      where: { fetchedAt: { lt: cutoff } },
    });
    return count;
  }

  private async safeRefresh(origin: string): Promise<void> {
    try {
      const r = await this.refresh();
      this.logger.log(`FX refresh (${origin}): ${r.status}`);
    } catch (err) {
      // Never let a refresh error take the process down.
      this.logger.error(`FX refresh (${origin}) crashed: ${String(err)}`);
    }
  }

  /**
   * Network fetch (never throws). Callers must NOT hold a DB transaction.
   * Shared with the admin PUT so a source change validates the NEW source's
   * reading before anything is committed (Story 18.3 QA fix).
   */
  async fetchReading(source: FxRateSource): Promise<FxProviderResult> {
    if (source === 'MANUAL') return { ok: false, error: 'MANUAL has no feed' };
    try {
      return await this.provider.fetchRate(source);
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Refreshes the ACTIVE source (a given `source` that is not the active one
   * is skipped). `MANUAL` never touches the network.
   *
   * Story 20.5: a refresh that CHANGES the rate (it moves the prices in bolivares) writes
   * `FX_RATE_CHANGED` (actor SYSTEM; `origin` says whether the scheduler or an admin asked) in the
   * same transaction as the new rate and snapshot, as the last statement (the flush runs after the
   * body; no network is involved: the provider was read before the transaction opened). A rejected
   * reading, a failure and a reading that changes nothing do not emit. If the event cannot be
   * written the transaction rolls back (fail-closed, nothing is half applied); that must not vanish
   * silently, so the failure is logged and recorded in `lastError` (own tiny transaction, no audit
   * event: it is an error note, not a business change) and the result is `FAILED`. The next cycle
   * (30 min) reads the provider again and retries.
   */
  async refresh(
    source?: FxRateSource,
    opts: {
      origin?: FxRefreshOrigin;
      adminId?: string;
      scope?: FxRefreshScope;
    } = {},
  ): Promise<FxRefreshResult> {
    const setting = await this.prisma.fxRateSetting.findUnique({
      where: { id: SINGLETON_FX_RATE_ID },
      select: { source: true },
    });
    if (!setting) return { status: 'SKIPPED' };
    const active = setting.source;
    if (source && source !== active) return { status: 'SKIPPED' };
    const scope = opts.scope ?? 'all';
    const live = active !== 'MANUAL';

    // Story 22.2 (AD-110): network OUTSIDE any transaction, the sources in parallel (each call is capped at
    // 5 s + one retry and never throws; guarded anyway so a bug there cannot escape).
    const targets: FxRateSource[] =
      scope === 'all' ? [...FX_LIVE_SOURCES] : live ? [active] : [];
    const readings = new Map<FxRateSource, FxProviderResult>();
    await Promise.all(
      targets.map(async (t) => {
        readings.set(t, await this.fetchReading(t));
      }),
    );

    // Phase A: the active source (exactly the 22.1 flow). MANUAL: nothing to apply.
    let main: FxRefreshResult = { status: 'MANUAL' };
    let failure: unknown;
    let failed = false;
    if (live) {
      try {
        main = await this.refreshActive(
          active,
          readings.get(active) as FxProviderResult,
          opts,
        );
      } catch (err) {
        failed = true;
        failure = err;
      }
    }
    // Phase B: the other sources (state + snapshots only). Independent of A's outcome.
    if (scope === 'all') {
      await this.refreshInactive(
        FX_LIVE_SOURCES.filter((x) => x !== active),
        readings,
      );
    }
    if (failed) throw failure;
    return main;
  }

  private async refreshActive(
    active: FxRateSource,
    result: FxProviderResult,
    opts: { origin?: FxRefreshOrigin; adminId?: string },
  ): Promise<FxRefreshResult> {
    const now = new Date();
    try {
      return await this.applyReading(active, result, now, opts);
    } catch (err) {
      if (
        err instanceof ApiException &&
        (err.getResponse() as { errorCode?: string }).errorCode ===
          AUDIT_ERROR_CODE
      ) {
        const error = `Refresh not applied: the audit log is unavailable (${active})`;
        this.logger.error(
          `${error}; the previous rate stays; retrying next cycle`,
        );
        await this.prisma.fxRateSetting
          .updateMany({
            where: { id: SINGLETON_FX_RATE_ID, source: active },
            data: { lastError: error.slice(0, 500), lastErrorAt: new Date() },
          })
          .catch((e: unknown) =>
            this.logger.error(
              `could not record the refresh failure: ${String(e)}`,
            ),
          );
        await upsertSourceState(this.prisma, active, {
          now: new Date(),
          success: false,
          error,
          rejected: 'keep',
        }).catch((e: unknown) =>
          this.logger.error(`could not record the source state: ${String(e)}`),
        );
        return { status: 'FAILED', source: active, error };
      }
      throw err;
    }
  }

  /**
   * Story 22.2 (AD-110) phase B: one transaction WITHOUT audit under the SAME advisory try-lock; the active
   * source is re-read under the lock (a source that became active meanwhile is skipped, phase A owns it).
   * Never moves `vesPerUsd`, prices or emits events. Never throws: a failure here must not hide phase A.
   */
  private async refreshInactive(
    sources: readonly FxRateSource[],
    readings: Map<FxRateSource, FxProviderResult>,
  ): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
          SELECT pg_try_advisory_xact_lock(hashtextextended('fx:refresh', 0)) AS locked`;
        if (!locked) return; // the next cycle will do it
        const rows = await tx.$queryRaw<
          { source: FxRateSource; maxVariationPct: Prisma.Decimal }[]
        >`SELECT "source", "maxVariationPct" FROM "Fx_Rate_Settings" WHERE "id" = ${SINGLETON_FX_RATE_ID}`;
        const row = rows[0];
        if (!row) return;
        const now = new Date();
        for (const src of sources) {
          const result = readings.get(src);
          if (!result || src === row.source) continue;
          await this.applyInactive(
            tx,
            src,
            result,
            now,
            row.maxVariationPct.toNumber(),
          );
        }
      });
    } catch (err) {
      this.logger.error(`FX inactive-source phase failed: ${String(err)}`);
    }
  }

  private async applyInactive(
    tx: Prisma.TransactionClient,
    src: FxRateSource,
    result: FxProviderResult,
    now: Date,
    maxVariationPct: number,
  ): Promise<void> {
    if (!result.ok) {
      await upsertSourceState(tx, src, {
        now,
        success: false,
        error: result.error,
        rejected: 'keep',
      });
      return;
    }
    const reading = result.reading;
    const state = await tx.fxSourceState.findUnique({
      where: { source: src },
      select: { rejectedReading: true },
    });
    const last = await tx.fxRateSnapshot.findFirst({
      where: { source: src },
      orderBy: [{ providerUpdatedAt: 'desc' }, { fetchedAt: 'desc' }],
      select: { rate: true, providerUpdatedAt: true },
    });
    const maxAge = this.getReferenceMaxAgeHours();
    const reference = selectReference(
      last
        ? {
            rate: last.rate.toNumber(),
            providerUpdatedAt: last.providerUpdatedAt,
          }
        : null,
      now,
      maxAge,
    );
    const sameKey = Number.isNaN(reading.providerUpdatedAt.getTime())
      ? null
      : await tx.fxRateSnapshot.findFirst({
          where: { source: src, providerUpdatedAt: reading.providerUpdatedAt },
          select: { rate: true, providerUpdatedAt: true },
        });
    const candidate = parseCandidate(state?.rejectedReading, src);
    const verdict = decideReading({
      reading,
      reference,
      candidate,
      maxVariationPct,
      now,
      collision: sameKey
        ? {
            rate: sameKey.rate.toNumber(),
            providerUpdatedAt: sameKey.providerUpdatedAt,
          }
        : null,
      candidateMaxAgeHours: maxAge,
    });
    if (!verdict.accept) {
      const keepCandidate =
        candidate &&
        verdict.reason === 'VARIATION_EXCEEDED' &&
        !(
          reading.providerUpdatedAt.getTime() >
          candidate.providerUpdatedAt.getTime()
        );
      await upsertSourceState(tx, src, {
        now,
        success: false,
        error: `Reading rejected: ${verdict.reason}`,
        rejected: keepCandidate
          ? {
              ...(state?.rejectedReading as Prisma.InputJsonObject),
              at: now.toISOString(),
            }
          : buildRejectedReading(src, reading, verdict.reason, now),
      });
      return;
    }
    const rate = new Prisma.Decimal(reading.rate).toDecimalPlaces(4);
    await tx.$executeRaw`
      INSERT INTO "Fx_Rate_Snapshots" ("id", "source", "rate", "providerUpdatedAt", "fetchedAt")
      VALUES (gen_random_uuid(), ${src}::"FxRateSource", ${rate}, ${reading.providerUpdatedAt}, ${now})
      ON CONFLICT ("source", "providerUpdatedAt") DO NOTHING`;
    await upsertSourceState(tx, src, {
      now,
      success: true,
      error: null,
      rejected: null,
    });
  }

  private applyReading(
    active: FxRateSource,
    result: FxProviderResult,
    now: Date,
    opts: { origin?: FxRefreshOrigin; adminId?: string },
  ): Promise<FxRefreshResult> {
    return this.audit.transaction(async (tx, audit) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended('fx:refresh', 0)) AS locked`;
      if (!locked) return { status: 'IN_PROGRESS' } as const;

      const rows = await tx.$queryRaw<LockedSetting[]>`
        SELECT "source", "vesPerUsd", "maxVariationPct", "providerUpdatedAt", "rejectedReading"
        FROM "Fx_Rate_Settings"
        WHERE "id" = ${SINGLETON_FX_RATE_ID}
        FOR UPDATE`;
      const row = rows[0];
      // Source changed (or row vanished) while we were fetching: drop it.
      if (!row || row.source !== active) return { status: 'SKIPPED' } as const;

      // Story 22.2 (AD-110): the candidate lives in Fx_Source_States (singleton fallback for the first
      // cycle after the migration, when the row does not exist yet).
      const stateRow = await tx.fxSourceState.findUnique({
        where: { source: active },
        select: { rejectedReading: true },
      });
      const candidateRaw = stateRow
        ? stateRow.rejectedReading
        : row.rejectedReading;

      if (!result.ok) {
        await upsertSourceState(tx, active, {
          now,
          success: false,
          error: result.error,
          rejected: 'keep',
        });
        await tx.fxRateSetting.update({
          where: { id: SINGLETON_FX_RATE_ID },
          data: {
            lastError: result.error.slice(0, 500),
            lastErrorAt: now,
          },
        });
        return {
          status: 'FAILED',
          source: active,
          error: result.error,
        } as const;
      }

      const reading = result.reading;
      const last = await tx.fxRateSnapshot.findFirst({
        where: { source: active },
        orderBy: [{ providerUpdatedAt: 'desc' }, { fetchedAt: 'desc' }],
        select: { rate: true, providerUpdatedAt: true },
      });
      const lastView = last
        ? {
            rate: last.rate.toNumber(),
            providerUpdatedAt: last.providerUpdatedAt,
          }
        : null;
      // Story 22.1 (AD-109): only a CURRENT snapshot (by provider date) is a
      // variation reference; a stale residual no longer blocks recovery.
      const reference = selectReference(
        lastView,
        now,
        this.getReferenceMaxAgeHours(),
      );
      // Exact (source, providerUpdatedAt) key, whatever its age.
      const sameKey = Number.isNaN(reading.providerUpdatedAt.getTime())
        ? null
        : await tx.fxRateSnapshot.findFirst({
            where: {
              source: active,
              providerUpdatedAt: reading.providerUpdatedAt,
            },
            select: { rate: true, providerUpdatedAt: true },
          });
      const candidate = parseCandidate(candidateRaw, active);

      let verdict = decideReading({
        reading,
        reference,
        candidate,
        maxVariationPct: row.maxVariationPct.toNumber(),
        now,
        collision: sameKey
          ? {
              rate: sameKey.rate.toNumber(),
              providerUpdatedAt: sameKey.providerUpdatedAt,
            }
          : null,
        candidateMaxAgeHours: this.getReferenceMaxAgeHours(),
      });
      // The active reading never goes back before the applied one.
      if (
        verdict.accept &&
        row.providerUpdatedAt &&
        reading.providerUpdatedAt.getTime() < row.providerUpdatedAt.getTime()
      ) {
        verdict = { accept: false, reason: 'DATE_REGRESSION' };
      }
      if (!verdict.accept) {
        // A newer rejected reading replaces the candidate; an equal or older
        // one only refreshes its `at`.
        const keepCandidate =
          candidate &&
          verdict.reason === 'VARIATION_EXCEEDED' &&
          !(
            reading.providerUpdatedAt.getTime() >
            candidate.providerUpdatedAt.getTime()
          );
        const rejectedJson: Prisma.InputJsonObject = keepCandidate
          ? {
              ...(candidateRaw as Prisma.InputJsonObject),
              at: now.toISOString(),
            }
          : buildRejectedReading(active, reading, verdict.reason, now);
        await upsertSourceState(tx, active, {
          now,
          success: false,
          error: `Reading rejected: ${verdict.reason}`,
          rejected: rejectedJson,
        });
        await tx.fxRateSetting.update({
          where: { id: SINGLETON_FX_RATE_ID },
          data: {
            lastError: `Reading rejected: ${verdict.reason}`,
            lastErrorAt: now,
            rejectedReading: rejectedJson,
          },
        });
        return {
          status: 'REJECTED',
          source: active,
          reason: verdict.reason,
        } as const;
      }
      const confirmed = verdict.via === 'CONFIRMED';
      const current = lastView;

      const rate = new Prisma.Decimal(reading.rate).toDecimalPlaces(4);
      const alreadyApplied =
        isSameReading(reading, current) &&
        row.vesPerUsd.equals(rate) &&
        row.providerUpdatedAt?.getTime() ===
          reading.providerUpdatedAt.getTime();
      if (alreadyApplied) {
        await tx.fxRateSetting.update({
          where: { id: SINGLETON_FX_RATE_ID },
          data: {
            rateFetchedAt: now,
            lastError: null,
            lastErrorAt: null,
            rejectedReading: Prisma.DbNull,
          },
        });
        await upsertSourceState(tx, active, {
          now,
          success: true,
          error: null,
          rejected: null,
        });
        return { status: 'NOOP', source: active } as const;
      }

      await tx.fxRateSetting.update({
        where: { id: SINGLETON_FX_RATE_ID },
        data: {
          vesPerUsd: rate,
          providerUpdatedAt: reading.providerUpdatedAt,
          rateFetchedAt: now,
          lastError: null,
          lastErrorAt: null,
          rejectedReading: Prisma.DbNull,
        },
      });
      await tx.$executeRaw`
        INSERT INTO "Fx_Rate_Snapshots" ("id", "source", "rate", "providerUpdatedAt", "fetchedAt")
        VALUES (gen_random_uuid(), ${active}::"FxRateSource", ${rate}, ${reading.providerUpdatedAt}, ${now})
        ON CONFLICT ("source", "providerUpdatedAt") DO NOTHING`;
      await upsertSourceState(tx, active, {
        now,
        success: true,
        error: null,
        rejected: null,
      });
      if (!row.vesPerUsd.equals(rate)) {
        audit.add({
          ...SYSTEM_ACTOR,
          action: 'FX_RATE_CHANGED',
          entityType: 'FxRateSetting',
          entityId: SINGLETON_FX_RATE_ID,
          before: payload({ rate: row.vesPerUsd }),
          after: payload({
            rate,
            source: active,
            origin: opts.origin ?? 'AUTO_REFRESH',
            ...(opts.adminId ? { triggeredBy: opts.adminId } : {}),
            ...(confirmed && candidate
              ? {
                  confirmedAfterRejection: true,
                  candidateProviderUpdatedAt:
                    candidate.providerUpdatedAt.toISOString(),
                }
              : {}),
          }),
        });
      }
      return {
        status: 'UPDATED',
        source: active,
        rate: rate.toFixed(4),
      } as const;
    });
  }
}
