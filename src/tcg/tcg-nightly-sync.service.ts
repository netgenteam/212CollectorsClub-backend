import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  TCG_API_CLIENT,
  TcgApiRateLimitError,
} from './tcg-api-client.interface.js';
import type { TcgApiClient } from './tcg-api-client.interface.js';
import { MasterCardUpsertService } from './master-card-upsert.service.js';
import { TcgSyncRunService } from './tcg-sync-run.service.js';

export const DEFAULT_NIGHTLY_MAX_REQUESTS = 50;
export const DEFAULT_NIGHTLY_REQUEST_RESERVE = 20;
export const DEFAULT_PRICE_ALERT_PCT = 25;
const MAX_BIG_VARIATIONS = 50;
const MAX_PAGES_PER_SET = 100;

export interface PriceVariation {
  productId: string;
  oldPrice: number;
  newPrice: number;
  pct: number;
}

export interface NightlySyncResult {
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'ALREADY_RUNNING';
  runId: string | null;
  requests: number;
  cardsSynced: number;
  productsUpdated: number;
  setsCompleted: number;
  quotaExhausted: boolean;
  errorCount: number;
  errorSummary: string | null;
  bigVariations: PriceVariation[];
}

interface SetWork {
  gameSlug: string;
  setId: string;
  setName: string;
}

/** Internal signal: budget/reserve reached before issuing a request. */
class QuotaStop extends Error {}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Story 15.7 (AD-58, FR-70): nightly price refresh + audit.
 *
 * Quota criterion (Free plan = 100 requests/day, no bulk endpoint): the
 * worker re-lists whole SET pages, never single cards. Sets that contain
 * master cards linked to products go first (`lastPriceSyncAt ASC NULLS
 * FIRST`), then the remaining `DONE` sets by age; it stops at
 * `TCG_NIGHTLY_MAX_REQUESTS` / `TCG_REQUEST_RESERVE` / HTTP 429 (PARTIAL) and
 * the next night continues with the sets that are now oldest.
 *
 * Same shape as `PaymentProcessingTimeoutCronService`: `handleCron` only
 * checks the flag and calls the public `runNightlySync`, which tests call
 * directly. Lock and audit are the `Tcg_Sync_Runs` row shared with the CLI.
 */
@Injectable()
export class TcgNightlySyncService implements OnModuleInit {
  private readonly logger = new Logger(TcgNightlySyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly upsert: MasterCardUpsertService,
    private readonly syncRuns: TcgSyncRunService,
    @Inject(TCG_API_CLIENT) private readonly client: TcgApiClient,
  ) {}

  onModuleInit(): void {
    if (!this.isEnabled()) {
      this.logger.log(
        'Nightly TCG price sync is DISABLED (set TCG_NIGHTLY_SYNC_ENABLED=true to enable).',
      );
    }
  }

  isEnabled(): boolean {
    return (
      String(this.config.get('TCG_NIGHTLY_SYNC_ENABLED') ?? '')
        .trim()
        .toLowerCase() === 'true'
    );
  }

  @Cron('0 3 * * *', { name: 'tcg-nightly-sync', timeZone: 'UTC' })
  async handleCron(): Promise<void> {
    if (!this.isEnabled()) return;
    await this.runNightlySync();
  }

