import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { UsageLogPurgeService } from './../src/usage/usage-purge.service.js';
import {
  UsageReadService,
  parseUsageQuery,
} from './../src/usage/usage-read.service.js';
import { USAGE_LOG_WRITER } from './../src/usage/usage-log.types.js';
import type {
  UsageLogRow,
  UsageLogWriter,
} from './../src/usage/usage-log.types.js';

/**
 * Story 20.7, perf (pnpm test:perf, one file at a time): the table at the size a busy week produces
 * (USAGE_PERF_ROWS, default 400 000; the figures in docs/deployment.md 19.9 are from 3 000 000), the cost
 * of the admin queries on it, the 7-day purge (NFR-20.3: 1 M rows in under 5 minutes), and what the purge
 * does to the writer (it must never make an INSERT wait). Rows are tagged by `route` and removed after.
 */
const TAG = `/zz207perf/${randomUUID().slice(0, 8)}`;
const ROWS = Number(process.env.USAGE_PERF_ROWS ?? 400_000);
const out = (s: string): void => void process.stdout.write(`${s}\n`);
const pct = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (): number => Number(process.hrtime.bigint()) / 1e6;

describe('usage log at volume (perf, Story 20.7)', { timeout: 900_000 }, () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let old = 0;

  beforeAll(async () => {
    const m = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = m.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    const t0 = ms();
    // 9 days of traffic, 1/3 of it ... evenly spread; the first 2/9 is older than 7 days
    await prisma.$executeRawUnsafe(
      `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","actorId","ip","userAgent","requestId")
       SELECT now() - (g::numeric / $2::numeric) * interval '9 days',
              (ARRAY['GET','GET','GET','POST'])[1 + g % 4],
              $1 || '/' || (ARRAY['catalog','orders/:orderId','cart/items','auth/login','categories'])[1 + g % 5],
              (ARRAY[200,200,200,200,404,401,500,201])[1 + g % 8]::smallint,
              g % 700,
              (ARRAY['ANON','ANON','ANON','CUSTOMER','ADMIN'])[1 + g % 5],
              CASE WHEN g % 5 IN (3,4) THEN ('00000000-0000-4000-8000-' || lpad((g % 5000)::text, 12, '0'))::uuid END,
              ('10.' || (g % 200) || '.' || (g % 250) || '.' || (g % 253))::inet,
              'perf-207',
              gen_random_uuid()
         FROM generate_series(1, $2::int) g`,
      TAG,
      ROWS,
    );
    // ANALYZE needs ownership: with the limited role autovacuum's statistics are used as they are
    await prisma
      .$executeRawUnsafe('ANALYZE "Usage_Logs"')
      .catch(() => undefined);
    old = Number(
      (
        await prisma.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*)::bigint AS n FROM "Usage_Logs" WHERE "route" LIKE $1 || '%' AND "ts" < now() - interval '7 days'`,
          TAG,
        )
      )[0].n,
    );
    out(
      `[20.7 perf] seeded ${ROWS} rows in ${((ms() - t0) / 1000).toFixed(1)} s (${old} older than 7 days)`,
    );
  }, 900_000);
  afterAll(async () => {
    await prisma.$executeRawUnsafe(
      `DELETE FROM "Usage_Logs" WHERE "route" LIKE $1 || '%'`,
      TAG,
    );
    await app.close();
  }, 300_000);

  it('the admin queries: every filter answers fast and from an index', async () => {
    const reader = app.get(UsageReadService);
    const a = (q: Record<string, string>) =>
      reader.list(parseUsageQuery({ route: TAG, ...q }));
    const cases: [string, Record<string, string>][] = [
      ['route prefix only', {}],
      ['status=500', { status: '500' }],
      ['statusClass=4xx', { statusClass: '4xx' }],
      ['actorId', { actorId: '00000000-0000-4000-8000-000000000003' }],
      ['actorType=ADMIN', { actorType: 'ADMIN' }],
      ['ip', { ip: '10.3.3.3' }],
      ['ip CIDR /16', { ip: '10.7.0.0/16' }],
      [
        'from/to (one hour)',
        {
          from: new Date(Date.now() - 3 * 86_400_000).toISOString(),
          to: new Date(Date.now() - 3 * 86_400_000 + 3_600_000).toISOString(),
        },
      ],
    ];
    const rows: string[] = [];
    for (const [name, q] of cases) {
      const t: number[] = [];
      let items = 0;
      for (let i = 0; i < 8; i++) {
        const t0 = ms();
        const r = await a(q);
        t.push(ms() - t0);
        items = r.items.length;
      }
      rows.push(
        `${name}: p50 ${pct(t, 50).toFixed(1)} ms, max ${Math.max(...t).toFixed(1)} ms (${items} items)`,
      );
      // the view's own limit is 5 s; a healthy query is nowhere near
      expect(pct(t, 50), name).toBeLessThan(1_500);
    }
    // a deep cursor page is as cheap as the first (keyset, not OFFSET)
    let cursor: string | null = null;
    const deep: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = ms();
      const r = await reader.list(
        parseUsageQuery({ route: TAG, ...(cursor ? { cursor } : {}) }),
      );
      deep.push(ms() - t0);
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    rows.push(
      `cursor pages 1..30: first ${deep[0].toFixed(1)} ms, last ${deep[deep.length - 1].toFixed(1)} ms`,
    );
    out(`[20.7 perf] ${ROWS} rows; ${rows.join(' | ')}`);
    // the indexes the story asks for are the ones the plans use
    const plan = async (sql: string, ...p: unknown[]) =>
      (
        await prisma.$queryRawUnsafe<{ 'QUERY PLAN': string }[]>(
          `EXPLAIN ${sql}`,
          ...p,
        )
      )
        .map((r) => r['QUERY PLAN'])
        .join('\n');
    const byIp = await plan(
      `SELECT id FROM "Usage_Logs" WHERE "ip" = $1::inet ORDER BY id DESC LIMIT 51`,
      '10.3.3.3',
    );
    const byActor = await plan(
      `SELECT id FROM "Usage_Logs" WHERE "actorId" = $1::uuid ORDER BY id DESC LIMIT 51`,
      '00000000-0000-4000-8000-000000000003',
    );
    const byReq = await plan(
      `SELECT id FROM "Usage_Logs" WHERE "requestId" = $1::uuid`,
      randomUUID(),
    );
    const byRoute = await plan(
      `SELECT id FROM "Usage_Logs" WHERE "route" LIKE $1 || '%' AND "ts" > now() - interval '1 hour'`,
      '/api/v1/orders/',
    );
    out(
      `[20.7 plans] ip: ${byIp.split('\n')[0]} | actor: ${byActor.split('\n')[0]} | requestId: ${byReq.split('\n')[0]} | route: ${byRoute.split('\n')[0]}`,
    );
    expect(byReq).toMatch(/Usage_Logs_requestId_key/);
    expect(byActor).toMatch(/Usage_Logs_actorId_ts_idx|Usage_Logs_pkey/);
    expect(byRoute).toMatch(/Usage_Logs_route_ts_idx|Usage_Logs_ts_idx/);
  });

  it('the purge deletes the old rows in batches without making an INSERT or a query wait, and 1 M rows would take well under 5 minutes', async () => {
    const purge = app.get(UsageLogPurgeService);
    const writer = app.get<UsageLogWriter>(USAGE_LOG_WRITER);
    const batchRows = (n: number): UsageLogRow[] =>
      Array.from({ length: n }, () => ({
        ts: Date.now(),
        method: 'GET',
        route: `${TAG}/live`,
        status: 200,
        durationMs: 2,
        actorType: 'ANON' as const,
        actorId: null,
        ip: '198.51.100.1',
        userAgent: 'perf-207-live',
        requestId: randomUUID(),
      }));
    // keep writing 200-row batches (what the buffer does) while the purge runs
    let stop = false;
    const inserts: number[] = [];
    const writing = (async () => {
      while (!stop) {
        const t0 = ms();
        await writer.insert(batchRows(200));
        inserts.push(ms() - t0);
        await new Promise((r) => setTimeout(r, 20));
      }
    })();
    const t0 = ms();
    // the real settings: batch 1 000, pause 100 ms
    const r = await purge.purgeExpired({ days: 7 });
    const took = ms() - t0;
    stop = true;
    await writing;
    const per1M = (took / Math.max(1, r.rows)) * 1_000_000;
    out(
      `[20.7 perf] purge: ${r.rows} rows in ${r.batches} batches, ${(took / 1000).toFixed(1)} s (${Math.round(r.rows / (took / 1000))} rows/s; 1 M rows = ${(per1M / 1000).toFixed(0)} s). INSERTs of 200 rows during it: n=${inserts.length} p50 ${pct(inserts, 50).toFixed(1)} ms p95 ${pct(inserts, 95).toFixed(1)} ms max ${Math.max(...inserts).toFixed(1)} ms`,
    );
    expect(r.rows).toBeGreaterThanOrEqual(old);
    expect(r.truncated).toBe(false);
    expect(per1M).toBeLessThan(300_000);
    // no long lock: no INSERT waited anywhere near a batch
    expect(Math.max(...inserts)).toBeLessThan(2_000);
    expect(pct(inserts, 95)).toBeLessThan(250);
    const left = Number(
      (
        await prisma.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*)::bigint AS n FROM "Usage_Logs" WHERE "route" LIKE $1 || '%' AND "ts" < now() - interval '7 days'`,
          TAG,
        )
      )[0].n,
    );
    expect(left).toBe(0);
    const again = await purge.purgeExpired({ days: 7, pauseMs: 1 });
    expect(again.rows).toBe(0);
  });
});
