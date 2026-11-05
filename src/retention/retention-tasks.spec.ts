import { Prisma } from '../generated/prisma/client.js';
import {
  RETENTION_DEFAULTS,
  SAFETY_MARGIN_MS,
  marginalClock,
  readRetentionConfig,
} from './retention-config.js';
import { runBatches } from './retention-batch.js';
import type { RetentionContext, RetentionTask } from './retention.types.js';
import {
  anonCartsTask,
  anonWishlistsTask,
} from './tasks/anonymous-baskets.tasks.js';
import { contactInquiriesTask } from './tasks/contact-inquiries.task.js';
import {
  productDailyStatsTask,
  usageLogsTask,
} from './tasks/delegated.tasks.js';
import {
  revokedTokensTask,
  verificationTokensTask,
} from './tasks/expired-tokens.tasks.js';
import { retentionRunsTask } from './tasks/retention-runs.task.js';
import { sessionPiiTask } from './tasks/session-pii.task.js';
import { sessionsExpiredTask } from './tasks/sessions-expired.task.js';

/** A fake clock: 2026-11-04T04:30:00Z; the margin of the run is one hour, so every cut-off counts back from 03:30. */
const AS_OF = new Date('2026-11-04T04:30:00.000Z');
const MARGINAL_ISO = '2026-11-04T03:30:00.000Z';

interface Stmt {
  sql: string;
  values: unknown[];
}

function fakeCtx(counts: number[], overrides: Partial<RetentionContext> = {}) {
  const stmts: Stmt[] = [];
  const queue = [...counts];
  const tx = {
    $executeRaw: (
      first: TemplateStringsArray | { strings: string[]; values: unknown[] },
      ...rest: unknown[]
    ) => {
      const isSql = !Array.isArray(first);
      const strings = isSql
        ? (first as { strings: string[] }).strings
        : (first as TemplateStringsArray);
      const values = isSql ? (first as { values: unknown[] }).values : rest;
      const sql = strings.join('?');
      if (/set_config/.test(sql)) return Promise.resolve(1);
      stmts.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
      return Promise.resolve(queue.shift() ?? 0);
    },
  };
  const rows = { n: 0 };
  const ctx: RetentionContext = {
    prisma: {
      $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
    } as never,
    runId: '11111111-1111-4111-8111-111111111111',
    cfg: readRetentionConfig(() => undefined, 'production'),
    asOf: AS_OF,
    shouldStop: () => false,
    pause: () => Promise.resolve(),
    addRows: (n) => {
      rows.n += n;
    },
    ...overrides,
  };
  return { ctx, stmts, rows };
}

const tableOf = (s: Stmt) =>
  /(?:DELETE FROM|UPDATE) "([A-Za-z_]+)"/.exec(s.sql)?.[1];

