import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import {
  LockBudget,
  isLockWaitExpired,
  isTxTimeout,
} from '../common/lock-timeout.js';
import { RequestContext } from '../common/request-context.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isAuditAction, publicFieldsOf } from './audit-actions.js';
import type { AuditAction } from './audit-actions.js';
import {
  codePointLength,
  cleanIp,
  pgText,
  truncateCodePoints,
} from './audit-normalize.js';
import {
  auditPayloadMode,
  redactReason,
  sanitizeAuditPayload,
} from './audit-payload.js';
import type { AuditPayload } from './audit-payload.js';
import {
  AUDIT_ACTOR_TYPES,
  GENESIS_HASH,
  canonicalJSON,
  computeAuditHash,
} from './canonical-json.js';
import type { AuditHashContent } from './canonical-json.js';
import type { AuditActorType } from './canonical-json.js';

/** Advisory lock of the chain head (AD-99): held until the end of the audited action's transaction. */
export const AUDIT_CHAIN_LOCK_KEY = 2120001;
/** Bounded wait for the chain-head lock (database-side `lock_timeout`/`statement_timeout`). */
export const AUDIT_LOCK_BUDGET_MS = 5_000;
export const AUDIT_ERROR_CODE = 'AUDIT_UNAVAILABLE';

type Tx = Prisma.TransactionClient;

export interface AuditEventInput {
  actorType: AuditActorType;
  actorId?: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  before?: AuditPayload | null;
  after?: AuditPayload | null;
  reason?: string | null;
  /** Default: the request's id (RequestContext). */
  requestId?: string | null;
  /** Default: the request's `req.ip` (RequestContext). */
  ip?: string | null;
}

export interface AuditAppended {
  seq: number;
  hash: string;
}

/** Collector handed to `AuditService.transaction`: events are flushed under ONE lock at the end. */
export interface AuditCollector {
  add(ev: AuditEventInput): void;
}

/** Serialized size cap of `before` / `after` (an audit event is a diff, not a document). */
const MAX_PAYLOAD_CHARS = 256 * 1024;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Prepared {
  actorType: AuditActorType;
  actorId: string | null;
  action: AuditAction;
  entityType: string;
  entityId: string;
  before: AuditPayload | null;
  after: AuditPayload | null;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
}

/** Raised for a malformed event (a programming error: it is a 500 on purpose, not an outage). */
export class AuditEventError extends Error {
  constructor(message: string) {
    super(`Invalid audit event: ${message}`);
    this.name = 'AuditEventError';
  }
}

/** The stored row does not hash to what was written: a bug (500), caught before commit. */
export class AuditRoundTripError extends Error {
  constructor(seq: number, columns: string[]) {
    super(
      `Audit row ${seq} does not round-trip through the database (${columns.join(', ') || 'hash'}); the action was aborted`,
    );
    this.name = 'AuditRoundTripError';
  }
}

const unavailable = (reason: string, cause?: unknown): ApiException => {
  void cause;
  return new ApiException(
    HttpStatus.SERVICE_UNAVAILABLE,
    AUDIT_ERROR_CODE,
    'The audit log is unavailable; the action was not performed. Retry in a few seconds.',
    { reason },
  );
};

