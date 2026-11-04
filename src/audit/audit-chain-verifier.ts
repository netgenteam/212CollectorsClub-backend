import { GENESIS_HASH, computeAuditHash } from './canonical-json.js';

/** "Run this SQL with these params" (Prisma `$queryRawUnsafe` or a pg client); injectable for the e2e. */
export type SqlRunner = (
  sql: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>;

export type VerifyMode = 'incremental' | 'full';

export type BrokenReason =
  | 'HASH_MISMATCH'
  | 'PREV_HASH_MISMATCH'
  | 'SEQ_GAP'
  | 'GENESIS_MISMATCH'
  | 'ANCHOR_CHANGED'
  | 'HASH_VERSION';

export interface BrokenAt {
  seq: number;
  reason: BrokenReason;
  /** A hash (or a seq, for SEQ_GAP) */
  expected: string;
  found: string | null;
}

export interface VerifyResult {
  ok: boolean;
  mode: VerifyMode;
  /** First row examined (1 when the chain is empty). */
  checkedFrom: number;
  /** Last row that was fine (`checkedFrom - 1` when none). */
  checkedTo: number;
  rows: number;
  brokenAt?: BrokenAt;
  /** Resume point when `done` is false. */
  nextFromSeq?: number;
  /** True when no row is left after `checkedTo` (the chain has been read to its end). */
  done: boolean;
  /**
   * True when this run did NOT cover the chain from the genesis to its end: it
   * started after row 1 (`fromSeq`, or an incremental run that trusts the rows
   * before its anchor) or stopped early. A partial OK is not a clean bill of
   * health for the whole chain.
   */
  partial: boolean;
  /** seq/hash of the last good row (the anchor of the next incremental run). */
  lastSeq: number;
  lastHash: string;
}

export interface VerifyOptions {
  mode: VerifyMode;
  /** Resume point (rows before it are trusted: the previous slice checked them). */
  fromSeq?: number;
  /** Maximum rows to examine in this call. */
  limit?: number;
  /** Rows per keyset read (default 5.000). */
  batchSize?: number;
  /** Rows hashed between two yields to the event loop (default 250). */
  sliceRows?: number;
}

export const VERIFY_BATCH_SIZE = 5_000;
export const VERIFY_SLICE_ROWS = 250;
export const VERIFY_DEFAULT_LIMIT = 200_000;

const COLUMNS = `"seq", "occurredAt", "actorType", "actorId", "action", "entityType", "entityId",
  "before", "after", "reason", "requestId", host("ip") AS "ip", "hashVersion", "prevHash", "hash"`;

const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

interface Row {
  seq: number;
  occurredAt: Date;
  actorType: string;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason: string | null;
  requestId: string | null;
  ip: string | null;
  hashVersion: number;
  prevHash: string;
  hash: string;
}

const toRow = (r: Record<string, unknown>): Row => ({
  seq: Number(r.seq),
  occurredAt: r.occurredAt as Date,
  actorType: r.actorType as string,
  actorId: (r.actorId as string | null) ?? null,
  action: r.action as string,
  entityType: r.entityType as string,
  entityId: r.entityId as string,
  before: r.before ?? null,
  after: r.after ?? null,
  reason: (r.reason as string | null) ?? null,
  requestId: (r.requestId as string | null) ?? null,
  ip: (r.ip as string | null) ?? null,
  hashVersion: Number(r.hashVersion),
  prevHash: r.prevHash as string,
  hash: r.hash as string,
});

/**
 * Story 20.1 (AD-99, FR-137): recomputes the hash chain.
 *
 * Reads by keyset (`seq >`), in batches of 5.000, and hashes in slices of 250
 * rows yielding to the event loop between slices: verifying 200.000 rows is
 * CPU work that must never freeze the request threads (Story 19.2 lesson).
 * It never writes; `AuditVerifyService` records the outcome.
 *
 * Window: `full` starts at row 1; `incremental` starts AT the last OK
 * verification's last row (re-hashing it and demanding its hash is still the one
 * recorded, which catches a rewrite of what was already verified), or at 1 when
 * there is none; an explicit `fromSeq` resumes a previous slice (the row before
 * it is the trusted anchor).
 */
export class AuditChainVerifier {
  async verify(db: SqlRunner, opts: VerifyOptions): Promise<VerifyResult> {
    const limit = Math.max(1, opts.limit ?? VERIFY_DEFAULT_LIMIT);
    const batch = Math.max(1, opts.batchSize ?? VERIFY_BATCH_SIZE);
    const slice = Math.max(1, opts.sliceRows ?? VERIFY_SLICE_ROWS);

    let startSeq = 1;
    let prev: string | null = GENESIS_HASH; // expected prevHash of the first row; null = trust its own
    let anchorHash: string | null = null; // the first row must hash to this (incremental)

    if (opts.fromSeq !== undefined && opts.fromSeq > 1) {
      startSeq = opts.fromSeq;
      const a = await db(
        `SELECT "hash" FROM "Audit_Events" WHERE "seq" = $1::bigint`,
        [startSeq - 1],
      );
      if (a.length === 0) {
        return this.broken(opts.mode, startSeq, 0, startSeq - 1, {
          seq: startSeq - 1,
          reason: 'SEQ_GAP',
          expected: String(startSeq - 1),
          found: null,
        });
      }
      prev = a[0].hash as string;
    } else if (opts.fromSeq === undefined && opts.mode === 'incremental') {
      const last = await db(
        `SELECT "toSeq", "headHash" FROM "Audit_Verifications"
          WHERE "result" = 'OK' AND "rows" > 0 ORDER BY "toSeq" DESC, "startedAt" DESC LIMIT 1`,
      );
      if (last.length > 0) {
        startSeq = Number(last[0].toSeq);
        anchorHash = last[0].headHash as string;
        prev = null;
      }
    }

    let expectedSeq = startSeq;
    let rows = 0;
    let lastSeq = startSeq - 1;
    let lastHash = prev ?? GENESIS_HASH;
    let sinceYield = 0;
    let exhausted = false;
    let cursor = startSeq;
    const first = startSeq;

    while (rows < limit) {
      const take = Math.min(batch, limit - rows);
      const page = await db(
        `SELECT ${COLUMNS} FROM "Audit_Events" WHERE "seq" >= $1::bigint ORDER BY "seq" ASC LIMIT $2`,
        [cursor, take],
      );
      if (page.length === 0) {
        if (rows === 0 && anchorHash !== null) {
          // The row that was verified last time is gone (tail deleted).
          return this.broken(opts.mode, first, 0, first - 1, {
            seq: first,
            reason: 'SEQ_GAP',
            expected: String(first),
            found: null,
          });
        }
        exhausted = true;
        break;
      }
      for (const raw of page) {
        const r = toRow(raw);
        const bad = this.check(
          r,
          expectedSeq,
          prev,
          anchorHash && rows === 0 ? anchorHash : null,
        );
        if (bad) {
          return {
            ok: false,
            mode: opts.mode,
            checkedFrom: first,
            checkedTo: lastSeq,
            rows,
            brokenAt: bad,
            done: false,
            partial: first > 1,
            lastSeq,
            lastHash,
          };
        }
        prev = r.hash;
        lastSeq = r.seq;
        lastHash = r.hash;
        expectedSeq = r.seq + 1;
        rows += 1;
        if (++sinceYield >= slice) {
          sinceYield = 0;
          await yieldToEventLoop();
        }
      }
      cursor = expectedSeq;
      if (page.length < take) {
        exhausted = true;
        break;
      }
    }

    let done = exhausted;
    if (!done) {
      // The limit was reached exactly: is there anything after the last row?
      const more = await db(
        `SELECT 1 AS "x" FROM "Audit_Events" WHERE "seq" > $1::bigint LIMIT 1`,
        [lastSeq],
      );
      done = more.length === 0;
    }
    return {
      ok: true,
      mode: opts.mode,
      checkedFrom: first,
      checkedTo: lastSeq,
      rows,
      ...(done ? {} : { nextFromSeq: lastSeq + 1 }),
      done,
      partial: first > 1 || !done,
      lastSeq,
      lastHash,
    };
  }

  private broken(
    mode: VerifyMode,
    from: number,
    rows: number,
    lastSeq: number,
    brokenAt: BrokenAt,
  ): VerifyResult {
    return {
      ok: false,
      mode,
      checkedFrom: from,
      checkedTo: lastSeq,
      rows,
      brokenAt,
      done: false,
      partial: from > 1,
      lastSeq,
      lastHash: GENESIS_HASH,
    };
  }

  private check(
    r: Row,
    expectedSeq: number,
    prev: string | null,
    anchorHash: string | null,
  ): BrokenAt | null {
    if (r.seq !== expectedSeq) {
      return {
        seq: expectedSeq,
        reason: 'SEQ_GAP',
        expected: String(expectedSeq),
        found: String(r.seq),
      };
    }
    if (r.hashVersion !== 1) {
      return {
        seq: r.seq,
        reason: 'HASH_VERSION',
        expected: '1',
        found: String(r.hashVersion),
      };
    }
    const expectedPrev = r.seq === 1 ? GENESIS_HASH : prev;
    if (expectedPrev !== null && r.prevHash !== expectedPrev) {
      return {
        seq: r.seq,
        reason: r.seq === 1 ? 'GENESIS_MISMATCH' : 'PREV_HASH_MISMATCH',
        expected: expectedPrev,
        found: r.prevHash,
      };
    }
    const expected = computeAuditHash(r.prevHash, r);
    if (expected !== r.hash) {
      return {
        seq: r.seq,
        reason: 'HASH_MISMATCH',
        expected,
        found: r.hash,
      };
    }
    if (anchorHash !== null && r.hash !== anchorHash) {
      return {
        seq: r.seq,
        reason: 'ANCHOR_CHANGED',
        expected: anchorHash,
        found: r.hash,
      };
    }
    return null;
  }
}
