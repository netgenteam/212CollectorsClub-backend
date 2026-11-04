import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import type { AuditPayload } from '../audit/audit-payload.js';
import { IdDocCryptoService } from '../crypto/id-doc-crypto.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ALL_SETS,
  BACKFILL_SETS,
  ENC_SHAPE_SQL,
  NOT_BLANK_SQL,
  SCRUB_SETS,
  type IdDocColumnSet,
} from './iddoc-columns.js';

const NIL_UUID = '00000000-0000-0000-0000-000000000000';
/** A lost race on a row, a lock wait or a transient failure is retried this many times per batch. */
const BATCH_ATTEMPTS = 3;
/** A batch never waits longer than this for a row lock held by a checkout/admin write. */
const BATCH_LOCK_TIMEOUT_MS = 3_000;
const SAMPLE_IDS = 20;

export type MigrationMode =
  'backfill' | 'verify' | 'scrub' | 'reencrypt' | 'check' | 'report';

export interface RunOptions {
  /** Rows per batch (default 500, 1..5000). */
  batchSize?: number;
  /** Pause between batches so live traffic keeps its share of the connection pool (default 25 ms). */
  pauseMs?: number;
  /** Test hook: called after every committed batch. Throw to simulate a cut. */
  onBatch?: (info: { set: string; batch: number }) => void | Promise<void>;
}

export interface Counters {
  scanned: number;
  encrypted: number;
  skipped: number;
  unparsed: number;
  blank: number;
  errors: number;
}
const zero = (): Counters => ({
  scanned: 0,
  encrypted: 0,
  skipped: 0,
  unparsed: 0,
  blank: 0,
  errors: 0,
});

export interface RunMetrics extends Counters {
  mode: MigrationMode;
  /** `ok`, or a short code (never a value): `KEY_PREFLIGHT_FAILED`, `BATCH_FAILED`, `VERIFY_FAILED`, `PENDING_LEFT` ... */
  outcome: string;
  durationMs: number;
  maxEventLoopDelayMs: number;
  batches: number;
  passes: number;
  activeKeyVersion: number;
  bySet: Record<string, Partial<Counters>>;
  [k: string]: unknown;
}

export interface VerifyResult {
  ok: boolean;
  verified: number;
  /** Plain value present, no ciphertext yet. */
  pending: number;
  undecryptable: number;
  plainMismatch: number;
  blindMismatch: number;
  sampleIds: string[];
}

export interface CheckResult {
  ok: boolean;
  /** Plain (non blank) value without a ciphertext, per set. */
  pending: Record<string, number>;
  /** A stored ciphertext column that does not have the shape of one, per set. */
  malformed: Record<string, number>;
}

export class IdDocMigrationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'IdDocMigrationError';
  }
}

type Tx = Prisma.TransactionClient;
const ident = (s: string): Prisma.Sql => Prisma.raw(`"${s}"`);
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Story 20.3 (AD-96, FR-128): backfill, verify, check, scrub (addresses only), reencrypt and report
 * of the encrypted ID document columns. Used by the `pnpm iddoc:*` CLIs.
 *
 * Properties (each one has a test):
 *  - BATCHED and KEYSET: `WHERE id > cursor ORDER BY id LIMIT n`; one short transaction per batch,
 *    row locks only (no table lock), `lock_timeout` 3 s so a checkout is never queued behind it.
 *  - IDEMPOTENT and RESUMABLE: every write is guarded (`Enc IS NULL AND plain IS NOT DISTINCT FROM
 *    <value read>`), so a second run encrypts 0 rows, a run cut half-way continues where the data
 *    says, and a row the app (or a rolled-back old build) changed in between is never overwritten.
 *  - RACE-SAFE with new writes: new rows are written encrypted only (plain NULL), so they never
 *    enter the scan; a row an old build inserts behind the cursor is caught by the next pass.
 *  - FAIL BEFORE WRITING: a key problem (a version stored in the database that this process
 *    cannot decrypt, or a wrong key/blind key) aborts before any write (`preflight`).
 *  - NO PLAINTEXT OUT: values never reach logs/metrics (counters and row ids only); decryption
 *    lives in `src/crypto` (`checkStored`, `reencryptChecked`).
 *  - NOTHING IRREVERSIBLE on orders: the only statement that nulls a plain column is `scrub`, which
 *    accepts `SCRUB_SETS` (the address book) and re-verifies each row under a row lock first.
 */
