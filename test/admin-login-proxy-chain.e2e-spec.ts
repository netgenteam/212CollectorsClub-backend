import { createServer, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { applyRequestContext } from './../src/common/request-id.middleware.js';
import { applyTrustProxy } from './../src/common/trust-proxy.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

/**
 * Story 20.5 follow-up: the admin login through the REAL topology
 *
 *     client -> Nginx -> Next (BFF) -> Nest        (every hop a real HTTP server on loopback)
 *
 * Nginx is not installed here, so it is a Node proxy that does what `deploy/nginx/*.template`
 * says: `X-Forwarded-For $proxy_add_x_forwarded_for` (what the client wrote + the peer address)
 * and `X-Real-IP $remote_addr` (OVERWRITTEN). The peer address of a simulated client is given in
 * the `x-sim-peer` header (a real TCP peer would always be 127.0.0.1 here). "Next" is a Node
 * server that applies the rule of `212CollectorsClub-frontend/lib/utils/client-ip.ts` (the
 * `X-Forwarded-For` entry counted from the right, ONE address forwarded; that helper has its own
 * tests there and was run against these very routes) and calls Nest on loopback.
 * `forwardIp: false` reproduces the bug this fixes (the login route did not forward anything).
 *
 * The disposable Postgres of the run is used (global-test-db.ts); Nest is the real AppModule with
 * the real `ThrottlerGuard` (not overridden) and the real `trust proxy` setting.
 */
const TAG = `t${randomUUID().replace(/-/g, '').slice(0, 7)}`;
const PASS = 'correct-horse-battery-staple-20-5';
const ADMIN_USER = `e2e-chain-${TAG}`;

type Res = {
  status: number;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
};

function call(
  port: number,
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload =
      init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method: init.method ?? 'GET',
        headers: {
          ...(payload
            ? {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
              }
            : {}),
          ...init.headers,
        },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let body: Record<string, unknown>;
          try {
            body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
          } catch {
            body = { raw };
          }
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const listen = (srv: Server): Promise<number> =>
  new Promise((r) =>
    srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)),
  );

