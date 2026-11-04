import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { GENESIS_HASH } from './canonical-json.js';

export const AUDIT_PAGE_SIZE = 50;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTION_RE = /^[A-Z0-9_]{1,64}$/;
const ENTITY_TYPE_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const CURSOR_RE = /^[1-9]\d{0,15}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

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
  const date = (k: string, v: string): Date => {
    if (!DATE_RE.test(v) && !DATETIME_RE.test(v)) {
      throw invalid(`${k} must be an ISO 8601 date or date-time.`);
    }
    const d = new Date(DATE_RE.test(v) ? `${v}T00:00:00.000Z` : v);
    if (Number.isNaN(d.getTime())) throw invalid(`${k} is not a valid date.`);
    return d;
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
    if (entityId.length > 128) throw invalid('entityId is too long.');
    f.entityId = entityId;
  }
  const cursor = one('cursor');
  if (cursor !== undefined) {
    if (!CURSOR_RE.test(cursor)) {
      throw invalid(
        'cursor must be the seq of the last row of the previous page.',
      );
    }
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
}

/** Story 20.1 (FR-140): read-only queries over `Audit_Events` / `Audit_Verifications` (raw SQL, unqualified names). */
@Injectable()
export class AuditReadService {
  constructor(private readonly prisma: PrismaService) {}

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
    const rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT ${COLUMNS} FROM "Audit_Events" WHERE "seq" = $1::bigint`,
      seq,
    );
    if (rows.length === 0) return null;
    const v = toView(rows[0]);
    return { ...v, entityLink: entityLink(v.entityType, v.entityId) };
  }

  async head(): Promise<AuditHead> {
    const rows = await this.prisma.$queryRaw<
      { seq: bigint; hash: string; at: Date; count: bigint }[]
    >`SELECT "seq", "hash", "occurredAt" AS "at", (SELECT count(*) FROM "Audit_Events") AS "count"
        FROM "Audit_Events" ORDER BY "seq" DESC LIMIT 1`;
    if (rows.length === 0) {
      return { seq: 0, hash: GENESIS_HASH, count: 0, at: null };
    }
    return {
      seq: Number(rows[0].seq),
      hash: rows[0].hash,
      count: Number(rows[0].count),
      at: rows[0].at.toISOString(),
    };
  }

  async verifications(limit = 50): Promise<{
    items: Record<string, unknown>[];
    chainBroken: boolean;
    lastBrokenAt: string | null;
  }> {
    const rows = await this.prisma.$queryRaw<Record<string, unknown>[]>`
      SELECT "id", "startedAt", "finishedAt", "mode", "source", "fromSeq", "toSeq", "rows", "result",
             "brokenSeq", "expectedHash", "foundHash", "headSeq", "headHash"
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
    }));
    // The flag follows the LATEST verification: a BROKEN result stays visible
    // until a later verification says otherwise (it cannot silently disappear).
    const latest = items[0];
    return {
      items,
      chainBroken: latest?.result === 'BROKEN',
      lastBrokenAt:
        (items.find((i) => i.result === 'BROKEN')?.startedAt as string) ?? null,
    };
  }
}