@Injectable()
export class IdDocMigrationService {
  private readonly logger = new Logger(IdDocMigrationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: IdDocCryptoService,
    private readonly audit: AuditService,
  ) {}

  // --- helpers ---------------------------------------------------------------

  private opts(
    o: RunOptions,
  ): Required<Pick<RunOptions, 'batchSize' | 'pauseMs'>> &
    Pick<RunOptions, 'onBatch'> {
    const batchSize = Math.min(
      5000,
      Math.max(1, Math.floor(o.batchSize ?? 500)),
    );
    const pauseMs = Math.max(0, Math.floor(o.pauseMs ?? 25));
    return { batchSize, pauseMs, onBatch: o.onBatch };
  }

  private async inBatchTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    let last: unknown;
    for (let attempt = 1; attempt <= BATCH_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.$transaction(
          async (tx) => {
            await tx.$executeRaw`SELECT set_config('lock_timeout', ${`${BATCH_LOCK_TIMEOUT_MS}ms`}, true)`;
            return fn(tx);
          },
          { maxWait: 10_000, timeout: 30_000 },
        );
      } catch (err) {
        last = err;
        // Value-free: the class of the failure only (a driver message can echo a row).
        this.logger.warn(
          `batch attempt ${attempt}/${BATCH_ATTEMPTS} failed (${err instanceof Error ? err.name : 'error'})`,
        );
        if (attempt < BATCH_ATTEMPTS) await sleep(200 * attempt);
      }
    }
    throw new IdDocMigrationError(
      'BATCH_FAILED',
      `a batch failed ${BATCH_ATTEMPTS} times (${last instanceof Error ? last.name : 'error'}); the run can be resumed`,
    );
  }

  // --- preflight: key problems are found before anything is written ------------

  /**
   * Every key version stored in the database must be known to this process AND really decrypt
   * (a wrong key under a known version shows as an authentication failure); the blind key must
   * reproduce a stored blind index. Writes nothing. Throws `KEY_PREFLIGHT_FAILED` (versions only).
   */
  async preflightKeys(
    sets: readonly IdDocColumnSet[] = ALL_SETS,
  ): Promise<void> {
    const known = new Set(this.crypto.knownVersions());
    // The active key itself must round-trip (a broken key shows here, with an empty table too).
    if (
      this.crypto.checkStored(this.crypto.encrypt('V-00000000'), {
        expectedPlain: 'V-00000000',
        blind: this.crypto.blindIndex('V', '00000000'),
      }) !== 'ok'
    ) {
      throw new IdDocMigrationError(
        'KEY_PREFLIGHT_FAILED',
        'the active key does not round-trip',
      );
    }
    const problems: string[] = [];
    for (const set of sets) {
      const versions = await this.prisma.$queryRaw<{ v: string | null }[]>(
        Prisma.sql`SELECT DISTINCT substring(${ident(set.enc)} from '^v([0-9]+):') AS v
                     FROM ${ident(set.table)} WHERE ${ident(set.enc)} IS NOT NULL`,
      );
      for (const { v } of versions) {
        if (v === null) {
          problems.push(`${set.label}: a stored value is not a ciphertext`);
          continue;
        }
        const n = Number(v);
        if (!known.has(n)) {
          problems.push(
            `${set.label}: key version ${n} is stored in the database but is NOT in IDDOC_ENC_KEYS`,
          );
          continue;
        }
        const probe = await this.prisma.$queryRaw<
          { enc: string; blind: string | null }[]
        >(
          Prisma.sql`SELECT ${ident(set.enc)} AS enc, ${ident(set.blind)} AS blind
                       FROM ${ident(set.table)}
                      WHERE substring(${ident(set.enc)} from '^v([0-9]+):') = ${v}
                      ORDER BY (${ident(set.blind)} IS NULL), id LIMIT 5`,
        );
        if (probe.length === 0) continue;
        // A wrong key makes EVERY sampled value fail; one tampered row among healthy ones does
        // not (that is `verify`'s job to report, not a reason to refuse to run).
        const res = probe.map((r) =>
          this.crypto.checkStored(r.enc, { blind: r.blind }),
        );
        if (res.every((r) => r === 'undecryptable')) {
          problems.push(
            `${set.label}: key version ${n} is present but cannot read the stored data (wrong key?)`,
          );
        } else if (res.every((r) => r === 'blind_mismatch')) {
          problems.push(
            `${set.label}: IDDOC_BLIND_KEY does not reproduce the stored blind index (wrong blind key?)`,
          );
        }
      }
    }
    if (problems.length > 0) {
      throw new IdDocMigrationError(
        'KEY_PREFLIGHT_FAILED',
        `nothing was written. ${problems.join('; ')}`,
      );
    }
  }

  // --- backfill --------------------------------------------------------------

  /** Encrypts every plain cedula without a ciphertext. Idempotent, resumable, safe against concurrent writes. */
  async backfill(options: RunOptions = {}): Promise<RunMetrics> {
    const o = this.opts(options);
    return this.timed('backfill', async (m) => {
      await this.preflightKeys();
      // A pass can miss a row an old build inserted behind the cursor: look again until a pass
      // finds nothing to do (3 passes at most; a persistent remainder is reported by --check).
      for (let pass = 1; pass <= 3; pass++) {
        m.passes = pass;
        const before = m.encrypted;
        for (const set of BACKFILL_SETS) await this.backfillSet(set, o, m);
        if (m.encrypted === before) break; // nothing was written: nothing can have been missed
      }
      const left = await this.check();
      if (!left.ok) m.outcome = 'PENDING_LEFT';
    });
  }

  private async backfillSet(
    set: IdDocColumnSet,
    o: ReturnType<IdDocMigrationService['opts']>,
    m: RunMetrics,
  ): Promise<void> {
    const plain = set.plain as string;
    const by = (m.bySet[set.label] ??= zero());
    let cursor = NIL_UUID;
    for (;;) {
      const rows = await this.prisma.$queryRaw<{ id: string; plain: string }[]>(
        Prisma.sql`SELECT id::text AS id, ${ident(plain)} AS plain
                     FROM ${ident(set.table)}
                    WHERE id > ${cursor}::uuid AND ${ident(plain)} IS NOT NULL AND ${ident(set.enc)} IS NULL
                    ORDER BY id LIMIT ${o.batchSize}`,
      );
      if (rows.length === 0) return;
      cursor = rows[rows.length - 1].id;
      m.scanned += rows.length;
      by.scanned = (by.scanned ?? 0) + rows.length;

      const prepared = await this.crypto.protectMany(rows.map((r) => r.plain));
      const ids: string[] = [];
      const plains: string[] = [];
      const encs: string[] = [];
      const blinds: Array<string | null> = [];
      const unparsedIds = new Set<string>();
      for (const [i, row] of rows.entries()) {
        const p = prepared[i];
        if (this.crypto.isEncrypted(row.plain)) {
          // A ciphertext found in the plain column: not ours to rewrite (does not fit VarChar(12) anyway).
          m.skipped++;
          by.skipped = (by.skipped ?? 0) + 1;
          continue;
        }
        if (p === null) {
          m.blank++;
          by.blank = (by.blank ?? 0) + 1;
          continue;
        }
        // Proof in memory before the write: the ciphertext holds the normalized value and the blind is right.
        if (
          this.crypto.checkStored(p.enc, {
            expectedPlain: row.plain,
            blind: p.blind,
          }) !== 'ok'
        ) {
          m.errors++;
          by.errors = (by.errors ?? 0) + 1;
          continue;
        }
        ids.push(row.id);
        plains.push(row.plain);
        encs.push(p.enc);
        blinds.push(p.blind);
        if (p.unparsed) unparsedIds.add(row.id);
      }

      if (ids.length > 0) {
        const written = await this.inBatchTx((tx) =>
          tx.$queryRaw<{ id: string }[]>(
            Prisma.sql`UPDATE ${ident(set.table)} AS t
                          SET ${ident(set.enc)} = v.enc, ${ident(set.blind)} = v.blind
                         FROM unnest(${ids}::uuid[], ${plains}::text[], ${encs}::text[], ${blinds}::text[])
                              AS v(id, plain, enc, blind)
                        WHERE t.id = v.id
                          AND t.${ident(set.enc)} IS NULL
                          AND t.${ident(plain)} IS NOT DISTINCT FROM v.plain
                    RETURNING t.id::text AS id`,
          ),
        );
        const writtenIds = new Set(written.map((w) => w.id));
        const unp = [...writtenIds].filter((id) => unparsedIds.has(id)).length;
        m.encrypted += writtenIds.size;
        m.unparsed += unp;
        // Lost race (the app wrote the ciphertext first, or the plain value changed): left as is.
        m.skipped += ids.length - writtenIds.size;
        by.encrypted = (by.encrypted ?? 0) + writtenIds.size;
        by.unparsed = (by.unparsed ?? 0) + unp;
        by.skipped = (by.skipped ?? 0) + (ids.length - writtenIds.size);
      }
      m.batches++;
      await o.onBatch?.({ set: set.label, batch: m.batches });
      if (rows.length < o.batchSize) return;
      if (o.pauseMs > 0) await sleep(o.pauseMs);
    }
  }

  // --- verify ------------------------------------------------------------------

  /**
   * Decrypts EVERY ciphertext (not a sample) and compares it with the normalized plain value when
   * there still is one, and its blind index with the one recomputed from the decrypted value. Also
   * fails on a plain value that has no ciphertext. Read-only.
   */
  async verify(options: RunOptions = {}): Promise<VerifyResult> {
    const o = this.opts(options);
    const r: VerifyResult = {
      ok: true,
      verified: 0,
      pending: 0,
      undecryptable: 0,
      plainMismatch: 0,
      blindMismatch: 0,
      sampleIds: [],
    };
    const flag = (id: string): void => {
      r.ok = false;
      if (r.sampleIds.length < SAMPLE_IDS) r.sampleIds.push(id);
    };
    for (const set of ALL_SETS) {
      const plainCol = set.plain ? ident(set.plain) : Prisma.sql`NULL::text`;
      const plainFilter = set.plain
        ? Prisma.sql`OR ${ident(set.plain)} IS NOT NULL`
        : Prisma.empty;
      let cursor = NIL_UUID;
      for (;;) {
        const rows = await this.prisma.$queryRaw<
          {
            id: string;
            plain: string | null;
            enc: string | null;
            blind: string | null;
          }[]
        >(
          Prisma.sql`SELECT id::text AS id, ${plainCol} AS plain, ${ident(set.enc)} AS enc, ${ident(set.blind)} AS blind
                       FROM ${ident(set.table)}
                      WHERE id > ${cursor}::uuid AND (${ident(set.enc)} IS NOT NULL ${plainFilter})
                      ORDER BY id LIMIT ${o.batchSize}`,
        );
        if (rows.length === 0) break;
        cursor = rows[rows.length - 1].id;
        let n = 0;
        for (const row of rows) {
          if (row.enc === null) {
            if (
              row.plain !== null &&
              /\S/.test(row.plain.replace(/[\u200B-\u200D\u2060\uFEFF]/g, ''))
            ) {
              r.pending++;
              flag(row.id);
            }
          } else {
            const res = this.crypto.checkStored(row.enc, {
              expectedPlain: row.plain,
              blind: row.blind,
            });
            if (res === 'ok') r.verified++;
            else {
              if (res === 'undecryptable') r.undecryptable++;
              else if (res === 'plain_mismatch') r.plainMismatch++;
              else r.blindMismatch++;
              flag(row.id);
            }
          }
          if (++n % 200 === 0) await new Promise((res) => setImmediate(res));
        }
        await options.onBatch?.({ set: set.label, batch: 0 });
        if (rows.length < o.batchSize) break;
      }
    }
    return r;
  }

  /** Verify as a recorded run (`--verify`). */
  async runVerify(options: RunOptions = {}): Promise<RunMetrics> {
    return this.timed('verify', async (m) => {
      await this.preflightKeys();
      const v = await this.verify(options);
      m.scanned =
        v.verified +
        v.pending +
        v.undecryptable +
        v.plainMismatch +
        v.blindMismatch;
      m.errors =
        v.pending + v.undecryptable + v.plainMismatch + v.blindMismatch;
      Object.assign(m, {
        verified: v.verified,
        pending: v.pending,
        undecryptable: v.undecryptable,
        plainMismatch: v.plainMismatch,
        blindMismatch: v.blindMismatch,
        sampleIds: v.sampleIds,
      });
      if (!v.ok) m.outcome = 'VERIFY_FAILED';
    });
  }

  // --- check (deploy healthcheck) --------------------------------------------

  /** Plain value left without ciphertext (blank values excluded) and malformed ciphertext, per set. Read-only. */
  async check(): Promise<CheckResult> {
    const res: CheckResult = { ok: true, pending: {}, malformed: {} };
    for (const set of ALL_SETS) {
      const pendingRows = set.plain
        ? await this.prisma.$queryRaw<{ n: bigint }[]>(
            Prisma.sql`SELECT count(*) AS n FROM ${ident(set.table)}
                        WHERE ${ident(set.plain)} IS NOT NULL AND ${ident(set.enc)} IS NULL
                          AND ${ident(set.plain)} ~ ${NOT_BLANK_SQL}`,
          )
        : [{ n: 0n }];
      const malformedRows = await this.prisma.$queryRaw<{ n: bigint }[]>(
        Prisma.sql`SELECT count(*) AS n FROM ${ident(set.table)}
                    WHERE ${ident(set.enc)} IS NOT NULL AND ${ident(set.enc)} !~ ${ENC_SHAPE_SQL}`,
      );
      res.pending[set.label] = Number(pendingRows[0].n);
      res.malformed[set.label] = Number(malformedRows[0].n);
      if (res.pending[set.label] > 0 || res.malformed[set.label] > 0) {
        res.ok = false;
      }
    }
    return res;
  }

  // --- scrub (optional, addresses only) --------------------------------------

  /**
   * `SET recipientIdDoc = NULL` on the ADDRESS BOOK, only after a full real verify passed in this
   * same run and re-verifying each row under a row lock right before nulling it. Orders are not
   * accepted by construction (`SCRUB_SETS`). Anything that does not verify is left untouched.
   */
  async scrub(options: RunOptions = {}): Promise<RunMetrics> {
    const o = this.opts(options);
    return this.timed('scrub', async (m) => {
      await this.preflightKeys();
      const v = await this.verify(options);
      if (!v.ok) {
        m.errors =
          v.pending + v.undecryptable + v.plainMismatch + v.blindMismatch;
        m.outcome = 'VERIFY_FAILED';
        m.sampleIds = v.sampleIds;
        return; // nothing was touched
      }
      for (const set of SCRUB_SETS) {
        const plain = set.plain as string;
        const by = (m.bySet[set.label] ??= zero());
        let cursor = NIL_UUID;
        for (;;) {
          const rows = await this.prisma.$queryRaw<{ id: string }[]>(
            Prisma.sql`SELECT id::text AS id FROM ${ident(set.table)}
                        WHERE id > ${cursor}::uuid AND ${ident(plain)} IS NOT NULL
                        ORDER BY id LIMIT ${o.batchSize}`,
          );
          if (rows.length === 0) break;
          cursor = rows[rows.length - 1].id;
          m.scanned += rows.length;
          const ids = rows.map((r) => r.id);
          const nulled = await this.inBatchTx(async (tx) => {
            // Row locks first: nobody can change these rows between the check and the UPDATE.
            const locked = await tx.$queryRaw<
              {
                id: string;
                plain: string;
                enc: string | null;
                blind: string | null;
              }[]
            >(
              Prisma.sql`SELECT id::text AS id, ${ident(plain)} AS plain, ${ident(set.enc)} AS enc, ${ident(set.blind)} AS blind
                           FROM ${ident(set.table)}
                          WHERE id = ANY(${ids}::uuid[]) AND ${ident(plain)} IS NOT NULL
                          ORDER BY id FOR UPDATE`,
            );
            const good = locked
              .filter(
                (r) =>
                  r.enc !== null &&
                  this.crypto.checkStored(r.enc, {
                    expectedPlain: r.plain,
                    blind: r.blind,
                  }) === 'ok',
              )
              .map((r) => r.id);
            if (good.length > 0) {
              await tx.$executeRaw(
                Prisma.sql`UPDATE ${ident(set.table)} SET ${ident(plain)} = NULL
                            WHERE id = ANY(${good}::uuid[]) AND ${ident(set.enc)} IS NOT NULL`,
              );
            }
            return { good: good.length, locked: locked.length };
          });
          by.scanned = (by.scanned ?? 0) + rows.length;
          m.skipped += nulled.locked - nulled.good;
          by.skipped = (by.skipped ?? 0) + (nulled.locked - nulled.good);
          m['scrubbed'] = Number(m['scrubbed'] ?? 0) + nulled.good;
          m.batches++;
          await o.onBatch?.({ set: set.label, batch: m.batches });
          if (rows.length < o.batchSize) break;
          if (o.pauseMs > 0) await sleep(o.pauseMs);
        }
      }
      if (m.skipped > 0) m.outcome = 'SOME_ROWS_KEPT';
    });
  }

  // --- reencrypt ---------------------------------------------------------------

  /**
   * Key rotation: re-encrypts every stored ciphertext that is not under version `to`, with an
   * in-memory proof per value. The blind index and the masked output cannot change (same value).
   * Compare-and-swap writes (`WHERE enc = <old>`), so a concurrent edit is never overwritten.
   * `dryRun` decrypts and counts (it also finds values that cannot be read) and writes nothing.
   */
  async reencrypt(
    to: number,
    options: RunOptions & { dryRun?: boolean } = {},
  ): Promise<RunMetrics> {
    const o = this.opts(options);
    if (!this.crypto.knownVersions().includes(to)) {
      throw new IdDocMigrationError(
        'KEY_PREFLIGHT_FAILED',
        `key version ${to} is not in IDDOC_ENC_KEYS; nothing was written`,
      );
    }
    return this.timed(
      'reencrypt',
      async (m) => {
        m['targetVersion'] = to;
        m['dryRun'] = options.dryRun === true;
        await this.preflightKeys();
        for (const set of ALL_SETS) {
          const by = (m.bySet[set.label] ??= zero());
          let cursor = NIL_UUID;
          for (;;) {
            const rows = await this.prisma.$queryRaw<
              { id: string; enc: string }[]
            >(
              Prisma.sql`SELECT id::text AS id, ${ident(set.enc)} AS enc FROM ${ident(set.table)}
                          WHERE id > ${cursor}::uuid AND ${ident(set.enc)} IS NOT NULL
                            AND substring(${ident(set.enc)} from '^v([0-9]+):') IS DISTINCT FROM ${String(to)}
                          ORDER BY id LIMIT ${o.batchSize}`,
            );
            if (rows.length === 0) break;
            cursor = rows[rows.length - 1].id;
            m.scanned += rows.length;
            by.scanned = (by.scanned ?? 0) + rows.length;
            const ids: string[] = [];
            const olds: string[] = [];
            const news: string[] = [];
            let n = 0;
            for (const row of rows) {
              try {
                const next = this.crypto.reencryptChecked(row.enc, to);
                ids.push(row.id);
                olds.push(row.enc);
                news.push(next);
              } catch {
                m.errors++;
                by.errors = (by.errors ?? 0) + 1;
              }
              if (++n % 200 === 0)
                await new Promise((res) => setImmediate(res));
            }
            if (options.dryRun) {
              m['wouldReencrypt'] =
                Number(m['wouldReencrypt'] ?? 0) + ids.length;
            } else if (ids.length > 0) {
              const written = await this.inBatchTx((tx) =>
                tx.$queryRaw<{ id: string }[]>(
                  Prisma.sql`UPDATE ${ident(set.table)} AS t SET ${ident(set.enc)} = v.new_enc
                               FROM unnest(${ids}::uuid[], ${olds}::text[], ${news}::text[]) AS v(id, old_enc, new_enc)
                              WHERE t.id = v.id AND t.${ident(set.enc)} = v.old_enc
                          RETURNING t.id::text AS id`,
                ),
              );
              m.encrypted += written.length;
              m.skipped += ids.length - written.length;
              by.encrypted = (by.encrypted ?? 0) + written.length;
              by.skipped = (by.skipped ?? 0) + (ids.length - written.length);
            }
            m.batches++;
            await o.onBatch?.({ set: set.label, batch: m.batches });
            if (rows.length < o.batchSize) break;
            if (o.pauseMs > 0 && !options.dryRun) await sleep(o.pauseMs);
          }
        }
        if (m.errors > 0) m.outcome = 'SOME_VALUES_UNREADABLE';
      },
      { audit: options.dryRun !== true },
    );
  }

  // --- report --------------------------------------------------------------------

  /** Row counts by key version, plus plain-only (blank values excluded) and malformed ciphertext, per set. Read-only. */
  async report(): Promise<Record<string, Record<string, number>>> {
    const out: Record<string, Record<string, number>> = {};
    for (const set of ALL_SETS) {
      const o: Record<string, number> = {};
      const byVersion = await this.prisma.$queryRaw<
        { v: string | null; n: bigint }[]
      >(
        Prisma.sql`SELECT substring(${ident(set.enc)} from '^v([0-9]+):') AS v, count(*) AS n
                     FROM ${ident(set.table)} WHERE ${ident(set.enc)} IS NOT NULL GROUP BY 1 ORDER BY 1`,
      );
      for (const { v, n } of byVersion)
        o[v === null ? 'malformed' : `v${v}`] = Number(n);
      const plainOnly = set.plain
        ? await this.prisma.$queryRaw<{ n: bigint }[]>(
            Prisma.sql`SELECT count(*) AS n FROM ${ident(set.table)}
                        WHERE ${ident(set.plain)} IS NOT NULL AND ${ident(set.enc)} IS NULL
                          AND ${ident(set.plain)} ~ ${NOT_BLANK_SQL}`,
          )
        : [{ n: 0n }];
      o['plain_only'] = Number(plainOnly[0].n);
      out[set.label] = o;
    }
    return out;
  }

  // --- run wrapper: metrics + immutable audit event -------------------------------

  private async timed(
    mode: MigrationMode,
    work: (m: RunMetrics) => Promise<void>,
    opts: { audit?: boolean } = {},
  ): Promise<RunMetrics> {
    const started = Date.now();
    const loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const m: RunMetrics = {
      ...zero(),
      mode,
      outcome: 'ok',
      durationMs: 0,
      maxEventLoopDelayMs: 0,
      batches: 0,
      passes: 0,
      activeKeyVersion: this.crypto.activeKeyVersion,
      bySet: {},
    };
    let failure: unknown = null;
    try {
      await work(m);
    } catch (err) {
      failure = err;
      m.outcome = err instanceof IdDocMigrationError ? err.code : 'FAILED';
      if (!(err instanceof IdDocMigrationError)) m.errors++;
    } finally {
      loop.disable();
      m.durationMs = Date.now() - started;
      m.maxEventLoopDelayMs = Math.round(loop.max / 1e4) / 100;
    }
    if (opts.audit !== false) await this.recordRun(m);
    if (failure instanceof IdDocMigrationError) {
      // The caller needs the reason; the metrics (with the outcome) travel in the error.
      Object.assign(failure, { metrics: m });
      throw failure;
    }
    if (failure) throw failure as Error;
    return m;
  }

  /**
   * `DATA_MIGRATION_RUN` in the immutable log: counters only (never a value, never a row id of a
   * cedula). Written through `AuditService.transaction`, i.e. as the LAST thing of its own short
   * transaction (the chain-head lock is taken at the end, never held across slow work).
   */
  private async recordRun(m: RunMetrics): Promise<void> {
    const after: { [k: string]: AuditPayload } = {
      mode: m.mode,
      outcome: m.outcome,
      scanned: m.scanned,
      encrypted: m.encrypted,
      skipped: m.skipped,
      unparsed: m.unparsed,
      blank: m.blank,
      errors: m.errors,
      durationMs: m.durationMs,
      batches: m.batches,
      passes: m.passes,
      activeKeyVersion: m.activeKeyVersion,
    };
    for (const k of [
      'scrubbed',
      'targetVersion',
      'verified',
      'pending',
    ] as const) {
      if (typeof m[k] === 'number') after[k] = m[k];
    }
    try {
      await this.audit.transaction((_tx, a) => {
        a.add({
          actorType: 'SYSTEM',
          action: 'DATA_MIGRATION_RUN',
          entityType: 'IdDocMigration',
          entityId: m.mode,
          after,
        });
        return Promise.resolve();
      });
    } catch (err) {
      // The data work is already committed: say so loudly and fail the run (exit code), never silently.
      this.logger.error(
        `DATA_MIGRATION_RUN was NOT recorded in the audit log (${err instanceof Error ? err.name : 'error'}); the ${m.mode} work itself was committed`,
      );
      m.outcome = m.outcome === 'ok' ? 'AUDIT_NOT_RECORDED' : m.outcome;
      m['auditRecorded'] = false;
    }
  }
}
