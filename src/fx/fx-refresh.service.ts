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

interface LockedSetting {
  source: FxRateSource;
  vesPerUsd: Prisma.Decimal;
  maxVariationPct: Prisma.Decimal;
  providerUpdatedAt: Date | null;
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

  // NOTE: the expression is read from the process environment when the class
  // is decorated, so FX_REFRESH_CRON must be exported to the process
  // (systemd EnvironmentFile / shell), not only present in a .env file.
  @Cron(process.env.FX_REFRESH_CRON || '*/30 * * * *', { name: 'fx-refresh' })
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
   * Refreshes the ACTIVE source (a given `source` that is not the active one
   * is skipped). `MANUAL` never touches the network.
   */
  async refresh(source?: FxRateSource): Promise<FxRefreshResult> {
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
    let result: FxProviderResult;
    try {
      result = await this.provider.fetchRate(active);
    } catch (err) {
      result = {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    const now = new Date();
    return this.prisma.$transaction(async (tx) => {
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
            rejectedReading: {
              rate: Number.isFinite(reading.rate) ? reading.rate : null,
              rawRate: String(reading.rate),
              providerUpdatedAt: Number.isNaN(
                reading.providerUpdatedAt.getTime(),
              )
                ? null
                : reading.providerUpdatedAt.toISOString(),
              reason: verdict.reason,
              at: now.toISOString(),
            },
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
      return {
        status: 'UPDATED',
        source: active,
        rate: rate.toFixed(4),
      } as const;
    });
  }
}
