import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditService } from '../audit/audit.service.js';
import { SYSTEM_ACTOR } from '../audit/audit-events.js';

/** One summary per window, at most (the window opens with the first discarded failure). */
export const LOGIN_SUMMARY_WINDOW_MS = 60_000;
/** Distinct hashed identifiers kept in memory per window (a flood of random names cannot grow it). */
const MAX_TRACKED_IDENTIFIERS = 1_000;
/** Hashed identifiers written in the event (the count of ALL of them is `distinctIdentifiers`). */
const MAX_LISTED_IDENTIFIERS = 20;
/** The shutdown flush must never hold the process: it is bounded. */
const SHUTDOWN_FLUSH_MS = 4_000;

interface Window {
  startedAt: Date;
  dropped: number;
  identifiers: Set<string>;
  identifiersTruncated: boolean;
  ips: Set<string>;
}

/**
 * Story 20.5 follow-up (R4): what the `LOGIN_ADMIN_FAILED` budget throws away must not vanish.
 *
 * `AdminLoginLimiter` caps how many `LOGIN_ADMIN_FAILED` rows an attacker can feed into the
 * immutable chain (20/min, 4 in flight). Beyond it the failures used to leave only a warning log and
 * an in-memory counter, which a restart erased. Now each discarded failure is COUNTED here and, once
 * per window (60 s from the first discard), ONE `LOGIN_ADMIN_FAILED_SUMMARY` event is written:
 * how many were discarded, the window, how many distinct
 * identifiers and the (hashed, at most 20) identifiers. Never a typed value, never an IP: only
 * `emailHash` (A103) and a count of distinct IPs.
 *
 * Durable: the summary goes through `AuditService.transaction` like any event (chain lock, hash).
 * Pending counts are flushed when the app closes (`onModuleDestroy`, bounded to 4 s; run before
 * the database connection is closed). If the write fails (audit outage) the counts are put back and
 * retried in the next window, and the error is logged; if the process dies before, they are lost
 * (a crash cannot be helped; the per-failure log line remains).
 */
@Injectable()
export class AdminLoginFailureSummary implements OnModuleDestroy {
  private readonly logger = new Logger(AdminLoginFailureSummary.name);
  private window: Window | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;
  /** Summaries written since boot (observable by tests and logs). */
  summariesWritten = 0;

  constructor(
    private readonly audit: AuditService,
    private readonly config: ConfigService,
  ) {}

  private get windowMs(): number {
    const v = Number(this.config.get<string>('AUDIT_LOGIN_SUMMARY_WINDOW_MS'));
    return Number.isFinite(v) && v >= 100
      ? Math.floor(v)
      : LOGIN_SUMMARY_WINDOW_MS;
  }

  private open(now = new Date()): Window {
    if (!this.window) {
      this.window = {
        startedAt: now,
        dropped: 0,
        identifiers: new Set(),
        identifiersTruncated: false,
        ips: new Set(),
      };
    }
    return this.window;
  }

  private arm(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.windowMs);
    this.timer.unref();
  }

  private track(w: Window, identifierHash: string | null, ip: string | null) {
    if (identifierHash) {
      if (w.identifiers.size < MAX_TRACKED_IDENTIFIERS) {
        w.identifiers.add(identifierHash);
      } else if (!w.identifiers.has(identifierHash)) {
        w.identifiersTruncated = true;
      }
    }
    if (ip && w.ips.size < MAX_TRACKED_IDENTIFIERS) w.ips.add(ip);
  }

  /** A failed login whose `LOGIN_ADMIN_FAILED` was NOT written (budget, in-flight cap or write error). */
  noteDropped(identifierHash: string | null, ip: string | null): void {
    const w = this.open();
    w.dropped += 1;
    this.track(w, identifierHash, ip);
    this.arm();
  }

  /** Pending discarded failures (not yet in the chain). */
  get pending(): number {
    return this.window?.dropped ?? 0;
  }

  /**
   * Writes the summary now (the timer, the shutdown hook and the tests call it). Concurrent calls
   * share one write. No pending failures: nothing is written.
   */
  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    const w = this.window;
    if (!w || w.dropped === 0) return Promise.resolve();
    this.window = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const endedAt = new Date();
    const run = this.write(w, endedAt)
      .catch((err: unknown) => {
        this.logger.error(
          `LOGIN_ADMIN_FAILED_SUMMARY (${w.dropped} discarded failures) could not be written; retrying next window: ${String(err)}`,
        );
        this.putBack(w);
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = run;
    return run;
  }

  /** The summary could not be written: merge it into the current window and try again later. */
  private putBack(w: Window): void {
    const cur = this.open(w.startedAt);
    if (cur !== w) {
      cur.dropped += w.dropped;
      for (const h of w.identifiers) this.track(cur, h, null);
      for (const ip of w.ips) this.track(cur, null, ip);
      cur.identifiersTruncated ||= w.identifiersTruncated;
      if (w.startedAt < cur.startedAt) cur.startedAt = w.startedAt;
    }
    this.arm();
  }

  private async write(w: Window, endedAt: Date): Promise<void> {
    const ids = [...w.identifiers];
    await this.audit.transaction((_tx, audit) => {
      audit.add({
        ...SYSTEM_ACTOR,
        action: 'LOGIN_ADMIN_FAILED_SUMMARY',
        entityType: 'AdminLogin',
        entityId: 'failed-logins',
        after: {
          dropped: w.dropped,
          windowStart: w.startedAt.toISOString(),
          windowEnd: endedAt.toISOString(),
          windowSeconds: Math.max(
            1,
            Math.round((endedAt.getTime() - w.startedAt.getTime()) / 1000),
          ),
          distinctIdentifiers: w.identifiers.size,
          identifiersTruncated: w.identifiersTruncated,
          distinctIps: w.ips.size,
          identifierHashes: ids.slice(0, MAX_LISTED_IDENTIFIERS),
        },
      });
      return Promise.resolve();
    });
    this.summariesWritten += 1;
  }

  /** Closing the app: what is pending goes to the chain if it can be done in a few seconds. */
  async onModuleDestroy(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.window && !this.inFlight) return;
    let stop: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<'timeout'>((r) => {
      stop = setTimeout(() => r('timeout'), SHUTDOWN_FLUSH_MS);
    });
    try {
      const r = await Promise.race([
        (this.inFlight ?? Promise.resolve()).then(() => this.flush()),
        gaveUp,
      ]);
      if (r === 'timeout') {
        this.logger.error(
          `LOGIN_ADMIN_FAILED_SUMMARY: shutdown flush timed out; ${this.pending} discarded failures are not in the chain`,
        );
      }
    } finally {
      clearTimeout(stop);
      // A failed write put the counts back and re-armed the timer: a closing app has no next window.
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
    }
  }
}
