import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { RetentionService } from './../src/retention/retention.service.js';

/**
 * Story 20.8, perf (pnpm test:perf, one file at a time): the whole job over tables at volume, with the
 * REAL settings (batch 1 000, pause 100 ms), and what it does to a shop that keeps selling meanwhile.
 *
 *   RETENTION_PERF_USAGE   rows of Usage_Logs        (default 400 000; 2 000 000 for the NFR-20.3 figure)
 *   RETENTION_PERF_SESSIONS expired Customer_Sessions (default 60 000)
 *   RETENTION_PERF_CARTS    expired anonymous carts, 2 lines each (default 40 000)
 *   RETENTION_PERF_CONTACTS contact messages past 12 months (default 10 000)
 *
 * Measured while the job runs: the delay of the Node event loop (the job must not block it) and the
 * latency of what a visitor does at the same time (read a product, create a cart with a line, as the
 * add-to-cart does). Every row is tagged and removed after.
 */
const TAG = `zz208perf-${randomUUID().slice(0, 8)}`;
const num = (k: string, d: number): number => Number(process.env[k] ?? d);
const USAGE = num('RETENTION_PERF_USAGE', 400_000);
const SESSIONS = num('RETENTION_PERF_SESSIONS', 60_000);
const CARTS = num('RETENTION_PERF_CARTS', 40_000);
const CONTACTS = num('RETENTION_PERF_CONTACTS', 10_000);
const out = (s: string): void => void process.stdout.write(`${s}\n`);
const pct = (a: number[], p: number): number => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const now = (): number => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe(
  'retention job at volume (perf, Story 20.8)',
  { timeout: 1_800_000 },
  () => {
    let app: INestApplication;
    let prisma: PrismaService;
    let productId: string;
    let userId: string;
    const saved: Record<string, string | undefined> = {};

    const x = (q: string, ...p: unknown[]) => prisma.$executeRawUnsafe(q, ...p);

    beforeAll(async () => {
      for (const [k, v] of Object.entries({
        RETENTION_PURGE_ENABLED: 'true',
        RETENTION_BATCH_SIZE: '1000',
        RETENTION_BATCH_PAUSE_MS: '100',
        RETENTION_MAX_RUN_MS: '3600000',
      })) {
        saved[k] = process.env[k];
        process.env[k] = v;
      }
      const m = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = m.createNestApplication();
      await app.init();
      prisma = app.get(PrismaService);
      productId = (
        await prisma.product.findFirstOrThrow({ select: { id: true } })
      ).id;
      userId = (
        await prisma.customer.create({
          data: { email: `${TAG}@212collectorsclub.test`, name: 'Perf' },
        })
      ).id;
      const t0 = now();
      await x(
        `INSERT INTO "Usage_Logs" ("ts","method","route","status","durationMs","actorType","ip","userAgent","requestId")
       SELECT now() - (g::numeric / $2::numeric) * interval '9 days', 'GET', '/' || $1, 200, g % 700, 'ANON',
              ('10.' || (g % 200) || '.' || (g % 250) || '.' || (g % 253))::inet, 'perf-208', gen_random_uuid()
         FROM generate_series(1, $2::int) g`,
        TAG,
        USAGE,
      );
      await x(
        `INSERT INTO "Customer_Sessions" ("id","token","expiresAt","ipAddress","userAgent","userId","createdAt","updatedAt")
       SELECT gen_random_uuid(), $1 || '-' || g, (now() AT TIME ZONE 'UTC') - interval '30 days', '203.0.113.1', 'perf', $3::uuid,
              (now() AT TIME ZONE 'UTC') - interval '40 days', (now() AT TIME ZONE 'UTC')
         FROM generate_series(1, $2::int) g`,
        TAG,
        SESSIONS,
        userId,
      );
      await x(
        `INSERT INTO "Carts" ("id","customerId","expiresAt","createdAt","updatedAt")
       SELECT ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, NULL, (now() AT TIME ZONE 'UTC') - interval '40 days',
              (now() AT TIME ZONE 'UTC') - interval '70 days', (now() AT TIME ZONE 'UTC') - interval '70 days'
         FROM generate_series(1, $1::int) g ON CONFLICT DO NOTHING`,
        CARTS,
      );
      // two lines each: the cascade is part of the cost
      await x(
        `INSERT INTO "Cart_Items" ("id","cartId","productId","quantity","createdAt","updatedAt")
       SELECT gen_random_uuid(), c."id", $1::uuid, 1, now(), now()
         FROM "Carts" c WHERE c."customerId" IS NULL AND c."expiresAt" < (now() AT TIME ZONE 'UTC') - interval '30 days'
          AND c."id"::text LIKE '00000000-0000-4000-8000-%'`,
        productId,
      );
      await x(
        `INSERT INTO "Contact_Inquiries" ("id","name","email","message","createdAt","updatedAt")
       SELECT gen_random_uuid(), $1, 'perf@212collectorsclub.test', 'x', (now() AT TIME ZONE 'UTC') - interval '14 months', (now() AT TIME ZONE 'UTC') - interval '14 months'
         FROM generate_series(1, $2::int) g`,
        TAG,
        CONTACTS,
      );
      await x(`ANALYZE "Usage_Logs"`).catch(() => 0);
      out(
        `[20.8 perf] seeded ${USAGE} usage rows, ${SESSIONS} sessions, ${CARTS} carts (+lines), ${CONTACTS} contacts in ${((now() - t0) / 1000).toFixed(1)} s`,
      );
    });

    afterAll(async () => {
      await x(`DELETE FROM "Usage_Logs" WHERE "route" = '/' || $1`, TAG).catch(
        () => 0,
      );
      await x(
        `DELETE FROM "Customer_Sessions" WHERE "token" LIKE $1 || '-%'`,
        TAG,
      ).catch(() => 0);
      await x(`DELETE FROM "Contact_Inquiries" WHERE "name" = $1`, TAG).catch(
        () => 0,
      );
      await x(
        `DELETE FROM "Carts" WHERE "id"::text LIKE '00000000-0000-4000-8000-%'`,
      ).catch(() => 0);
      await prisma.customer
        .delete({ where: { id: userId } })
        .catch(() => undefined);
      await app.close();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    /** What a visitor does: read a product, then a cart with one line. One transaction, like the add-to-cart. */
    async function visitorOnce(): Promise<number> {
      const t0 = now();
      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT stock, "heldQty" FROM "Products" WHERE id = ${productId}::uuid`;
        const cart = await tx.cart.create({
          data: { expiresAt: new Date(Date.now() + 30 * 86_400_000) },
        });
        await tx.cartItem.create({
          data: { cartId: cart.id, productId, quantity: 1 },
        });
        await tx.cart.delete({ where: { id: cart.id } });
      });
      return now() - t0;
    }

    async function sample(ms: number): Promise<number[]> {
      const lat: number[] = [];
      const end = now() + ms;
      while (now() < end) {
        lat.push(await visitorOnce());
        await sleep(15);
      }
      return lat;
    }

    it('purges the lot within the budget, never blocks the event loop, and a visitor never waits for it', async () => {
      const svc = app.get(RetentionService);
      const baseline = await sample(4_000);

      const hist = monitorEventLoopDelay({ resolution: 10 });
      hist.enable();
      let stop = false;
      const during: number[] = [];
      const visitors = (async () => {
        while (!stop) {
          during.push(await visitorOnce());
          await sleep(15);
        }
      })();
      const t0 = now();
      const started = await svc.start('MANUAL', null);
      if (started.kind !== 'started') throw new Error(started.kind);
      const sum = await started.done;
      const took = now() - t0;
      stop = true;
      await visitors;
      hist.disable();

      const perTask = sum.tasks
        .map(
          (k) =>
            `${k.name}=${k.rows} (${(k.durationMs / 1000).toFixed(1)} s${k.truncated ? ', TRUNCATED' : ''}${k.error ? `, ERROR ${k.error}` : ''})`,
        )
        .join('; ');
      out(
        `[20.8 perf] run ${sum.status} in ${(took / 1000).toFixed(1)} s: ${perTask}`,
      );
      out(
        `[20.8 perf] visitor transaction (read + cart + line + delete): idle p50 ${pct(baseline, 50).toFixed(1)} p95 ${pct(baseline, 95).toFixed(1)} max ${Math.max(...baseline).toFixed(1)} ms (n=${baseline.length}) | during the job p50 ${pct(during, 50).toFixed(1)} p95 ${pct(during, 95).toFixed(1)} p99 ${pct(during, 99).toFixed(1)} max ${Math.max(...during).toFixed(1)} ms (n=${during.length})`,
      );
      out(
        `[20.8 perf] event loop delay during the job: mean ${(hist.mean / 1e6).toFixed(1)} ms p99 ${(hist.percentile(99) / 1e6).toFixed(1)} ms max ${(hist.max / 1e6).toFixed(1)} ms`,
      );

      expect(sum.status).toBe('OK');
      for (const k of sum.tasks) {
        expect(k.error).toBeUndefined();
        expect(k.truncated).toBe(false);
      }
      const rows = (n: string) => sum.tasks.find((k) => k.name === n)!.rows;
      expect(rows('sessions_expired')).toBeGreaterThanOrEqual(SESSIONS);
      expect(rows('anon_carts')).toBeGreaterThanOrEqual(CARTS);
      expect(rows('contact_inquiries')).toBeGreaterThanOrEqual(CONTACTS);
      expect(rows('usage_logs')).toBeGreaterThan(0);
      // NFR-20.3: 1 M rows of log in under 5 minutes (here scaled: the whole job over everything seeded)
      const logRows = rows('usage_logs');
      const per1M =
        (sum.tasks.find((k) => k.name === 'usage_logs')!.durationMs /
          Math.max(1, logRows)) *
        1_000_000;
      out(
        `[20.8 perf] usage_logs: ${logRows} rows; 1 M rows = ${(per1M / 1000).toFixed(0)} s`,
      );
      expect(per1M).toBeLessThan(300_000);
      // no long wait for a visitor, and the event loop never stalls
      expect(Math.max(...during)).toBeLessThan(2_000);
      expect(pct(during, 95)).toBeLessThan(
        Math.max(250, pct(baseline, 95) * 5),
      );
      expect(hist.percentile(99) / 1e6).toBeLessThan(100);

      // idempotent over the same volume
      const again = await svc.start('MANUAL', null);
      if (again.kind !== 'started') throw new Error(again.kind);
      const s2 = await again.done;
      for (const k of s2.tasks) {
        if (k.name === 'retention_runs') continue;
        // the table keeps AGING while the first run works (rows cross the 7-day line): only those can be left
        if (k.name === 'usage_logs') expect(k.rows).toBeLessThan(2_000);
        else expect(k.rows, k.name).toBe(0);
      }
    });
  },
);
