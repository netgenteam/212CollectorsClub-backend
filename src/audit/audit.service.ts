import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { isIP } from 'node:net';
import { ApiException } from '../common/api-exception.js';
import {
  LockBudget,
  isLockWaitExpired,
  isTxTimeout,
} from '../common/lock-timeout.js';
import { RequestContext } from '../common/request-context.js';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isAuditAction } from './audit-actions.js';
import type { AuditAction } from './audit-actions.js';
import { assertAuditPayload } from './audit-payload.js';
import type { AuditPayload } from './audit-payload.js';
import {
  AUDIT_ACTOR_TYPES,
  GENESIS_HASH,
  computeAuditHash,
} from './canonical-json.js';
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
 * `record(tx, ev)` REQUIRES the transaction of the audited action: action and
 * event commit or roll back together (fail-closed: nothing here is wrapped in a
 * swallowing try/catch; any failure is rethrown and aborts the action, as an
 * ApiException 503 `AUDIT_UNAVAILABLE` for outages/lock timeouts so it is never a
 * bare 500). The chain-head advisory lock is taken inside and kept until commit,
 * so `record` must be the LAST statement of the transaction (every business row
 * is already locked by then: nobody waits for the chain lock while holding a lock
 * its holder needs, which rules out deadlocks).
 *
 * All SQL is raw and uses UNQUOTED-SCHEMA names, so the e2e can run it against a
 * sandbox schema through `search_path`. Never `upsert` / Prisma writes on the
 * model (a static test enforces it).
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);
  /** ip as given -> ip as Postgres prints it (host(inet)); bounded. */
  private readonly ipCache = new Map<string, string>();

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
    options: { maxWait?: number; timeout?: number } = {},
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
      if (isTxTimeout(err)) {
        this.logger.warn('audit transaction timed out (P2028)');
        throw unavailable('TX_TIMEOUT', err);
      }
      throw err;
    }
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
        { seq: bigint; hash: string; now: Date }[]
      >`SELECT "seq", "hash", date_trunc('milliseconds', clock_timestamp()) AS "now"
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
      const occurredAt = clock; // one instant for every event of the flush

      const out: AuditAppended[] = [];
      for (const p of prepared) {
        seq += 1;
        const hash = computeAuditHash(prevHash, {
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
        });
        const before = p.before === null ? null : JSON.stringify(p.before);
        const after = p.after === null ? null : JSON.stringify(p.after);
        await tx.$queryRaw`INSERT INTO "Audit_Events"
          ("seq","occurredAt","actorType","actorId","action","entityType","entityId",
           "before","after","reason","requestId","ip","hashVersion","prevHash","hash")
          VALUES (${seq}::bigint, ${occurredAt}::timestamptz, ${p.actorType}, ${p.actorId}::uuid,
                  ${p.action}, ${p.entityType}, ${p.entityId},
                  ${before}::jsonb, ${after}::jsonb, ${p.reason}, ${p.requestId}::uuid,
                  ${p.ip}::inet, 1, ${prevHash}, ${hash})
          RETURNING "seq"`;
        out.push({ seq, hash });
        prevHash = hash;
      }
      return out;
    } catch (err) {
      if (err instanceof ApiException) throw err;
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
      if (typeof v !== 'string' || v.length === 0 || v.length > max) {
        throw new AuditEventError(`${what} must be 1..${max} characters`);
      }
      if (v.includes('\u0000')) throw new AuditEventError(`${what} has a NUL`);
      return v;
    };
    const reason =
      ev.reason === undefined || ev.reason === null
        ? null
        : str(ev.reason, 'reason', 500);
    const before = ev.before === undefined ? null : ev.before;
    const after = ev.after === undefined ? null : ev.after;
    assertAuditPayload(before, 'before');
    assertAuditPayload(after, 'after');
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
      // Not an inet: stored as NULL (a spoofed header cannot fail the audited action).
      ip: rawIp !== null && isIP(rawIp) !== 0 ? rawIp : null,
    };
  }

  /**
   * The hash covers the ip exactly as Postgres prints it back (`host(inet)`),
   * which can differ from the textual input (`2001:DB8::1`). Normalized through
   * the database once per distinct value, BEFORE the chain lock is taken.
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
        { ip: string }[]
      >`SELECT host(${p.ip}::inet) AS "ip"`;
      if (this.ipCache.size >= 1000) this.ipCache.clear();
      this.ipCache.set(p.ip, rows[0].ip);
      p.ip = rows[0].ip;
    }
  }
}