describe(
  'admin login through Nginx -> Next -> Nest (e2e, Story 20.5 follow-up)',
  { timeout: 90_000 },
  () => {
    let app: NestExpressApplication;
    let prisma: PrismaService;
    let adminId: string;
    let nestPort: number;
    let nextServer: Server;
    let nginxServer: Server;
    let nginxPort: number;
    let nginxToNestServer: Server;
    let nginxToNestPort: number;
    const forward = { ip: true };
    const sql = (q: string, p: unknown[] = []) =>
      prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);

    /** What Nginx does with a request, then hands it to `targetPort`. */
    const nginx = (targetPort: number): Server =>
      createServer((req, res) => {
        const peer = String(req.headers['x-sim-peer'] ?? '127.0.0.1');
        const headers = { ...req.headers };
        delete headers['x-sim-peer'];
        const prior = headers['x-forwarded-for'];
        headers['x-forwarded-for'] =
          `${prior ? `${String(prior)}, ` : ''}${peer}`; // $proxy_add_x_forwarded_for
        headers['x-real-ip'] = peer; // $remote_addr (overwrites what the client sent)
        headers['x-forwarded-proto'] = 'https';
        const up = httpRequest(
          {
            host: '127.0.0.1',
            port: targetPort,
            path: req.url,
            method: req.method,
            headers,
          },
          (r) => {
            res.writeHead(r.statusCode ?? 502, r.headers);
            r.pipe(res);
          },
        );
        up.on('error', () => {
          res.statusCode = 502;
          res.end();
        });
        req.pipe(up);
      });

    /** The BFF login route: the last X-Forwarded-For entry (or none, `forward.ip = false`). */
    const next = (): Server =>
      createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const xff = String(req.headers['x-forwarded-for'] ?? '');
          const last = xff.split(',').pop()?.trim();
          void call(nestPort, '/api/v1/admin/auth/login', {
            method: 'POST',
            headers: forward.ip && last ? { 'x-forwarded-for': last } : {},
            body: raw ? (JSON.parse(raw) as unknown) : undefined,
          }).then((r) => {
            const h: Record<string, string> = {
              'content-type': 'application/json',
            };
            if (r.headers['retry-after'])
              h['retry-after'] = String(r.headers['retry-after']);
            res.writeHead(r.status, h);
            res.end(JSON.stringify(r.body));
          });
        });
      });

    /** One login attempt as a browser would send it: through Nginx and Next. */
    const login = (
      peer: string,
      usernameOrEmail: string,
      password: string,
      extra: Record<string, string> = {},
    ) =>
      call(nginxPort, '/api/admin/auth/login', {
        method: 'POST',
        headers: { 'x-sim-peer': peer, ...extra },
        body: { usernameOrEmail, password },
      });

    const lastEvents = async (action: string, since: number) =>
      sql(
        `SELECT "seq"::int AS seq, host("ip") AS ip, "after" FROM "Audit_Events"
        WHERE "action" = $1 AND "seq" > $2 ORDER BY "seq"`,
        [action, since],
      );
    const head = async () =>
      Number(
        (
          await sql(
            `SELECT COALESCE(max("seq"),0)::int AS s FROM "Audit_Events"`,
          )
        )[0].s,
      );
    const waitFor = async <T>(
      fn: () => Promise<T | null | false>,
      ms = 8_000,
    ): Promise<T> => {
      const t0 = Date.now();
      for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 > ms) throw new Error('timed out waiting');
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    beforeAll(async () => {
      // Generous event budget: this file is about the IP and the limits, not about the budget.
      process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE = '1000';
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleFixture.createNestApplication<NestExpressApplication>({
        rawBody: true,
      });
      applyTrustProxy(app, undefined); // the production default
      applyRequestContext(app);
      app.setGlobalPrefix('api');
      app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
      app.useGlobalPipes(createGlobalValidationPipe());
      await app.init();
      await app.listen(0, '127.0.0.1');
      nestPort = (app.getHttpServer().address() as AddressInfo).port;
      prisma = app.get(PrismaService);

      const passwordHash = await argon2.hash(PASS, { type: argon2.argon2id });
      adminId = (
        await prisma.adminUser.create({
          data: {
            username: ADMIN_USER,
            email: `${ADMIN_USER}@212collectorsclub.test`,
            passwordHash,
          },
        })
      ).id;

      nextServer = next();
      const nextPort = await listen(nextServer);
      nginxServer = nginx(nextPort);
      nginxPort = await listen(nginxServer);
      // Nginx straight to Nest (the `api.<domain>` server block).
      nginxToNestServer = nginx(nestPort);
      nginxToNestPort = await listen(nginxToNestServer);
    });

    afterAll(async () => {
      delete process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE;
      for (const s of [nginxToNestServer, nginxServer, nextServer]) {
        await new Promise<void>((r) => s?.close(() => r()));
      }
      await prisma?.adminUser
        .delete({ where: { id: adminId } })
        .catch(() => undefined);
      await app?.close();
    });

    it('CONTROL (the bug): without forwarding the IP every client is the Next server, so 5 anonymous failures lock the real admin out', async () => {
      forward.ip = false;
      try {
        for (let i = 0; i < 5; i++) {
          expect(
            (await login('203.0.113.50', ADMIN_USER, 'nope-nope-nope')).status,
          ).toBe(401);
        }
        const real = await login('198.51.100.20', ADMIN_USER, PASS);
        expect(real.status).toBe(429);
        expect((real.body as { errorCode: string }).errorCode).toBe(
          'ADMIN_LOGIN_RATE_LIMITED',
        );
      } finally {
        forward.ip = true;
      }
      // the lock came from the Next server address, the only one Nest could see
      const seen = await sql(
        `SELECT host("ip") AS ip FROM "Audit_Events" WHERE "action" = 'LOGIN_ADMIN_FAILED' ORDER BY "seq" DESC LIMIT 1`,
      );
      expect(seen[0].ip).toBe('127.0.0.1');
    });

    it('FIXED: an anonymous attacker with 5 failures on the admin user does NOT block the real admin from another IP; the events carry the real IPs', async () => {
      const since = await head();
      const attacker = '203.0.113.61';
      const adminIp = '198.51.100.21';
      for (let i = 0; i < 5; i++) {
        expect(
          (await login(attacker, ADMIN_USER, 'nope-nope-nope')).status,
        ).toBe(401);
      }
      // the attacker (that IP + that user name) is now locked, with the unified body and Retry-After
      const locked = await login(attacker, ADMIN_USER, PASS);
      expect(locked.status).toBe(429);
      expect(locked.body).toMatchObject({
        statusCode: 429,
        errorCode: 'ADMIN_LOGIN_RATE_LIMITED',
        details: { retryAfterSeconds: expect.any(Number) as number },
      });
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(locked.headers['retry-after'])).toBe(
        (locked.body.details as { retryAfterSeconds: number })
          .retryAfterSeconds,
      );

      // the real admin, from his own IP, gets in
      const real = await login(adminIp, ADMIN_USER, PASS);
      expect(real.status).toBe(200);
      expect(typeof real.body.accessToken).toBe('string');

      const ok = await waitFor(async () => {
        const r = await lastEvents('LOGIN_ADMIN_OK', since);
        return r.length >= 1 ? r : null;
      });
      expect(ok.at(-1)?.ip).toBe(adminIp);
      const failed = await waitFor(async () => {
        const r = await lastEvents('LOGIN_ADMIN_FAILED', since);
        return r.length >= 5 ? r : null;
      });
      expect(failed.map((f) => f.ip)).toEqual(Array(5).fill(attacker));
      expect(failed.some((f) => f.ip === '127.0.0.1')).toBe(false);
    });

    it('the attacker cannot choose the IP the backend sees: a forged X-Forwarded-For / X-Real-IP is to the left of what Nginx appends', async () => {
      const since = await head();
      const attacker = '203.0.113.62';
      const victimIp = '198.51.100.22';
      for (let i = 0; i < 5; i++) {
        await login(attacker, ADMIN_USER, 'nope-nope-nope', {
          'x-forwarded-for': `${victimIp}, 127.0.0.1`,
          'x-real-ip': victimIp,
        });
      }
      // had the forged address counted, this admin (victimIp) would now be locked
      expect((await login(victimIp, ADMIN_USER, PASS)).status).toBe(200);
      const failed = await waitFor(async () => {
        const r = await lastEvents('LOGIN_ADMIN_FAILED', since);
        return r.length >= 5 ? r : null;
      });
      expect(failed.every((f) => f.ip === attacker)).toBe(true);
    });

    it('20 failures from ONE IP lock that IP for every user name (429 before hashing), and nobody else', async () => {
      const attacker = '203.0.113.63';
      for (let i = 0; i < 20; i++) {
        expect(
          (await login(attacker, `ghost-${TAG}-${i}`, 'nope-nope-nope')).status,
        ).toBe(401);
      }
      const blocked = await login(
        attacker,
        `ghost-${TAG}-new`,
        'nope-nope-nope',
      );
      expect(blocked.status).toBe(429);
      expect(blocked.body).toMatchObject({
        errorCode: 'ADMIN_LOGIN_RATE_LIMITED',
      });
      expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
      expect((await login('198.51.100.23', ADMIN_USER, PASS)).status).toBe(200);
    });

    it('the generic ceiling (60 attempts / 10 min per IP) answers the SAME body and Retry-After, with scope IP_RATE', async () => {
      const ip = '203.0.113.64';
      for (let i = 0; i < 60; i++) {
        expect((await login(ip, ADMIN_USER, PASS)).status).toBe(200);
      }
      const over = await login(ip, ADMIN_USER, PASS);
      expect(over.status).toBe(429);
      expect(over.body).toMatchObject({
        statusCode: 429,
        errorCode: 'ADMIN_LOGIN_RATE_LIMITED',
        message: expect.any(String) as string,
        details: {
          scope: 'IP_RATE',
          retryAfterSeconds: expect.any(Number) as number,
        },
      });
      const retry = Number(over.headers['retry-after']);
      expect(retry).toBeGreaterThan(0);
      expect(retry).toBeLessThanOrEqual(600);
      expect(
        (over.body.details as { retryAfterSeconds: number }).retryAfterSeconds,
      ).toBe(retry);
      // another IP is untouched
      expect((await login('198.51.100.24', ADMIN_USER, PASS)).status).toBe(200);
    });

    it('Nginx straight to Nest (the api.<domain> block) also resolves the address Nginx appended, never the client-written ones', async () => {
      const since = await head();
      const r = await call(nginxToNestPort, '/api/v1/admin/auth/login', {
        method: 'POST',
        headers: {
          'x-sim-peer': '203.0.113.65',
          'x-forwarded-for': '1.1.1.1, 2.2.2.2',
        },
        body: { usernameOrEmail: ADMIN_USER, password: PASS },
      });
      expect(r.status).toBe(200);
      const ok = await waitFor(async () => {
        const rows = await lastEvents('LOGIN_ADMIN_OK', since);
        return rows.length >= 1 ? rows : null;
      });
      expect(ok.at(-1)?.ip).toBe('203.0.113.65');
    });
  },
);
