import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import { assertNoIdDocInQuery } from '../common/id-doc-not-in-url.js';
import { isLockTimeout } from '../common/lock-timeout.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseFilterDate } from '../audit/audit-read.service.js';

export const USAGE_PAGE_SIZE = 50;
/** A query that takes longer is cut by the database: the view never holds a pooled connection for long. */
const QUERY_TIMEOUT = '5000ms';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURSOR_RE = /^[1-9]\d{0,18}$/;
const MAX_ID = 9_223_372_036_854_775_807n;
const STATUS_CLASS_RE = /^([2-5])xx$/i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const ACTOR_TYPES = ['ADMIN', 'CUSTOMER', 'ANON'] as const;

export interface UsageFilter {
  from?: Date;
  toInclusive?: Date;
  toExclusive?: Date;
  actorType?: (typeof ACTOR_TYPES)[number];
  actorId?: string;
  /** Already escaped for LIKE; the query appends `%`. */
  routePrefix?: string;
  status?: number;
  statusRange?: [number, number];
  ip?: string;
  requestId?: string;
  cursor?: string;
}

const invalid = (message: string): ApiException =>
  new ApiException(HttpStatus.BAD_REQUEST, 'USAGE_FILTER_INVALID', message);

/** `\`, `%` and `_` are literal characters of a route, not LIKE wildcards. */
export const escapeLike = (s: string): string =>
  s.replace(/[\\%_]/g, (c) => `\\${c}`);

const IPV4_CIDR =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\/(?:3[0-2]|[12]?\d))?$/;
const IPV6_CIDR = /^[0-9a-f:.]{2,45}(?:\/(?:12[0-8]|1[01]\d|\d{1,2}))?$/i;

/**
 * Pure: raw query strings -> validated filter (400 `USAGE_FILTER_INVALID`). The URL never carries an ID
 * document (`assertNoIdDocInQuery`, 400 `ID_DOC_IN_URL_NOT_ALLOWED`): none of these filters takes one, and
 * Nginx would write the whole line, query string included, to its `error_log`.
 */
export function parseUsageQuery(q: Record<string, unknown>): UsageFilter {
  assertNoIdDocInQuery(
    q,
    'a POST search (this log has no ID document filter; use the order or customer search)',
  );
  const one = (k: string): string | undefined => {
    const v = q[k];
    if (v === undefined) return undefined;
    if (typeof v !== 'string' || v.length === 0 || v.length > 512) {
      throw invalid(`${k} must be a single non-empty value.`);
    }
    return v;
  };
  const f: UsageFilter = {};
  const bad = (k: string) => invalid(`${k} is not a valid ISO 8601 date.`);
  const from = one('from');
  if (from !== undefined) f.from = parseFilterDate('from', from, bad);
  const to = one('to');
  if (to !== undefined) {
    const d = parseFilterDate('to', to, bad);
    if (/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      f.toExclusive = new Date(d.getTime() + 86_400_000);
    } else f.toInclusive = d;
  }
  const upper = f.toInclusive ?? f.toExclusive;
  if (f.from && upper && upper <= f.from) {
    throw invalid('`to` must be after `from`.');
  }
  const actorType = one('actorType');
  if (actorType !== undefined) {
    const up = actorType.toUpperCase();
    if (!(ACTOR_TYPES as readonly string[]).includes(up)) {
      throw invalid('actorType must be ADMIN, CUSTOMER or ANON.');
    }
    f.actorType = up as UsageFilter['actorType'];
  }
  for (const key of ['actorId', 'requestId'] as const) {
    const v = one(key);
    if (v !== undefined) {
      if (!UUID_RE.test(v)) throw invalid(`${key} must be a uuid.`);
      f[key] = v.toLowerCase();
    }
  }
  const route = one('route');
  if (route !== undefined) {
    if (route.length > 200 || CONTROL.test(route) || route[0] !== '/') {
      throw invalid(
        'route must be a prefix of a route template that starts with "/" (at most 200 characters).',
      );
    }
    f.routePrefix = escapeLike(route);
  }
  const status = one('status');
  const statusClass = one('statusClass');
  if (status !== undefined && statusClass !== undefined) {
    throw invalid('Send status or statusClass, not both.');
  }
  if (status !== undefined) {
    if (
      !/^\d{3}$/.test(status) ||
      Number(status) < 100 ||
      Number(status) > 599
    ) {
      throw invalid('status must be an HTTP status between 100 and 599.');
    }
    f.status = Number(status);
  }
  if (statusClass !== undefined) {
    const m = STATUS_CLASS_RE.exec(statusClass);
    if (!m) throw invalid('statusClass must be 2xx, 3xx, 4xx or 5xx.');
    const c = Number(m[1]);
    f.statusRange = [c * 100, c * 100 + 99];
  }
  const ip = one('ip');
  if (ip !== undefined) {
    if (!(IPV4_CIDR.test(ip) || (ip.includes(':') && IPV6_CIDR.test(ip)))) {
      throw invalid('ip must be an IPv4/IPv6 address or a CIDR range.');
    }
    f.ip = ip;
  }
  const cursor = one('cursor');
  if (cursor !== undefined) {
    if (!CURSOR_RE.test(cursor) || BigInt(cursor) > MAX_ID) {
      throw invalid('cursor must be the nextCursor of the previous page.');
    }
    f.cursor = cursor;
  }
  return f;
}

