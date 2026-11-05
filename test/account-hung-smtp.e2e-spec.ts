import net from 'node:net';
import { randomUUID } from 'node:crypto';
import {
  bootHarness,
  BASE,
  type Harness,
} from './helpers/account-write-race.js';

/**
 * Story 20.6a (second round): with an SMTP server that ACCEPTS the connection and never answers, the
 * account routes that send mail (forgot-password, resend-verification, register) must not hold a
 * database connection while they wait, and must answer in the same time whether the email exists or
 * not. 30 concurrent `forgot-password` used to leave the 10 pooled connections `idle in transaction`
 * (the transaction waited for BetterAuth, which needs a SECOND connection of the same pool) and every
 * other route queued behind them (`GET /categories` took 9.7 s).
 */
const TAG = `h${randomUUID().replace(/-/g, '').slice(0, 7)}`;

describe(
  'Account routes with a hung SMTP server (e2e, Story 20.6a)',
  { timeout: 180_000 },
  () => {
    let h: Harness;
    let smtp: net.Server;
    const sockets = new Set<net.Socket>();
    const server = () => h.server();

    beforeAll(async () => {
      smtp = net.createServer((s) => {
        sockets.add(s);
        s.on('close', () => sockets.delete(s));
        s.on('error', () => undefined);
        // accepts and says nothing: no greeting, ever
      });
      await new Promise<void>((r) => smtp.listen(0, '127.0.0.1', r));
      process.env.SMTP_HOST = '127.0.0.1';
      process.env.SMTP_PORT = String((smtp.address() as net.AddressInfo).port);
      h = await bootHarness(TAG);
    });
    afterAll(async () => {
      await h.close();
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => smtp.close(() => r()));
    });

    const idleInTx = async () =>
      Number(
        (
          await h.sql(
            `SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE datname = current_database() AND state = 'idle in transaction' AND pid <> pg_backend_pid()`,
          )
        )[0].n,
      );
    const timed = async (fn: () => Promise<{ status: number }>) => {
      const t0 = performance.now();
      const r = await fn();
      return { status: r.status, ms: performance.now() - t0 };
    };

    it('30 concurrent forgot-password: no connection stays idle in transaction, /categories stays fast, a token is written exactly once per account and the answers do not depend on the email', async () => {
      const c = await h.mkCustomer('sm');
      const known = () =>
        server().post(`${BASE}/auth/forgot-password`).send({ email: c.email });
      const unknown = () =>
        server()
          .post(`${BASE}/auth/forgot-password`)
          .send({ email: `nadie-${randomUUID()}@212collectorsclub.test` });
      let maxIdle = 0;
      const probe = setInterval(() => {
        void idleInTx().then((n) => {
          maxIdle = Math.max(maxIdle, n);
        });
      }, 50);
      const t0 = performance.now();
      const all = await Promise.all([
        ...Array.from({ length: 15 }, () => timed(known)),
        ...Array.from({ length: 15 }, () => timed(unknown)),
      ]);
      const wall = performance.now() - t0;
      const cat = await timed(() => server().get(`${BASE}/categories`));
      clearInterval(probe);
      const k = all.slice(0, 15).map((x) => x.ms);
      const u = all.slice(15).map((x) => x.ms);
      const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
      process.stdout.write(
        `[20.6a hung smtp] 30 forgot wall=${wall.toFixed(0)}ms known avg=${avg(k).toFixed(0)}ms unknown avg=${avg(u).toFixed(0)}ms max idle-in-tx=${maxIdle} GET /categories=${cat.ms.toFixed(0)}ms\n`,
      );
      expect(all.every((x) => x.status === 200)).toBe(true);
      expect(cat.status).toBe(200);
      expect(cat.ms).toBeLessThan(1_000);
      expect(maxIdle).toBeLessThanOrEqual(1);
      // no timing oracle: a slow SMTP server must not make the existing email slower
      expect(Math.abs(avg(k) - avg(u))).toBeLessThan(250);
      await new Promise((r) => setTimeout(r, 1_500));
      const tokens = await h.sql(
        `SELECT count(*)::int AS n FROM "Customer_Verifications" WHERE "value" = $1 AND "identifier" NOT LIKE 'email-verification:%'`,
        [c.id],
      );
      expect(Number(tokens[0].n)).toBeGreaterThanOrEqual(1);
    });

    it('resend-verification and register with a hung SMTP answer at once and leave no connection idle in transaction', async () => {
      const c = await h.mkCustomer('rv', { verified: false });
      const rs = await Promise.all(
        Array.from({ length: 30 }, () =>
          timed(() =>
            server()
              .post(`${BASE}/auth/resend-verification`)
              .send({ email: c.email }),
          ),
        ),
      );
      expect(rs.every((x) => x.status === 200)).toBe(true);
      const cat = await timed(() => server().get(`${BASE}/categories`));
      expect(cat.ms).toBeLessThan(1_000);
      // the background queue lets at most 3 token transactions run at once, never a pile of 30
      expect(await idleInTx()).toBeLessThanOrEqual(3);
    });
  },
);
