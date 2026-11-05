import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { RequestContext } from '../common/request-context.js';
import { redactString } from '../common/redact.js';
import type { UsageLogConfig } from './usage-config.js';
import {
  USAGE_LOG_CONFIG,
  USAGE_LOG_WRITER,
  type UsageLogRow,
  type UsageLogStats,
  type UsageLogWriter,
} from './usage-log.types.js';

/** A write that has not answered by now is a failure (the database itself cuts the statement at 4 s). */
export const WRITE_TIMEOUT_MS = 8_000;
/** The final flush of a closing app gives up after this (AC4). */
export const SHUTDOWN_FLUSH_MS = 2_000;
/** After a failed write the next attempt waits 1 s, 2 s, 4 s ... up to this. */
export const MAX_BACKOFF_MS = 30_000;
/** An erased customer's late rows (a request that finished after the anonymization) are refused for this long. */
export const TOMBSTONE_TTL_MS = 10 * 60_000;
const MAX_TOMBSTONES = 1_000;

/**
 * SQLSTATE of a Prisma/driver error ("Code: `22P02`", `meta.driverAdapterError.cause.code`, `err.code`).
 * 22xxx (data exception) and 23xxx (constraint) will fail the same way every time: that batch is
 * discarded instead of retried forever (a poison batch would otherwise sit at the front of the queue
 * and block every row behind it).
 */
export function sqlStateOf(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const e = err as { code?: unknown; meta?: unknown; cause?: unknown };
  if (typeof e.code === 'string' && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
  let meta = '';
  try {
    meta = JSON.stringify(e.meta ?? '');
  } catch {
    /* unserializable */
  }
  const m =
    /"(?:code|sqlState)":"([0-9A-Z]{5})"/.exec(meta) ??
    /Code: `([0-9A-Z]{5})`/.exec(err.message);
  if (m) return m[1];
  return e.cause !== undefined ? sqlStateOf(e.cause) : null;
}

const isPermanent = (err: unknown): boolean => {
  const c = sqlStateOf(err);
  return c !== null && (c.startsWith('22') || c.startsWith('23'));
};

/** What `lastFlushError` shows an admin: one short line, redacted, never a row. */
function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactString(raw.replace(/\s+/g, ' ').slice(0, 200));
}

/**
 * Story 20.7 (AD-100, FR-134, AC4): the in-memory queue between the middleware and the database.
 *
 *   - `push` is synchronous, does no I/O and never throws: a request is never slowed or broken by it.
 *   - The queue holds at most `bufferMax` rows. When it is full the OLDEST row goes and `droppedTotal`
 *     grows. The rows are small and clamped (route <= 200, user agent <= 200, no body), so the worst case
 *     is about 10 MB at the default 10 000, even when the database is down for hours.
 *   - A flush is one `INSERT` of `flushBatch` rows, ONE at a time (single flight), triggered by the
 *     timer (everything pending) or by the queue reaching `flushBatch` (full batches only, so that a
 *     busy server drains faster than it fills). It holds a pool connection for the length of one short
 *     statement and none between flushes.
 *   - A failed write puts the rows back at the FRONT, waits 1 s, 2 s, 4 s ... (max 30 s) before trying
 *     again, and, if what is queued exceeds the bound, the oldest are discarded. A write that can never
 *     succeed (a data or constraint error) is discarded at once and counted instead of retried.
 *   - Closing the app flushes what is pending, for at most 2 s (`onModuleDestroy`: it must run before
 *     `PrismaService` closes the connection in its own `onModuleDestroy`; `onApplicationShutdown` runs
 *     after it, too late).
 *   - Every callback that runs from a timer or `setImmediate` is wrapped with `RequestContext.detached`:
 *     `AsyncLocalStorage` would otherwise hand the flush the `requestId`/`ip` of whichever request
 *     happened to arm it.
 */