  async runNightlySync(): Promise<NightlySyncResult> {
    const maxRequests = positiveInt(
      this.config.get('TCG_NIGHTLY_MAX_REQUESTS'),
      DEFAULT_NIGHTLY_MAX_REQUESTS,
    );
    const reserve = positiveInt(
      this.config.get('TCG_REQUEST_RESERVE'),
      DEFAULT_NIGHTLY_REQUEST_RESERVE,
    );
    const alertPct = Number(this.config.get('TCG_PRICE_ALERT_PCT'));
    const threshold =
      Number.isFinite(alertPct) && alertPct > 0
        ? alertPct
        : DEFAULT_PRICE_ALERT_PCT;

    const result: NightlySyncResult = {
      status: 'SUCCEEDED',
      runId: null,
      requests: 0,
      cardsSynced: 0,
      productsUpdated: 0,
      setsCompleted: 0,
      quotaExhausted: false,
      errorCount: 0,
      errorSummary: null,
      bigVariations: [],
    };

    const row = await this.syncRuns.tryStart('NIGHTLY');
    if (!row) {
      this.logger.warn('Another sync run is already running — skipping.');
      return { ...result, status: 'ALREADY_RUNNING' };
    }
    result.runId = row.id;

    let remaining: number | null = null;
    const guard = () => {
      if (result.requests >= maxRequests) {
        throw new QuotaStop(`request budget reached (${maxRequests})`);
      }
      if (remaining !== null && remaining <= reserve) {
        throw new QuotaStop(
          `remaining quota (${remaining}) reached the reserve (${reserve})`,
        );
      }
    };

    try {
      for (const work of await this.selectSets()) {
        let page = 1;
        for (let n = 0; n < MAX_PAGES_PER_SET; n++) {
          guard();
          result.requests += 1;
          const res = await this.client.listSetCards(work.setId, page, {
            setName: work.setName,
            gameSlug: work.gameSlug,
          });
          if (res.rateLimit.remaining !== null) {
            remaining = res.rateLimit.remaining;
          }
          const stored = await this.upsert.upsertPage(res.items, {
            provider: this.client.provider,
            gameSlug: work.gameSlug,
            setName: work.setName,
          });
          result.cardsSynced += stored.created + stored.updated;
          const ids = res.items.filter((c) => !c.skip).map((c) => c.externalId);
          const changes = await this.applyProductPrices(ids);
          result.productsUpdated += changes.length;
          this.recordVariations(changes, threshold, result);

          const done = !res.hasMore || res.items.length === 0;
          page += 1;
          if (done) {
            // Cursor moves per set, only once the whole set was refreshed.
            await this.prisma.tcgIngestCursor.updateMany({
              where: { gameSlug: work.gameSlug, setId: work.setId },
              data: { lastPriceSyncAt: new Date() },
            });
            result.setsCompleted += 1;
            break;
          }
        }
      }
    } catch (err) {
      if (err instanceof QuotaStop || err instanceof TcgApiRateLimitError) {
        result.quotaExhausted = true;
        this.logger.warn(
          err instanceof QuotaStop
            ? `Stopping cleanly: ${err.message}`
            : 'Stopping cleanly: tcgapi.dev answered HTTP 429',
        );
      } else {
        result.errorCount += 1;
        result.errorSummary = (
          err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        ).slice(0, 500);
        this.logger.error(`Nightly sync aborted — ${result.errorSummary}`);
      }
    }

    result.status =
      result.errorCount > 0
        ? result.cardsSynced > 0 || result.productsUpdated > 0
          ? 'PARTIAL'
          : 'FAILED'
        : result.quotaExhausted
          ? 'PARTIAL'
          : 'SUCCEEDED';

    try {
      await this.syncRuns.finish(row.id, {
        status: result.status,
        requestsUsed: result.requests,
        cardsSynced: result.cardsSynced,
        productsUpdated: result.productsUpdated,
        errorCount: result.errorCount,
        errorSummary: result.errorSummary,
        quotaExhausted: result.quotaExhausted,
        bigVariations: result.bigVariations as unknown as object[],
        summary: {
          setsCompleted: result.setsCompleted,
          requests: result.requests,
        },
      });
    } catch (err) {
      // Never leave the lock row RUNNING because the audit write failed.
      this.logger.error(`Could not finish sync run ${row.id}: ${String(err)}`);
      throw err;
    }
    this.logger.log(
      `Nightly sync ${result.status}: ${result.requests} requests, ${result.cardsSynced} cards, ${result.productsUpdated} products, ${result.bigVariations.length} big variations`,
    );
    return result;
  }

