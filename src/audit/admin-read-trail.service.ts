import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from './audit.service.js';

/** The two reads that show an admin the IP of customers. */
export type AdminReadAction = 'USAGE_LOG_QUERIED' | 'AUDIT_EVENTS_QUERIED';

/** One event per admin and action per this long, however many queries the admin makes. */
export const READ_TRAIL_WINDOW_MS = 15 * 60_000;
const MAX_TRACKED = 1_000;

/**
 * Story 20.7 round 2 (FR-135, FR-129): who READ the personal data of the logs.
 *
 * `GET /admin/audit/usage` and `GET /admin/audit/events` show the IP address (and, for the usage log, the
 * user agent and the customer id) of every visitor. The usage query is excluded from `Usage_Logs` itself
 * (a view that logs itself would feed itself), so before this a person could read every customer's IP and
 * leave no trace anywhere. Decision: an event in the immutable chain, NOT a row in `Usage_Logs`:
 *   - `Usage_Logs` is deleted after 7 days and its rows are mutable; a read of personal data is exactly the
 *     thing that must outlive that (the chain already holds the ID document reveals);
 *   - and the chain is where an auditor looks for "who saw what".
 * To keep the chain from growing with every page turn, it is ONE event per admin and action per 15-minute
 * window (an admin paging through the log is one event; coming back an hour later is another), carrying NO
 * data: no filter, no IP, no row count (`after: { window }` only; the actor and the time are the event's own
 * columns, the IP of the admin is the request's). The window is kept in memory (one instance per
 * environment, A101): a restart or a second instance can write one more event, never fewer; it is marked
 * only after the event committed, and concurrent reads share the one write (and its failure).
 *
 * `strict` (the usage log): the event COMMITS before any row is read; if the chain cannot take it the read
 * is refused (503 `AUDIT_UNAVAILABLE`, the same answer as the ID document reveal): no trace, no data.
 * Not strict (the audit events view): a failure is logged as an error and the view still answers, because
 * that view is the tool an admin uses to find out WHY the audit log is failing, and the events it lists are
 * the ones already in the chain.
 */
@Injectable()
export class AdminReadTrailService {
  private readonly logger = new Logger(AdminReadTrailService.name);
  private readonly last = new Map<string, number>();
  /** The write of the current window that is still running, per admin and action. */
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly audit: AuditService) {}

  async note(
    adminId: string,
    action: AdminReadAction,
    opts: { strict: boolean },
  ): Promise<void> {
    const key = `${action}:${adminId}`;
    const prev = this.last.get(key);
    if (prev !== undefined && Date.now() - prev < READ_TRAIL_WINDOW_MS) return;
    // Round 3 (D2): a read that arrives while the first write of the window is still running WAITS for that
    // same promise, so it fails with it (6 parallel reads of a new admin with the chain refusing writes were
    // 503 x2 and 200 x4 with the IPs: the window was marked before the write and the rest left at once). The
    // window is marked only AFTER the event committed; a failure leaves it unmarked, so the next read tries
    // again. Several instances each keep their own window: each writes at least one event per window.
    let write = this.inflight.get(key);
    if (write === undefined) {
      write = this.write(adminId, action).then(
        () => {
          this.inflight.delete(key);
          this.remember(key, Date.now());
        },
        (err: unknown) => {
          this.inflight.delete(key);
          this.last.delete(key);
          if (!opts.strict) {
            this.logger.error(
              `${action} by admin ${adminId} could not be audited (the view answered anyway): ${err instanceof Error ? err.message : String(err)}`,
            );
          }
          throw err;
        },
      );
      this.inflight.set(key, write);
    }
    try {
      await write;
    } catch (err) {
      if (opts.strict) throw err;
    }
  }

  private write(adminId: string, action: AdminReadAction): Promise<void> {
    return this.audit.transaction((_tx, audit) => {
      audit.add({
        actorType: 'ADMIN',
        actorId: adminId,
        action,
        entityType: action === 'USAGE_LOG_QUERIED' ? 'UsageLog' : 'AuditLog',
        entityId: action === 'USAGE_LOG_QUERIED' ? 'usage-log' : 'audit-log',
        after: { windowMinutes: READ_TRAIL_WINDOW_MS / 60_000 },
      });
      return Promise.resolve();
    });
  }

  private remember(key: string, at: number): void {
    if (this.last.size >= MAX_TRACKED) {
      const first = this.last.keys().next().value;
      if (first !== undefined) this.last.delete(first);
    }
    this.last.set(key, at);
  }
}