/**
 * Story 20.1 (AD-99, FR-138): the ONLY writer of `Audit_Events`.
 *
 * ## USING IT SAFELY (read before calling it from a service)
 *
 * The chain-head advisory lock is taken by the first statement of a flush and is
 * held until the audited transaction COMMITS: every other audited action in the
 * system queues behind it. So the audit write must be the very LAST thing the
 * transaction does:
 *   - PREFER `AuditService.transaction(fn)`: `audit.add(ev)` only collects, and
 *     the flush (lock + INSERT) happens after `fn` returned, right before the
 *     commit. Slow work inside `fn` can never hold the lock. This is the form
 *     the emitters of Stories 20.4-20.8 should use.
 *   - `record(tx, ev)` (for code that already owns a `prisma.$transaction`) takes
 *     the lock at once. After it NOTHING slow may run before the commit: no
 *     Stripe/HTTP/mail/file call, no `sleep`, no heavy query, no other `await` than
 *     the commit itself. Prisma has no pre-commit hook, so the lock cannot be
 *     deferred for a transaction this service does not open; the rule is enforced
 *     by `findRecordMisuse` (`test/helpers/find-record-misuse.ts`, run by `audit-static.spec.ts`), a static test (TypeScript AST) that fails on
 *     any `await` after a `record(...)` in the same callback.
 *   Measured why (8 audited actions/s, a 300 ms call after `record`): p50 7.5 s and
 *   503s; a Stripe call there would stall the whole site. Do the external work
 *   FIRST (before opening the transaction), then write and audit in one short tx.
 *
 * `record(tx, ev)` REQUIRES the transaction of the audited action: action and
 * event commit or roll back together (fail-closed: nothing here is wrapped in a
 * swallowing try/catch; any failure is rethrown and aborts the action, as an
 * ApiException 503 `AUDIT_UNAVAILABLE` for outages/lock timeouts so it is never a
 * bare 500). Every business row is already locked by the time the chain lock is
 * taken (last statement), so nobody waits for the chain lock while holding a lock
 * its holder needs, which rules out deadlocks.
 *
 * ## What is hashed is what is stored
 *
 * Every string (columns, `reason`, `before`/`after` values and keys) is
 * normalized as Postgres will keep it BEFORE hashing and inserting (lone
 * surrogates and NUL become U+FFFD, `audit-normalize.ts`), the ip goes through
 * `audit_normalize_ip` (never throws), `reason` is cut to 500 CODE POINTS (never
 * through a surrogate pair), and the INSERT returns the stored row, whose hash is
 * recomputed with the verifier's own code: a mismatch aborts the action at once
 * (`AuditRoundTripError`, 500, logged) instead of leaving a chain that can never
 * verify. `occurredAt` never goes below the previous row (the database also
 * enforces monotonicity and a margin against `now()`).
 *
 * All SQL is raw and uses UNQUOTED-SCHEMA names, so the e2e can run it against a
 * sandbox schema through `search_path`. Never `upsert` / Prisma writes on the
 * model (a static test enforces it).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  /** ip as given -> ip as Postgres prints it (host(inet)) or null; bounded. */
  private readonly ipCache = new Map<string, string | null>();

  constructor(private readonly prisma: PrismaService) {}

  /** Appends one event inside the transaction of the audited action (call it LAST). */
  async record(tx: Tx, ev: AuditEventInput): Promise<AuditAppended> {
    const [appended] = await this.flush(tx, [ev]);
    return appended;
  }

  /**
   * Opens the transaction of the action, hands the collector and flushes every
   * collected event at the end under a single chain-head lock.
   */
  async transaction<T>(
    fn: (tx: Tx, audit: AuditCollector) => Promise<T>,
    options: {
      maxWait?: number;
      timeout?: number;
      /**
       * An expired Prisma transaction (P2028) is a 503 `AUDIT_UNAVAILABLE` by default. A caller
       * with its own "busy" answer (409 `*_BUSY` for FX, vitrina, legal: bounded lock waits)
       * passes `'rethrow'` to receive the original error and map it itself.
       */
      onTimeout?: 'unavailable' | 'rethrow';
    } = {},
  ): Promise<T> {
    try {
      return await this.prisma.$transaction(
        async (tx) => {
          const events: AuditEventInput[] = [];
          const result = await fn(tx, {
            add: (ev) => {
              events.push(ev);
            },
          });
          await this.flush(tx, events);
          return result;
        },
        {
          maxWait: options.maxWait ?? 10_000,
          timeout: options.timeout ?? 30_000,
        },
      );
    } catch (err) {
      // Prisma reports an expired interactive transaction (the action itself
      // plus the lock wait ran too long) as P2028.
      if (isTxTimeout(err) && options.onTimeout !== 'rethrow') {
        this.logger.warn('audit transaction timed out (P2028)');
        throw unavailable('TX_TIMEOUT', err);
      }
      throw err;
    }
  }

  /**
   * `DATA_EXPORTED` (FR-139) for ANY admin export of data (CSV, report, dump): the helper every
   * future export calls BEFORE it hands the file to the admin, so "no event, no delivery"
   * (same discipline as the ID document reveal). It is an audit transaction of its own that
   * commits first; the (possibly slow) export work must run before or after it, never inside.
   * Today no admin export exists (20.5 found none), so nothing calls it yet. Describe the
   * export, never its content: `dataset` (what), `format`, `rows`, optional scalar `filters`.
   */
  async recordDataExport(
    admin: { id: string },
    info: {
      dataset: string;
      format: string;
      rows: number;
      filters?: Record<string, string | number | boolean | null>;
    },
  ): Promise<void> {
    await this.transaction((_tx, audit) => {
      audit.add({
        actorType: 'ADMIN',
        actorId: admin.id,
        action: 'DATA_EXPORTED',
        entityType: 'Export',
        entityId: info.dataset,
        after: {
          dataset: info.dataset,
          format: info.format,
          rows: info.rows,
          filters: info.filters ?? {},
        },
      });
      return Promise.resolve();
    });
  }

  private async flush(
    tx: Tx,
    events: AuditEventInput[],
  ): Promise<AuditAppended[]> {
    if (events.length === 0) return [];
    const prepared = events.map((e) => this.prepare(e));
    try {
      await this.normalizeIps(tx, prepared);

      // The lock wait is bounded IN THE DATABASE (lock_timeout + statement_timeout
      // from one shared deadline, src/common/lock-timeout.ts).
      const budget = new LockBudget(tx, AUDIT_LOCK_BUDGET_MS);
      await budget.arm();
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY}::bigint)`;
      await budget.release();

      const head = await tx.$queryRaw<
        { seq: bigint; hash: string; last: Date; now: Date }[]
      >`SELECT "seq", "hash", "occurredAt" AS "last",
               date_trunc('milliseconds', clock_timestamp()) AS "now"
          FROM "Audit_Events" ORDER BY "seq" DESC LIMIT 1`;
      let seq = head.length > 0 ? Number(head[0].seq) : 0;
      let prevHash = head.length > 0 ? head[0].hash : GENESIS_HASH;
      // Time source: the database clock (one clock for every instance).
      const clock =
        head.length > 0
          ? head[0].now
          : (
              await tx.$queryRaw<
                { now: Date }[]
              >`SELECT date_trunc('milliseconds', clock_timestamp()) AS "now"`
            )[0].now;
      // One instant for every event of the flush; never before the previous row
      // (a clock that stepped back must not make the trigger reject honest events).
      const occurredAt =
        head.length > 0 && head[0].last > clock ? head[0].last : clock;

      const out: AuditAppended[] = [];
      for (const p of prepared) {
        seq += 1;
        const content: AuditHashContent = {
          seq,
          occurredAt,
          actorType: p.actorType,
          actorId: p.actorId,
          action: p.action,
          entityType: p.entityType,
          entityId: p.entityId,
          before: p.before,
          after: p.after,
          reason: p.reason,
          requestId: p.requestId,
          ip: p.ip,
        };
        const hash = computeAuditHash(prevHash, content);
        const before = p.before === null ? null : JSON.stringify(p.before);
        const after = p.after === null ? null : JSON.stringify(p.after);
        const stored = await tx.$queryRaw<
          Record<string, unknown>[]
        >`INSERT INTO "Audit_Events"
          ("seq","occurredAt","actorType","actorId","action","entityType","entityId",
           "before","after","reason","requestId","ip","hashVersion","prevHash","hash")
          VALUES (${seq}::bigint, ${occurredAt}::timestamptz, ${p.actorType}, ${p.actorId}::uuid,
                  ${p.action}, ${p.entityType}, ${p.entityId},
                  ${before}::jsonb, ${after}::jsonb, ${p.reason}, ${p.requestId}::uuid,
                  ${p.ip}::inet, 1, ${prevHash}, ${hash})
          RETURNING "seq","occurredAt","actorType","actorId"::text AS "actorId","action","entityType",
                    "entityId","before","after","reason","requestId"::text AS "requestId",
                    host("ip") AS "ip"`;
        this.assertRoundTrip(seq, prevHash, hash, content, stored[0]);
        out.push({ seq, hash });
        prevHash = hash;
      }
      return out;
    } catch (err) {
      if (err instanceof ApiException || err instanceof AuditRoundTripError) {
        if (err instanceof AuditRoundTripError) this.logger.error(err.message);
        throw err;
      }
      const lock = isLockWaitExpired(err);
      this.logger.error(
        `audit write failed (${lock ? 'lock wait expired' : 'database error'}): ${String(err)}`,
      );
      throw unavailable(lock ? 'LOCK_TIMEOUT' : 'WRITE_FAILED', err);
    }
  }

  /** Validates and normalizes an event (sync, before any SQL). */
  private prepare(ev: AuditEventInput): Prepared {
    if (!isAuditAction(ev.action)) {
      throw new AuditEventError(`unknown action "${String(ev.action)}"`);
    }
    if (!AUDIT_ACTOR_TYPES.includes(ev.actorType)) {
      throw new AuditEventError(`unknown actorType "${String(ev.actorType)}"`);
    }
    const ctx = RequestContext.get();
    const uuid = (
      v: string | null | undefined,
      what: string,
    ): string | null => {
      if (v === undefined || v === null) return null;
      if (!UUID_RE.test(v)) throw new AuditEventError(`${what} is not a uuid`);
      return v.toLowerCase();
    };
    const str = (v: string, what: string, max: number): string => {
      if (typeof v !== 'string' || v.length === 0) {
        throw new AuditEventError(`${what} must be 1..${max} characters`);
      }
      const clean = pgText(v);
      // varchar(n) counts code points, not UTF-16 units.
      if (codePointLength(clean) > max) {
        throw new AuditEventError(`${what} must be 1..${max} characters`);
      }
      return clean;
    };
    const mode = auditPayloadMode();
    const payload = (
      v: AuditPayload | null | undefined,
      what: string,
    ): AuditPayload | null => {
      if (v === undefined || v === null) return null;
      const { value, issues } = sanitizeAuditPayload(
        v,
        mode,
        `$${what}`,
        publicFieldsOf(ev.action),
      );
      if (value !== null && JSON.stringify(value).length > MAX_PAYLOAD_CHARS) {
        throw new AuditEventError(
          `${what} is larger than ${MAX_PAYLOAD_CHARS} characters`,
        );
      }
      this.logIssues(ev.action, what, issues);
      return value;
    };
    // Free text typed by a person: masked (never rejected), cut to the column.
    let reason: string | null = null;
    if (ev.reason !== undefined && ev.reason !== null) {
      if (typeof ev.reason !== 'string') {
        throw new AuditEventError('reason must be a string');
      }
      const r = redactReason(truncateCodePoints(ev.reason, 2_000));
      this.logIssues(
        ev.action,
        'reason',
        r.hits.length > 0
          ? [
              {
                path: 'reason',
                why: `masked ${[...new Set(r.hits)].join('/')}`,
              },
            ]
          : [],
      );
      const cut = truncateCodePoints(r.text, 500);
      reason = cut.length > 0 ? cut : null;
    }
    const before = payload(ev.before, 'before');
    const after = payload(ev.after, 'after');
    const rawIp = ev.ip === undefined ? (ctx?.ip ?? null) : ev.ip;
    return {
      actorType: ev.actorType,
      actorId: uuid(ev.actorId, 'actorId'),
      action: ev.action,
      entityType: str(ev.entityType, 'entityType', 64),
      entityId: str(ev.entityId, 'entityId', 128),
      before,
      after,
      reason,
      requestId: uuid(
        ev.requestId === undefined ? ctx?.requestId : ev.requestId,
        'requestId',
      ),
      // Not an address Postgres accepts (zone id, garbage): stored as NULL, a
      // spoofed header can never fail the audited action.
      ip: cleanIp(rawIp),
    };
  }

  private logIssues(
    action: string,
    what: string,
    issues: { path: string; why: string }[],
  ): void {
    if (issues.length === 0) return;
    this.logger.warn(
      `audit ${action} ${what} sanitized (${issues.length}): ` +
        issues
          .slice(0, 10)
          .map((i) => `${i.path}: ${i.why}`)
          .join('; '),
    );
  }

  /** The row Postgres kept must hash to what was written, with the verifier's own code. */
  private assertRoundTrip(
    seq: number,
    prevHash: string,
    hash: string,
    sent: AuditHashContent,
    row: Record<string, unknown> | undefined,
  ): void {
    if (!row) throw new AuditRoundTripError(seq, ['no row returned']);
    const back: AuditHashContent = {
      seq: Number(row.seq),
      occurredAt: row.occurredAt as Date,
      actorType: row.actorType as string,
      actorId: (row.actorId as string | null) ?? null,
      action: row.action as string,
      entityType: row.entityType as string,
      entityId: row.entityId as string,
      before: row.before ?? null,
      after: row.after ?? null,
      reason: (row.reason as string | null) ?? null,
      requestId: (row.requestId as string | null) ?? null,
      ip: (row.ip as string | null) ?? null,
    };
    if (computeAuditHash(prevHash, back) === hash) return;
    const columns = (Object.keys(sent) as (keyof AuditHashContent)[]).filter(
      (k) =>
        canonicalJSON({ v: sent[k] ?? null }) !==
        canonicalJSON({ v: back[k] ?? null }),
    );
    throw new AuditRoundTripError(seq, columns);
  }

  /**
   * The hash covers the ip exactly as Postgres prints it back (`host(inet)`),
   * which can differ from the textual input (`2001:DB8::1`). Normalized through
   * the database once per distinct value, BEFORE the chain lock is taken, with
   * `audit_normalize_ip`, which returns NULL instead of raising: a failed cast
   * would abort the whole audited transaction.
   */
  private async normalizeIps(tx: Tx, prepared: Prepared[]): Promise<void> {
    for (const p of prepared) {
      if (p.ip === null) continue;
      const cached = this.ipCache.get(p.ip);
      if (cached !== undefined) {
        p.ip = cached;
        continue;
      }
      const rows = await tx.$queryRaw<
        { ip: string | null }[]
      >`SELECT "audit_normalize_ip"(${p.ip}) AS "ip"`;
      const ip = rows[0]?.ip ?? null;
      if (this.ipCache.size >= 1000) this.ipCache.clear();
      this.ipCache.set(p.ip, ip);
      p.ip = ip;
    }
  }
}