describe('every task counts its period back from the run clock minus the safety margin (fake clock)', () => {
  const cases: [string, RetentionTask, string[], RegExp[]][] = [
    [
      'sessions_expired',
      sessionsExpiredTask,
      ['Customer_Sessions', 'Admin_Sessions'],
      [
        /"expiresAt" < \(\?::timestamptz AT TIME ZONE 'UTC'\) - make_interval\(days => \?::int\)/,
      ],
    ],
    [
      'session_pii',
      sessionPiiTask,
      ['Customer_Sessions', 'Admin_Sessions'],
      [
        /SET "ipAddress" = NULL, "userAgent" = NULL/,
        /"expiresAt" < \(\?::timestamptz AT TIME ZONE 'UTC'\)/,
        /"ipAddress" IS NOT NULL OR "userAgent" IS NOT NULL/,
      ],
    ],
    [
      'revoked_tokens',
      revokedTokensTask,
      ['Revoked_Tokens'],
      [/make_interval\(days/],
    ],
    [
      'verification_tokens',
      verificationTokensTask,
      ['Customer_Verifications'],
      [/make_interval\(days/],
    ],
    [
      'contact_inquiries',
      contactInquiriesTask,
      ['Contact_Inquiries'],
      [/make_interval\(months => \?::int\)/],
    ],
    [
      'anon_carts',
      anonCartsTask,
      ['Carts'],
      [/"customerId" IS NULL AND "expiresAt" </],
    ],
    [
      'anon_wishlists',
      anonWishlistsTask,
      ['Wishlists'],
      [/"customerId" IS NULL AND "expiresAt" </],
    ],
    [
      'retention_runs',
      retentionRunsTask,
      ['Retention_Runs'],
      [
        /"status" <> 'RUNNING' AND "finishedAt" IS NOT NULL AND "id" <> \?::uuid/,
      ],
    ],
  ];

  it.each(cases)('%s', async (name, task, tables, patterns) => {
    expect(task.name).toBe(name);
    const { ctx, stmts } = fakeCtx([]);
    const out = await task.run(ctx);
    expect(out).toEqual({ rows: 0, truncated: false });
    expect(stmts.map(tableOf)).toEqual(tables);
    for (const s of stmts) {
      // the clock is a PARAMETER (never string-built) and it is the marginal one
      expect(
        s.values.filter((v) => v === MARGINAL_ISO).length,
      ).toBeGreaterThanOrEqual(1);
      // a bounded batch whose rows are locked WITHOUT waiting (the app role may UPDATE these tables)
      expect(s.sql).toMatch(/LIMIT \?::int FOR UPDATE SKIP LOCKED\)/);
      for (const p of patterns) expect(s.sql).toMatch(p);
      expect(s.sql).not.toMatch(/\bnow\(\)/i);
      expect(s.sql).not.toMatch(/CASCADE|TRUNCATE/i);
    }
    // the periods come from the configuration
    const all = stmts.flatMap((s) => s.values);
    if (name === 'sessions_expired' || name === 'revoked_tokens')
      expect(all).toContain(7);
    if (name === 'session_pii')
      expect(all).toContain(RETENTION_DEFAULTS.sessionPiiDays);
    if (name === 'contact_inquiries')
      expect(all).toContain(RETENTION_DEFAULTS.contactMonths);
    if (name === 'verification_tokens')
      expect(all).toContain(RETENTION_DEFAULTS.expiredTokenDays);
    if (name === 'retention_runs') {
      expect(all).toContain(RETENTION_DEFAULTS.retentionRunsDays);
      expect(all).toContain('11111111-1111-4111-8111-111111111111');
    }
  });

  it('a stricter configured period is the one used', async () => {
    const cfg = readRetentionConfig(
      (k) => ({ PURGE_SESSION_PII_DAYS: '30', PURGE_CONTACT_MONTHS: '3' })[k],
      'production',
    );
    const a = fakeCtx([], { cfg });
    await sessionPiiTask.run(a.ctx);
    expect(a.stmts[0].values).toContain(30);
    const b = fakeCtx([], { cfg });
    await contactInquiriesTask.run(b.ctx);
    expect(b.stmts[0].values).toContain(3);
  });
});

describe('the batch loop', () => {
  it('repeats while a batch is full, stops at the first short one and counts the rows', async () => {
    const { ctx, stmts, rows } = fakeCtx([1000, 1000, 17]);
    const out = await runBatches(ctx, (tx, limit) =>
      tx.$executeRaw(Prisma.sql`DELETE FROM "x" LIMIT ${limit}`),
    );
    expect(out).toEqual({ rows: 2017, truncated: false });
    expect(stmts).toHaveLength(3);
    expect(rows.n).toBe(2017);
    expect(stmts[0].values).toEqual([1000]);
  });

  it('pauses between batches, not after the last one', async () => {
    const pause = vi.fn(() => Promise.resolve());
    const { ctx } = fakeCtx([1000, 1000, 5], { pause });
    await runBatches(ctx, (tx, limit) => tx.$executeRaw`DELETE ${limit}`);
    expect(pause).toHaveBeenCalledTimes(2);
  });

  it('stops at the run deadline between two batches: truncated, with what was done', async () => {
    let calls = 0;
    const { ctx } = fakeCtx([1000, 1000, 1000], {
      shouldStop: () => calls++ >= 2,
    });
    const out = await runBatches(
      ctx,
      (tx, limit) => tx.$executeRaw`DELETE ${limit}`,
    );
    expect(out).toEqual({ rows: 2000, truncated: true });
  });

  it('a lock wait that expires (a live request owns the row) ends the task truncated, not failed', async () => {
    const err = Object.assign(
      new Error('canceling statement due to lock timeout'),
      { code: '55P03' },
    );
    const ctx = fakeCtx([]).ctx;
    ctx.prisma = { $transaction: () => Promise.reject(err) } as never;
    await expect(runBatches(ctx, () => Promise.resolve(0))).resolves.toEqual({
      rows: 0,
      truncated: true,
    });
  });

  it('a deadlock victim also ends truncated (the next run retries)', async () => {
    const err = Object.assign(new Error('deadlock detected'), {
      code: '40P01',
    });
    const ctx = fakeCtx([]).ctx;
    ctx.prisma = { $transaction: () => Promise.reject(err) } as never;
    await expect(
      runBatches(ctx, () => Promise.resolve(0)),
    ).resolves.toMatchObject({ truncated: true });
  });

  it('any other error is a failure of the task (propagates)', async () => {
    const ctx = fakeCtx([]).ctx;
    ctx.prisma = {
      $transaction: () => Promise.reject(new Error('boom')),
    } as never;
    await expect(runBatches(ctx, () => Promise.resolve(0))).rejects.toThrow(
      'boom',
    );
  });
});

describe('the tasks that INVOKE other purges do not reimplement them', () => {
  it('usage_logs calls Story 20.7 purgeExpired with the run clock, budget and stop condition', async () => {
    const purgeExpired = vi.fn(() =>
      Promise.resolve({ rows: 42, batches: 1, durationMs: 3, truncated: true }),
    );
    const { ctx } = fakeCtx([]);
    const out = await usageLogsTask({ purgeExpired } as never).run(ctx);
    expect(out).toEqual({ rows: 42, truncated: true });
    expect(purgeExpired).toHaveBeenCalledWith({
      days: 7,
      batch: 1000,
      pauseMs: 100,
      maxRunMs: 600_000,
      asOf: new Date(MARGINAL_ISO),
      shouldStop: ctx.shouldStop,
    });
  });

  it('boundary: marginalClock is asOf minus exactly 1 h, for usage_logs and for every other task alike (one clock, no exception)', async () => {
    expect(marginalClock(AS_OF)).toEqual(
      new Date(AS_OF.getTime() - SAFETY_MARGIN_MS),
    );
    expect(SAFETY_MARGIN_MS).toBe(3_600_000);
    const purgeExpired = vi.fn(() =>
      Promise.resolve({ rows: 0, batches: 1, durationMs: 1, truncated: false }),
    );
    const later = new Date(AS_OF.getTime() + 3 * 24 * 3_600_000);
    const { ctx } = fakeCtx([], { asOf: later });
    await usageLogsTask({ purgeExpired } as never).run(ctx);
    const used = (purgeExpired.mock.calls[0] as unknown as [{ asOf: Date }])[0]
      .asOf;
    expect(used).toEqual(new Date(later.getTime() - SAFETY_MARGIN_MS));
    const other = fakeCtx([0, 0], { asOf: later });
    await sessionsExpiredTask.run(other.ctx);
    expect(JSON.stringify(other.stmts)).toContain(
      new Date(later.getTime() - SAFETY_MARGIN_MS).toISOString(),
    );
  });

  it('product_daily_stats calls the Epic 18 purge (the only code that deletes that table)', async () => {
    const purgeOldStatsBounded = vi.fn(() =>
      Promise.resolve({ rows: 9, truncated: false }),
    );
    const { ctx } = fakeCtx([]);
    const out = await productDailyStatsTask({
      purgeOldStatsBounded,
    } as never).run(ctx);
    expect(out).toEqual({ rows: 9, truncated: false });
    expect(purgeOldStatsBounded).toHaveBeenCalledWith(
      new Date(MARGINAL_ISO),
      1000,
      {
        shouldStop: ctx.shouldStop,
        pauseMs: 100,
      },
    );
  });
});