@Injectable()
export class UsageLogBuffer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UsageLogBuffer.name);
  private q: UsageLogRow[] = [];
  private head = 0;
  private droppedTotal = 0;
  private writtenTotal = 0;
  private lastFlushAt: number | null = null;
  private lastFlushError: string | null = null;
  private fails = 0;
  private backoffUntil = 0;
  private inFlight: Promise<void> | null = null;
  /** Rows taken from the queue by the write that is running: not in `size()`, not yet in the table. */
  private inFlightRows = 0;
  private kickScheduled = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly tombstones = new Map<string, number>();

  constructor(
    @Inject(USAGE_LOG_CONFIG) private readonly cfg: UsageLogConfig,
    @Inject(USAGE_LOG_WRITER) private readonly writer: UsageLogWriter,
  ) {}

  onModuleInit(): void {
    this.start();
  }

  /** Arms the timer (idempotent). Separate from `onModuleInit` so a unit test can drive it with fake timers. */
  start(): void {
    if (!this.cfg.enabled || this.timer) return;
    this.timer = setInterval(() => {
      RequestContext.detached(() => {
        void this.flush(true);
      });
    }, this.cfg.flushMs);
    this.timer.unref();
  }

  get enabled(): boolean {
    return this.cfg.enabled;
  }

  size(): number {
    return this.q.length - this.head;
  }

  /** Synchronous, no I/O, never throws. */
  push(row: UsageLogRow): void {
    try {
      if (!this.cfg.enabled) return;
      if (row.actorId !== null && row.actorType === 'CUSTOMER') {
        const until = this.tombstones.get(row.actorId);
        if (until !== undefined) {
          if (until > Date.now()) return; // erased customer: the row is not recorded at all
          this.tombstones.delete(row.actorId);
        }
      }
      this.q.push(row);
      if (this.size() > this.cfg.bufferMax) {
        this.head += 1;
        this.droppedTotal += 1;
        this.compact();
      }
      if (this.size() >= this.cfg.flushBatch) this.kick();
    } catch {
      // Never reaches the request. A row that could not even be queued is a drop.
      this.droppedTotal += 1;
    }
  }

  private compact(): void {
    if (this.head > 1_024 && this.head * 2 > this.q.length) {
      this.q = this.q.slice(this.head);
      this.head = 0;
    }
  }

  private take(n: number): UsageLogRow[] {
    const batch = this.q.slice(this.head, this.head + n);
    this.head += batch.length;
    this.compact();
    if (this.head === this.q.length) {
      this.q = [];
      this.head = 0;
    }
    return batch;
  }

  /** The batch goes back to the FRONT; what no longer fits is the oldest, i.e. the front. */
  private requeue(batch: UsageLogRow[]): void {
    this.q = batch.concat(this.q.slice(this.head));
    this.head = 0;
    const excess = this.q.length - this.cfg.bufferMax;
    if (excess > 0) {
      this.head = excess;
      this.droppedTotal += excess;
      this.compact();
    }
  }

  /** An early flush because a full batch is waiting; never on the request's own stack. */
  private kick(): void {
    if (this.kickScheduled || this.inFlight || Date.now() < this.backoffUntil) {
      return;
    }
    this.kickScheduled = true;
    setImmediate(() => {
      this.kickScheduled = false;
      RequestContext.detached(() => {
        void this.flush(false);
      });
    });
  }

  /**
   * Writes what is pending. `everything`: the timer / shutdown (all of it, down to a partial batch);
   * otherwise only full batches. Single flight: while one flush runs, another call returns that same promise.
   * `force`: ignore the back-off (shutdown).
   */
  flush(everything = true, force = false): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const p = this.run(everything, force).finally(() => {
      if (this.inFlight === p) this.inFlight = null;
    });
    this.inFlight = p;
    return p;
  }

  private async run(everything: boolean, force: boolean): Promise<void> {
    for (;;) {
      const size = this.size();
      if (size === 0) return;
      if (!everything && size < this.cfg.flushBatch) return;
      if (!force && Date.now() < this.backoffUntil) return;
      const batch = this.take(this.cfg.flushBatch);
      if (!(await this.write(batch, force))) return;
    }
  }

  private async write(batch: UsageLogRow[], force: boolean): Promise<boolean> {
    let stop: NodeJS.Timeout | undefined;
    this.inFlightRows = batch.length;
    try {
      const limit = new Promise<never>((_, reject) => {
        stop = setTimeout(
          () => reject(new Error('usage log write timed out')),
          force ? SHUTDOWN_FLUSH_MS : WRITE_TIMEOUT_MS,
        );
      });
      await Promise.race([this.writer.insert(batch), limit]);
      this.writtenTotal += batch.length;
      this.lastFlushAt = Date.now();
      this.lastFlushError = null;
      this.fails = 0;
      this.backoffUntil = 0;
      return true;
    } catch (err) {
      this.lastFlushError = describe(err);
      this.fails += 1;
      this.backoffUntil =
        Date.now() + Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** (this.fails - 1));
      if (isPermanent(err)) {
        this.droppedTotal += batch.length;
        this.logger.warn(
          `usage log: ${batch.length} rows discarded, the database refuses them (${this.lastFlushError})`,
        );
      } else {
        this.requeue(batch);
        if (this.fails === 1 || this.fails % 10 === 0) {
          this.logger.warn(
            `usage log: write failed (${this.fails} in a row), ${this.size()} rows kept in memory, ${this.droppedTotal} discarded since boot: ${this.lastFlushError}`,
          );
        }
      }
      return false;
    } finally {
      this.inFlightRows = 0;
      clearTimeout(stop);
    }
  }

  /**
   * A customer was anonymized (Story 20.6/20.7): their buffered rows are removed, and rows of theirs
   * that finish later are refused for `TOMBSTONE_TTL_MS`. Rows already inside a write that is in
   * flight are handled by the caller (`UsageLogErasure`): it waits for `settle()` and deletes again.
   */
  dropActor(actorId: string): number {
    this.tombstones.set(actorId, Date.now() + TOMBSTONE_TTL_MS);
    if (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = this.tombstones.keys().next().value;
      if (oldest !== undefined) this.tombstones.delete(oldest);
    }
    const live = this.q.slice(this.head);
    const kept = live.filter(
      (r) => !(r.actorType === 'CUSTOMER' && r.actorId === actorId),
    );
    this.q = kept;
    this.head = 0;
    return live.length - kept.length;
  }

  /** Resolves when no write is in flight (or after `timeoutMs`). */
  async settle(timeoutMs: number): Promise<boolean> {
    const cur = this.inFlight;
    if (!cur) return true;
    let stop: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        cur.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((r) => {
          stop = setTimeout(() => r(false), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(stop);
    }
  }

  stats(): UsageLogStats {
    return {
      buffered: this.size(),
      droppedSinceBoot: this.droppedTotal,
      lastFlushAt:
        this.lastFlushAt === null
          ? null
          : new Date(this.lastFlushAt).toISOString(),
      lastFlushError: this.lastFlushError,
      writtenSinceBoot: this.writtenTotal,
    };
  }

  /** Closing the app: what is pending is written if the database answers within `SHUTDOWN_FLUSH_MS`. */
  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.cfg.enabled) return;
    let stop: NodeJS.Timeout | undefined;
    try {
      const gaveUp = new Promise<'timeout'>((r) => {
        stop = setTimeout(() => r('timeout'), SHUTDOWN_FLUSH_MS);
      });
      const done = (async () => {
        // a write already in flight may fail and put its rows back: finish it, then drain the rest
        await this.settle(SHUTDOWN_FLUSH_MS);
        await this.flush(true, true);
      })();
      const r = await Promise.race([done.then(() => 'ok' as const), gaveUp]);
      if (r === 'timeout' || this.size() > 0) {
        this.logger.error(
          `usage log: shutdown flush incomplete, ${this.size() + this.inFlightRows} rows were not written`,
        );
      }
    } catch (err) {
      this.logger.error(`usage log: shutdown flush failed: ${describe(err)}`);
    } finally {
      clearTimeout(stop);
    }
  }
}