export interface UsageLogView {
  id: string;
  ts: string;
  method: string;
  route: string;
  status: number;
  durationMs: number;
  actorType: string;
  actorId: string | null;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

/**
 * Story 20.7 (FR-135): read-only query over `Usage_Logs`, newest first by `id`, a cursor of the last `id`
 * (50 per page). `id` is the insertion order, which follows `ts` closely (the buffer writes in order); the
 * cursor is exact where a timestamp cursor would repeat or skip rows with the same millisecond. It runs
 * with a statement timeout and takes no lock a writer could wait for.
 */
@Injectable()
export class UsageReadService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    f: UsageFilter,
  ): Promise<{ items: UsageLogView[]; nextCursor: string | null }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown): void => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.from) add(`"ts" >= ?::timestamptz`, f.from.toISOString());
    if (f.toInclusive) {
      add(`"ts" <= ?::timestamptz`, f.toInclusive.toISOString());
    }
    if (f.toExclusive) {
      add(`"ts" < ?::timestamptz`, f.toExclusive.toISOString());
    }
    if (f.actorType) add(`"actorType" = ?`, f.actorType);
    if (f.actorId) add(`"actorId" = ?::uuid`, f.actorId);
    if (f.routePrefix !== undefined) {
      add(`"route" LIKE ? || '%' ESCAPE '\\'`, f.routePrefix);
    }
    if (f.status !== undefined) add(`"status" = ?::smallint`, f.status);
    if (f.statusRange) {
      add(`"status" >= ?::smallint`, f.statusRange[0]);
      add(`"status" <= ?::smallint`, f.statusRange[1]);
    }
    if (f.ip) add(`"ip" <<= ?::inet`, f.ip);
    if (f.requestId) add(`"requestId" = ?::uuid`, f.requestId);
    if (f.cursor !== undefined) add(`"id" < ?::bigint`, f.cursor);
    params.push(USAGE_PAGE_SIZE + 1);
    const sql = `SELECT "id"::text AS "id", "ts", "method", "route", "status", "durationMs", "actorType",
              "actorId", host("ip") AS "ip", "userAgent", "requestId"
         FROM "Usage_Logs"
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY "id" DESC LIMIT $${params.length}`;
    let rows: Record<string, unknown>[];
    try {
      rows = await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('statement_timeout', ${QUERY_TIMEOUT}, true), set_config('lock_timeout', '1000ms', true)`;
          return tx.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params);
        },
        { maxWait: 3_000, timeout: 9_000 },
      );
    } catch (err) {
      if (isLockTimeout(err)) {
        throw new ApiException(
          HttpStatus.SERVICE_UNAVAILABLE,
          'USAGE_QUERY_TIMEOUT',
          'The query took too long. Narrow the date range or add a filter (actor, route, status, ip) and try again.',
        );
      }
      throw err;
    }
    const page = rows.slice(0, USAGE_PAGE_SIZE).map((r): UsageLogView => ({
      id: r.id as string,
      ts: (r.ts as Date).toISOString(),
      method: r.method as string,
      route: r.route as string,
      status: Number(r.status),
      durationMs: Number(r.durationMs),
      actorType: r.actorType as string,
      actorId: (r.actorId as string | null) ?? null,
      ip: (r.ip as string | null) ?? null,
      userAgent: (r.userAgent as string | null) ?? null,
      requestId: r.requestId as string,
    }));
    return {
      items: page,
      nextCursor:
        rows.length > USAGE_PAGE_SIZE ? page[page.length - 1].id : null,
    };
  }
}
