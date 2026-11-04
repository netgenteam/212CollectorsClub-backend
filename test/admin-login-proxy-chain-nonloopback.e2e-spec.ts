import { createServer, request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
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
 * Story 20.5 follow-up (QA blocker): Next and Nest in DIFFERENT containers (Dokploy). The peer Nest
 * sees is the Next container, NOT loopback. The chain
 *
 *     client -> proxy (Traefik/Nginx, appends the peer) -> Next (BFF) -> Nest on a NON-loopback address
 *
 * uses a real non-loopback address of this machine as the Next -> Nest hop (Nest listens on 0.0.0.0
 * and Next calls it through that address, so the socket peer Nest sees is that address). Only the
 * Nest `trust proxy` setting changes between the two tests:
 *   - NEGATIVE: the default (`loopback`): the header is ignored, every client is the Next address,
 *     5 anonymous failures lock the real admin out and the events carry the Next address.
 *   - POSITIVE: `TRUST_PROXY` = the network of the Next container: the real IPs come through.
 * Skipped (and said so) when the machine has no non-loopback IPv4 address.
 */
const TAG = `t${randomUUID().replace(/-/g, '').slice(0, 7)}`;
const PASS = 'correct-horse-battery-staple-20-5';
const ADMIN_USER = `e2e-nlb-${TAG}`;

function nonLoopbackIPv4(): string | null {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}
const NEXT_ADDR = nonLoopbackIPv4();

type Res = { status: number; body: Record<string, unknown> };

function call(
  host: string,
  port: number,
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload =
      init.body === undefined ? undefined : JSON.stringify(init.body);
    const req = httpRequest(
      {
        host,
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
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const listenLoopback = (srv: Server): Promise<number> =>
  new Promise((r) =>
    srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)),
  );

describe.skipIf(NEXT_ADDR === null)(
  'admin login with Next -> Nest on a NON-loopback peer (e2e, Story 20.5 follow-up)',
  { timeout: 120_000 },
  () => {
    let prisma: PrismaService;
    let adminId: string;
    const sql = (q: string, p: unknown[] = []) =>
      prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);

    interface Chain {
      app: NestExpressApplication;
      proxy: Server;
      next: Server;
      proxyPort: number;
    }

    /** proxy (simulated Traefik/Nginx) -> Next sim -> Nest through `NEXT_ADDR`. */
    async function boot(trustProxy: string | undefined): Promise<Chain> {
      process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE = '1000';
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const app = moduleFixture.createNestApplication<NestExpressApplication>({
        rawBody: true,
      });
      applyTrustProxy(app, trustProxy);
      applyRequestContext(app);
      app.setGlobalPrefix('api');
      app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
      app.useGlobalPipes(createGlobalValidationPipe());
      await app.init();
      await app.listen(0, '0.0.0.0');
      const nestPort = (app.getHttpServer().address() as AddressInfo).port;
      prisma = app.get(PrismaService);

      // Next: ONE validated address (the last X-Forwarded-For entry), then Nest on the NON-loopback address.
      const next = createServer((req, res) => {
        let raw = '';
        req.on('data', (c) => (raw += c));
        req.on('end', () => {
          const last = String(req.headers['x-forwarded-for'] ?? '')
            .split(',')
            .pop()
            ?.trim();
          void call(NEXT_ADDR!, nestPort, '/api/v1/admin/auth/login', {
            method: 'POST',
            headers: last ? { 'x-forwarded-for': last } : {},
            body: raw ? (JSON.parse(raw) as unknown) : undefined,
          }).then((r) => {
            res.writeHead(r.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(r.body));
          });
        });
      });
      const nextPort = await listenLoopback(next);
      const proxy = createServer((req, res) => {
        const peer = String(req.headers['x-sim-peer'] ?? '127.0.0.1');
        const headers = { ...req.headers };
        delete headers['x-sim-peer'];
        const prior = headers['x-forwarded-for'];
        headers['x-forwarded-for'] =
          `${prior ? `${String(prior)}, ` : ''}${peer}`;
        const up = httpRequest(
          {
            host: '127.0.0.1',
            port: nextPort,
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
      return { app, proxy, next, proxyPort: await listenLoopback(proxy) };
    }

    async function stop(c: Chain): Promise<void> {
      for (const s of [c.proxy, c.next]) {
        await new Promise<void>((r) => s.close(() => r()));
      }
      await c.app.close();
    }

    const login = (c: Chain, peer: string, user: string, password: string) =>
      call('127.0.0.1', c.proxyPort, '/api/admin/auth/login', {
        method: 'POST',
        headers: { 'x-sim-peer': peer },
        body: { usernameOrEmail: user, password },
      });

    const failedIps = async (since: number) =>
      (
        await sql(
          `SELECT host("ip") AS ip FROM "Audit_Events" WHERE "action"='LOGIN_ADMIN_FAILED' AND "seq" > $1 ORDER BY "seq"`,
          [since],
        )
      ).map((r) => r.ip as string);
    const head = async () =>
      Number(
        (
          await sql(
            `SELECT COALESCE(max("seq"),0)::int AS s FROM "Audit_Events"`,
          )
        )[0].s,
      );
    const waitFailed = async (since: number, n: number) => {
      const t0 = Date.now();
      for (;;) {
        const ips = await failedIps(since);
        if (ips.length >= n) return ips;
        if (Date.now() - t0 > 8_000) throw new Error('timed out waiting');
        await new Promise((r) => setTimeout(r, 50));
      }
    };

    async function seedAdmin(): Promise<void> {
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
    }
    afterAll(async () => {
      delete process.env.AUDIT_LOGIN_FAILED_MAX_PER_MINUTE;
      await prisma?.adminUser
        .delete({ where: { id: adminId } })
        .catch(() => undefined);
    });

    it('NEGATIVE (default `loopback`, the Dokploy misconfiguration): the header is ignored, 5 anonymous failures lock the real admin out and the events carry the Next address', async () => {
      const c = await boot(undefined);
      try {
        await seedAdmin();
        const since = await head();
        for (let i = 0; i < 5; i++) {
          expect(
            (await login(c, '203.0.113.50', ADMIN_USER, 'nope-nope-nope'))
              .status,
          ).toBe(401);
        }
        const real = await login(c, '198.51.100.20', ADMIN_USER, PASS);
        expect(real.status).toBe(429);
        const ips = await waitFailed(since, 5);
        expect(ips.every((ip) => ip === NEXT_ADDR)).toBe(true);
      } finally {
        await stop(c);
      }
    });

    it('POSITIVE (`TRUST_PROXY` = the Next network): the real IPs come through, the attacker is locked and the real admin from another IP gets in', async () => {
      const trust = `loopback,${NEXT_ADDR}/32`;
      const c = await boot(trust);
      try {
        const since = await head();
        for (let i = 0; i < 5; i++) {
          expect(
            (await login(c, '203.0.113.51', ADMIN_USER, 'nope-nope-nope'))
              .status,
          ).toBe(401);
        }
        expect((await login(c, '203.0.113.51', ADMIN_USER, PASS)).status).toBe(
          429,
        );
        expect((await login(c, '198.51.100.21', ADMIN_USER, PASS)).status).toBe(
          200,
        );
        const ips = await waitFailed(since, 5);
        expect(ips.slice(0, 5)).toEqual(Array(5).fill('203.0.113.51'));
        // a forged header from the client is to the LEFT of what the proxy appends: never read
        const forged = await call(
          '127.0.0.1',
          c.proxyPort,
          '/api/admin/auth/login',
          {
            method: 'POST',
            headers: {
              'x-sim-peer': '203.0.113.52',
              'x-forwarded-for': '198.51.100.21, 127.0.0.1',
            },
            body: { usernameOrEmail: ADMIN_USER, password: 'nope-nope-nope' },
          },
        );
        expect(forged.status).toBe(401);
        const after = await waitFailed(since, 6);
        expect(after[5]).toBe('203.0.113.52');
      } finally {
        await stop(c);
      }
    });
  },
);
