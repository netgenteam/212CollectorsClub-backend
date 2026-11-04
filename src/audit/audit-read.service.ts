import { HttpStatus, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { codePointLength, pgText } from './audit-normalize.js';
import { GENESIS_HASH } from './canonical-json.js';

export const AUDIT_PAGE_SIZE = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_RE = /^[A-Z0-9_]{1,64}$/;
const ENTITY_TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CURSOR_RE = /^[1-9]\d{0,15}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATETIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;
/** Filters outside this window cannot match anything (the chain starts in 2020) and some are not valid timestamptz. */
export const FILTER_MIN_DATE = Date.UTC(2000, 0, 1);
export const FILTER_MAX_DATE = Date.UTC(2999, 11, 31, 23, 59, 59, 999);
/** Largest seq/cursor accepted: above 2^53 a JS number is no longer exact. */
const MAX_SEQ = Number.MAX_SAFE_INTEGER;
const daysInMonth = (y: number, m: number): number =>
  new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based: day 0 of the next month

export interface AuditEventsFilter {
  from?: Date;
  /** Exclusive upper bound (a date-only `to` covers the whole day). */
  toExclusive?: Date;
  toInclusive?: Date;
  action?: string;
  actorId?: string;
  entityType?: string;
  entityId?: string;
  requestId?: string;
  cursor?: number;
}

const invalid = (message: string): ApiException =>
  new ApiException(HttpStatus.BAD_REQUEST, 'AUDIT_FILTER_INVALID', message);

/** Pure: raw query strings -> validated filter (400 `AUDIT_FILTER_INVALID`). */
export function parseAuditEventsQuery(
  q: Record<string, unknown>,
): AuditEventsFilter {
  const one = (k: string): string | undefined => {
    const v = q[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length === 0) {
      throw invalid(`${k} must be a single non-empty value.`);
    }
    return v;
  };
  const f: AuditEventsFilter = {};
  /** Strict calendar check: `2026-02-30` is NOT 2 March, `24:00`, `:60` and `+24:00` are not accepted. */
  const date = (k: string, v: string): Date => {
    const bad = (): ApiException =>
      invalid(
        `${k} must be a valid ISO 8601 date (YYYY-MM-DD) or date-time with offset.`,
      );
    const d = DATE_RE.exec(v);
    const dt = d ? null : DATETIME_RE.exec(v);
    const m = d ?? dt;
    if (!m) throw bad();
    const [y, mo, da] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (mo < 1 || mo > 12 || da < 1 || da > daysInMonth(y, mo)) throw bad();
    let ms: number;
    if (d) {
      ms = Date.UTC(y, mo - 1, da);
    } else {
      const [h, mi, se, frac, off] = [
        Number(dt![4]),
        Number(dt![5]),
        Number(dt![6] ?? 0),
        dt![7] ? Number(dt![7].padEnd(3, '0')) : 0,
        dt![8],
      ];
      if (h > 23 || mi > 59 || se > 59) throw bad();
      let offsetMin = 0;
      if (off !== 'Z') {
        const oh = Number(off.slice(1, 3));
        const om = Number(off.slice(4, 6));
        if (oh > 23 || om > 59) throw bad();
        offsetMin = (off[0] === '-' ? -1 : 1) * (oh * 60 + om);
      }
      ms = Date.UTC(y, mo - 1, da, h, mi, se, frac) - offsetMin * 60_000;
    }
    if (!Number.isFinite(ms) || ms < FILTER_MIN_DATE || ms > FILTER_MAX_DATE) {
      throw invalid(`${k} must be between 2000-01-01 and 2999-12-31.`);
    }
    return new Date(ms);
  };
  const from = one('from');
  if (from !== undefined) f.from = date('from', from);
  const to = one('to');
  if (to !== undefined) {
    const d = date('to', to);
    if (DATE_RE.test(to)) f.toExclusive = new Date(d.getTime() + 86_400_000);
    else f.toInclusive = d;
  }
  const lower = f.from;
  const upper = f.toInclusive ?? f.toExclusive;
  if (lower && upper && upper <= lower) {
    throw invalid('`to` must be after `from`.');
  }
  const action = one('action');
  if (action !== undefined) {
    if (!ACTION_RE.test(action)) throw invalid('action is not a valid code.');
    f.action = action;
  }
  for (const k of ['actorId', 'requestId'] as const) {
    const v = one(k);
    if (v !== undefined) {
      if (!UUID_RE.test(v)) throw invalid(`${k} must be a uuid.`);
      f[k] = v.toLowerCase();
    }
  }
  const entityType = one('entityType');
  if (entityType !== undefined) {
    if (!ENTITY_TYPE_RE.test(entityType))
      throw invalid('entityType is invalid.');
    f.entityType = entityType;
  }
  const entityId = one('entityId');
  if (entityId !== undefined) {
    // Same rule as the column: at most 128 characters; NUL and lone surrogates
    // (a percent-decoded `%00`, `%ED%A0%80`) are not text Postgres can compare.
    if (codePointLength(entityId) > 128) throw invalid('entityId is too long.');
    if (pgText(entityId) !== entityId) {
      throw invalid(
        'entityId has characters that cannot be stored (NUL or lone surrogate).',
      );
    }
    f.entityId = entityId;
  }
  const cursor = one('cursor');
  if (cursor !== undefined) {
    if (!CURSOR_RE.test(cursor)) {
      throw invalid(
        'cursor must be the seq of the last row of the previous page.',
      );
    }
    if (Number(cursor) > MAX_SEQ) throw invalid('cursor is out of range.');
    f.cursor = Number(cursor);
  }
  return f;
}

const COLUMNS = `"seq", "occurredAt", "actorType", "actorId", "action", "entityType", "entityId",
  "before", "after", "reason", "requestId", host("ip") AS "ip", "hashVersion", "prevHash", "hash"`;

export interface AuditEventView {
  seq: number;
  occurredAt: string;
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

const toView = (r: Record<string, unknown>): AuditEventView => ({
  seq: Number(r.seq),
  occurredAt: (r.occurredAt as Date).toISOString(),
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

/** Admin screen link (relative) for the entity types the app emits; null when unknown. */
export function entityLink(
  entityType: string,
  entityId: string,
): string | null {
  const id = encodeURIComponent(entityId);
  switch (entityType) {
    case 'ORDER':
      return `/admin/orders/${id}`;
    case 'CUSTOMER':
      return `/admin/customers/${id}`;
    case 'PRODUCT':
      return `/admin/products/${id}`;
    case 'LEGAL_DOCUMENT':
      return `/admin/legal/${id}`;
    case 'AUDIT_VERIFICATION':
      return `/admin/auditoria`;
    default:
      return null;
  }
}

export interface AuditHead {
  seq: number;
  hash: string;
  count: number;
  at: string | null;
  anchorEmailConfigured: boolean;
}

/** Story 20.1 (FR-140): read-only queries over `Audit_Events` / `Audit_Verifications` (raw SQL, unqualified names). */
@Injectable()
export class AuditReadService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  /** `AUDIT_ANCHOR_EMAIL` is set: somebody OUTSIDE the database gets the head every week. */
  anchorEmailConfigured(): boolean {
    return (
      String(this.config?.get('AUDIT_ANCHOR_EMAIL') ?? '').trim().length > 0
    );
  }

  async list(
    f: AuditEventsFilter,
  ): Promise<{ items: AuditEventView[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown): void => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.from) add(`"occurredAt" >= ?::timestamptz`, f.from);
    if (f.toInclusive) add(`"occurredAt" <= ?::timestamptz`, f.toInclusive);
    if (f.toExclusive) add(`"occurredAt" < ?::timestamptz`, f.toExclusive);
    if (f.action) add(`"action" = ?`, f.action);
    if (f.actorId) add(`"actorId" = ?::uuid`, f.actorId);
    if (f.entityType) add(`"entityType" = ?`, f.entityType);
    if (f.entityId) add(`"entityId" = ?`, f.entityId);
    if (f.requestId) add(`"requestId" = ?::uuid`, f.requestId);
    if (f.cursor !== undefined) add(`"seq" < ?::bigint`, f.cursor);
    params.push(AUDIT_PAGE_SIZE + 1);
    const rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM "Audit_Events"
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY "seq" DESC LIMIT $${params.length}`,
      ...params,
    );
    const page = rows.slice(0, AUDIT_PAGE_SIZE).map(toView);
    return {
      items: page,
      nextCursor:
        rows.length > AUDIT_PAGE_SIZE
          ? String(page[page.length - 1].seq)
          : null,
    };
  }

  async bySeq(
    seq: number,
  ): Promise<(AuditEventView & { entityLink: string | null }) | null> {
    if (!Number.isSafeInteger(seq) || seq < 1) return null;
    const rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM "Audit_Events" WHERE "seq" = $1::bigint`,
      seq,
    );
    if (rows.length === 0) return null;
    const v = toView(rows[0]);
    return { ...v, entityLink: entityLink(v.entityType, v.entityId) };
  }

  /**
   * `count` is the seq of the last row, not `count(*)` (O(n) over a table that only
   * grows): the chain guard trigger only admits `seq = previous + 1` starting at 1,
   * so the two are equal while the chain is intact, and a gap (a DBA's tampering)
   * is what the verification reports.
   */
  async head(): Promise<AuditHead> {
    const anchorEmailConfigured = this.anchorEmailConfigured();
    const rows = await this.prisma.$queryRaw<
      { seq: bigint; hash: string; at: Date }[]
    >`SELECT "seq", "hash", "occurredAt" AS "at"
        FROM "Audit_Events" ORDER BY "seq" DESC LIMIT 1`;
    if (rows.length === 0) {
      return {
        seq: 0,
        hash: GENESIS_HASH,
        count: 0,
        at: null,
        anchorEmailConfigured,
      };
    }
    return {
      seq: Number(rows[0].seq),
      hash: rows[0].hash,
      count: Number(rows[0].seq),
      at: rows[0].at.toISOString(),
      anchorEmailConfigured,
    };
  }

  async verifications(limit = 50): Promise<{
    items: Record<string, unknown>[];
    chainBroken: boolean;
    lastBrokenAt: string | null;
    lastCompleteVerificationAt: string | null;
    anchorEmailConfigured: boolean;
  }> {
    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "startedAt", "finishedAt", "mode", "source", "fromSeq", "toSeq", "rows", "result",
             "brokenSeq", "expectedHash", "foundHash", "headSeq", "headHash", "partial"
        FROM "Audit_Verifications" ORDER BY "startedAt" DESC, "id" LIMIT ${limit}`;
    const items = rows.map((r) => ({
      id: r.id,
      startedAt: (r.startedAt as Date).toISOString(),
      finishedAt: r.finishedAt ? (r.finishedAt as Date).toISOString() : null,
      mode: r.mode,
      source: r.source,
      fromSeq: Number(r.fromSeq),
      toSeq: Number(r.toSeq),
      rows: Number(r.rows),
      result: r.result,
      brokenSeq: r.brokenSeq === null ? null : Number(r.brokenSeq),
      expectedHash: r.expectedHash ?? null,
      foundHash: r.foundHash ?? null,
      headSeq: Number(r.headSeq),
      headHash: r.headHash,
      partial: r.partial === true,
    }));
    const state = await this.prisma.$queryRaw<
      { broken: Date | null; complete: Date | null }[]
    >`
      SELECT (SELECT max("startedAt") FROM "Audit_Verifications" WHERE "result" = 'BROKEN') AS "broken",
             (SELECT max("startedAt") FROM "Audit_Verifications" WHERE "result" = 'OK' AND NOT "partial") AS "complete"`;
    const lastBroken = state[0]?.broken ?? null;
    const lastComplete = state[0]?.complete ?? null;
    // The alert follows the chain, not the latest row: a BROKEN verification
    // stays visible until a LATER verification that covered the WHOLE chain
    // (not partial) came back OK. A partial OK (`fromSeq`, an incremental run
    // that trusts the rows before its anchor, a run cut by `limit`) proves
    // nothing about the rows it did not read, so it can never clear the alert.
    // Re-running a verification over an unchanged broken chain is BROKEN again,
    // so a full OK is evidence the chain verifies now, never a way to dismiss it.
    const chainBroken =
      lastBroken !== null &&
      (lastComplete === null || lastComplete < lastBroken);
    return {
      items,
      chainBroken,
      lastBrokenAt: lastBroken ? lastBroken.toISOString() : null,
      lastCompleteVerificationAt: lastComplete
        ? lastComplete.toISOString()
        : null,
      anchorEmailConfigured: this.anchorEmailConfigured(),
    };
  }
}
