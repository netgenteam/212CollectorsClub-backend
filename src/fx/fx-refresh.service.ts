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
  evaluateReading,
  isSameReading,
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

/** Who asked for the refresh: the scheduler (cron / boot) or an admin pressing "refresh". */
export type FxRefreshOrigin = 'AUTO_REFRESH' | 'ADMIN_REFRESH';

interface LockedSetting {
  source: FxRateSource;
  vesPerUsd: Prisma.Decimal;
  maxVariationPct: Prisma.Decimal;
  providerUpdatedAt: Date | null;
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
    opts: { origin?: FxRefreshOrigin; adminId?: string } = {},
  ): Promise<FxRefreshResult> {
    const setting = await this.prisma.fxRateSetting.findUnique({
      where: { id: SINGLETON_FX_RATE_ID },
      select: { source: true },
    });
    if (!setting) return { status: 'SKIPPED' };
    const active = setting.source;
    if (source && source !== active) return { status: 'SKIPPED' };
    if (active === 'MANUAL') return { status: 'MANUAL' };

    // Network OUTSIDE the transaction. The provider never throws, but guard
    // anyway so a bug there cannot escape.
    const result = await this.fetchReading(active);

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
        return { status: 'FAILED', source: active, error };
      }
      throw err;
    }
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
        SELECT "source", "vesPerUsd", "maxVariationPct", "providerUpdatedAt"
        FROM "Fx_Rate_Settings"
        WHERE "id" = ${SINGLETON_FX_RATE_ID}
        FOR UPDATE`;
      const row = rows[0];
      // Source changed (or row vanished) while we were fetching: drop it.
      if (!row || row.source !== active) return { status: 'SKIPPED' } as const;

      if (!result.ok) {
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
      // AC6: compare only against the active source's own history; with none
      // the reading is accepted (explicit admin action).
      const current = last
        ? {
            rate: last.rate.toNumber(),
            providerUpdatedAt: last.providerUpdatedAt,
          }
        : null;

      const verdict = evaluateReading({
        reading,
        current,
        maxVariationPct: row.maxVariationPct.toNumber(),
        now,
      });
      if (!verdict.ok) {
        await tx.fxRateSetting.update({
          where: { id: SINGLETON_FX_RATE_ID },
          data: {
            lastError: `Reading rejected: ${verdict.reason}`,
            lastErrorAt: now,
            rejectedReading: buildRejectedReading(
              active,
              reading,
              verdict.reason,
              now,
            ),
          },
        });
        return {
          status: 'REJECTED',
          source: active,
          reason: verdict.reason,
        } as const;
      }

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
