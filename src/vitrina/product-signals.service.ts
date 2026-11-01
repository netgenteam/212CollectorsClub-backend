import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHmac, randomBytes } from 'node:crypto';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Story 18.7 (AD-82): UA patterns that are never counted as a human view. */
export const BOT_UA_REGEX =
  /bot|crawler|spider|headless|curl|wget|preview|monitor/i;

export const VIEW_DEDUP_MAX_ENTRIES = 50_000;
export const STATS_RETENTION_DAYS = 180;
const PURGE_BATCH = 5_000;

/** Resolved per call (`.env` is loaded after module import). */
export const viewDedupWindowSec = (): number => {
  const n = Number(process.env.VIEW_DEDUP_WINDOW_SEC ?? 1800);
  return Number.isFinite(n) && n > 0 ? n : 1800;
};

/** Per-request limit; same shape as `simulatorRateLimit()`. */
export const viewRateLimit = (): number => {
  const n = Number(process.env.VIEW_RATE_LIMIT_PER_MIN ?? 120);
  return Number.isInteger(n) && n > 0 ? n : 120;
};

/** UTC calendar day `YYYY-MM-DD` of `now` (the stats "day" is always UTC). */
export const utcDay = (now: Date): string => now.toISOString().slice(0, 10);

@Injectable()
export class ProductSignalsService {
  private readonly logger = new Logger(ProductSignalsService.name);
  /** Per-process secret; the daily salt derives from it + the UTC date and is never stored. */
  private readonly secret: string =
    process.env.VIEW_DEDUP_SECRET || randomBytes(32).toString('hex');
  /** HMAC key -> expiry (ms epoch). Map keeps insertion order: first key = oldest. */
  private readonly seen = new Map<string, number>();
  private seenDay = '';

  constructor(private readonly prisma: PrismaService) {}

  private dailySalt(day: string): Buffer {
    return createHmac('sha256', this.secret)
      .update(`view-salt:${day}`)
      .digest();
  }

  /**
   * Returns true when this (ip, product) pair was already seen within the
   * window; otherwise remembers it. Synchronous, so concurrent requests
   * cannot both pass. Only an irreversible HMAC is kept, never the IP.
   */
  private isDuplicate(ip: string, productId: string, now: Date): boolean {
    const day = utcDay(now);
    if (day !== this.seenDay) {
      this.seen.clear(); // salt rotated: old keys are unreachable anyway
      this.seenDay = day;
    }
    const key = createHmac('sha256', this.dailySalt(day))
      .update(`${ip}:${productId}`)
      .digest('base64url');
    const nowMs = now.getTime();
    const expiry = this.seen.get(key);
    if (expiry !== undefined && expiry > nowMs) return true;
    this.seen.delete(key); // re-insert at the end (newest)
    while (this.seen.size >= VIEW_DEDUP_MAX_ENTRIES) {
      const oldest = this.seen.keys().next().value as string;
      this.seen.delete(oldest);
    }
    this.seen.set(key, nowMs + viewDedupWindowSec() * 1000);
    return false;
  }

  /** Test helper. */
  get dedupSize(): number {
    return this.seen.size;
  }

  /**
   * Never throws and never reveals whether the product exists. Returns true
   * only when it attempted to count (for tests); callers ignore it.
   */
  async recordView(
    productId: string,
    ip: string,
    ua: string | undefined,
    now: Date = new Date(),
  ): Promise<boolean> {
    if (!ua || !ua.trim() || BOT_UA_REGEX.test(ua)) return false;
    if (this.isDuplicate(ip, productId, now)) return false;
    try {
      await this.prisma.$executeRaw(Prisma.sql`
        INSERT INTO "Product_Daily_Stats" ("productId", "day", "views", "cartAdds")
        SELECT p.id, ${utcDay(now)}::date, 1, 0
        FROM "Products" p
        WHERE p.id = ${productId}::uuid AND p."isActive"
        ON CONFLICT ("productId", "day")
        DO UPDATE SET "views" = "Product_Daily_Stats"."views" + 1
      `);
      return true;
    } catch (err) {
      // No ip/ua in the message: only the error class.
      this.logger.warn(
        `view not recorded (${err instanceof Error ? err.constructor.name : 'error'})`,
      );
      return false;
    }
  }

  /**
   * Counts one cart-add EVENT (not units). Must be the last statement of the
   * `CartService.addItem` transaction so it rolls back with it.
   */
  async recordCartAdd(
    tx: Prisma.TransactionClient,
    productId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await tx.$executeRaw(Prisma.sql`
      INSERT INTO "Product_Daily_Stats" ("productId", "day", "views", "cartAdds")
      SELECT p.id, ${utcDay(now)}::date, 0, 1
      FROM "Products" p
      WHERE p.id = ${productId}::uuid
      ON CONFLICT ("productId", "day")
      DO UPDATE SET "cartAdds" = "Product_Daily_Stats"."cartAdds" + 1
    `);
  }

  /**
   * Deletes rows with `day < today(UTC) - 180` in bounded batches. Idempotent;
   * never touches recent rows. Returns the number of deleted rows.
   */
  async purgeOldStats(
    now: Date = new Date(),
    batchSize: number = PURGE_BATCH,
  ): Promise<number> {
    const cutoff = new Date(`${utcDay(now)}T00:00:00.000Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - STATS_RETENTION_DAYS);
    const cutoffDay = utcDay(cutoff);
    let total = 0;
    for (;;) {
      const n = await this.prisma.$executeRaw(Prisma.sql`
        DELETE FROM "Product_Daily_Stats"
        WHERE ctid IN (
          SELECT ctid FROM "Product_Daily_Stats"
          WHERE "day" < ${cutoffDay}::date
          LIMIT ${batchSize}::int
        )
      `);
      total += n;
      if (n < batchSize) return total;
    }
  }

  @Cron('30 3 * * *', { timeZone: 'UTC' })
  async purgeCron(): Promise<void> {
    if (process.env.VITRINA_CRON_ENABLED === 'false') return;
    try {
      const n = await this.purgeOldStats();
      this.logger.log(`Product_Daily_Stats purge: ${n} row(s) removed`);
    } catch (err) {
      this.logger.error(
        `Product_Daily_Stats purge failed (${err instanceof Error ? err.constructor.name : 'error'})`,
      );
    }
  }
}