  /**
   * Linked sets first (any cursor status), then the other DONE sets; each
   * group by `lastPriceSyncAt ASC NULLS FIRST`. Only master cards of the
   * active client provider count as "linked" (AD-53).
   */
  private async selectSets(): Promise<SetWork[]> {
    const provider = this.client.provider;
    const linked = await this.prisma.$queryRaw<SetWork[]>`
      SELECT m."gameSlug", m."setId", min(m."setName") AS "setName"
      FROM "Products" p
      JOIN "Master_Cards" m ON m.id = p."masterCardId"
      LEFT JOIN "Tcg_Ingest_Cursors" c
        ON c."gameSlug" = m."gameSlug" AND c."setId" = m."setId"
      WHERE m."externalProvider" = ${provider}
      GROUP BY m."gameSlug", m."setId", c."lastPriceSyncAt"
      ORDER BY c."lastPriceSyncAt" ASC NULLS FIRST, m."gameSlug", m."setId"
    `;
    const seen = new Set(linked.map((s) => `${s.gameSlug}:${s.setId}`));
    const others = await this.prisma.tcgIngestCursor.findMany({
      where: { status: 'DONE' },
      orderBy: [
        { lastPriceSyncAt: { sort: 'asc', nulls: 'first' } },
        { gameSlug: 'asc' },
        { setId: 'asc' },
      ],
    });
    return [
      ...linked,
      ...others
        .filter((c) => !seen.has(`${c.gameSlug}:${c.setId}`))
        .map((c) => ({
          gameSlug: c.gameSlug,
          setId: c.setId,
          setName: c.setName,
        })),
    ];
  }

  /**
   * ONE statement per page (AD-58, R6). A null master price never matches, so
   * the stored product price survives. Unchanged rows only get their
   * `lastMarketSyncAt` refreshed and are not reported.
   */
  private async applyProductPrices(
    externalIds: string[],
  ): Promise<{ id: string; oldp: string; newp: string }[]> {
    if (externalIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<
      { id: string; oldp: string; newp: string }[]
    >`
      WITH old AS (
        SELECT p.id, p."priceUsd" AS oldp, m."marketPriceUsd" AS newp
        FROM "Products" p
        JOIN "Master_Cards" m ON m.id = p."masterCardId"
        WHERE p."autoSyncPrice" AND NOT p."isManual"
          AND m."marketPriceUsd" IS NOT NULL
          AND m."externalProvider" = ${this.client.provider}
          AND m."externalId" = ANY(${externalIds}::text[])
        FOR UPDATE OF p
      )
      UPDATE "Products" p
      SET "priceUsd" = old.newp, "lastMarketSyncAt" = now(), "updatedAt" = now()
      FROM old
      WHERE p.id = old.id
      RETURNING p.id, old.oldp::text AS oldp, old.newp::text AS newp
    `;
    return rows.filter((r) => Number(r.oldp) !== Number(r.newp));
  }

  private recordVariations(
    changes: { id: string; oldp: string; newp: string }[],
    threshold: number,
    result: NightlySyncResult,
  ): void {
    for (const c of changes) {
      const oldPrice = Number(c.oldp);
      const newPrice = Number(c.newp);
      if (oldPrice <= 0) continue;
      const pct = (Math.abs(newPrice - oldPrice) / oldPrice) * 100;
      if (pct <= threshold) continue;
      const rounded = Math.round(pct * 100) / 100;
      this.logger.warn(
        `Price variation ${rounded}% on product ${c.id}: ${oldPrice} -> ${newPrice}`,
      );
      if (result.bigVariations.length < MAX_BIG_VARIATIONS) {
        result.bigVariations.push({
          productId: c.id,
          oldPrice,
          newPrice,
          pct: rounded,
        });
      }
    }
  }
}
