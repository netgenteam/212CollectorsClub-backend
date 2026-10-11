import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { CustomerAuthService } from './../src/customer-auth/customer-auth.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

type App = Parameters<typeof request>[0];
type Mail = { id: string; subject: string; body: string };

const MAILHOG = 'http://localhost:8025';
const TAG = randomUUID().slice(0, 8);
const emailOf = (k: string) => `e2e-12-6-rv-${TAG}-${k}@212collectorsclub.test`;
const GENERIC =
  'If this email belongs to an unverified account, a new verification link has been sent.';

const qpDecode = (s: string) =>
  s
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_m, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );

async function mailsTo(email: string): Promise<Mail[]> {
  const res = await fetch(
    `${MAILHOG}/api/v2/search?kind=to&query=${encodeURIComponent(email)}&limit=50`,
  );
  const json = (await res.json()) as {
    items: {
      ID: string;
      Content: { Headers: { Subject: string[] }; Body: string };
    }[];
  };
  return json.items.map((i) => ({
    id: i.ID,
    subject: i.Content.Headers.Subject[0],
    body: qpDecode(i.Content.Body),
  }));
}

async function clearMailsTo(email: string) {
  for (const m of await mailsTo(email)) {
    await fetch(`${MAILHOG}/api/v1/messages/${encodeURIComponent(m.id)}`, {
      method: 'DELETE',
    });
  }
}

/** Waits until exactly `count` verification mails exist for `email`. */
async function waitForVerificationMails(
  email: string,
  count: number,
): Promise<Mail[]> {
  for (let i = 0; i < 60; i++) {
    const found = (await mailsTo(email)).filter((m) =>
      /verif/i.test(m.subject),
    );
    if (found.length >= count) return found;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`expected ${count} verification mails for ${email}`);
}

const tokenOf = (mail: Mail): string => {
  const m =
    /http:\/\/frontend\.test\/verify-email\?token=([A-Za-z0-9_%.-]+)/.exec(
      mail.body,
    );
  if (!m) throw new Error(`no verify link in: ${mail.body}`);
  return decodeURIComponent(m[1]);
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1];

/**
 * Story 12.6 AC11 e2e (FR-43): POST /auth/resend-verification, with the REAL
 * throttler (5 per IP per 10 min per route; this suite stays within it for
 * the HTTP calls it counts on) and the real mailer (MailHog).
 */
describe(
  'Resend verification (Story 12.6, AC11, e2e)',
  { timeout: 60000 },
  () => {
    let app: INestApplication<App>;
    let prisma: PrismaService;
    const emails: string[] = [];
    const server = () => app.getHttpServer();

    beforeAll(async () => {
      process.env.FRONTEND_URL = 'http://frontend.test';
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      app = moduleFixture.createNestApplication();
      app.use(cookieParser(app.get(ConfigService).getOrThrow('COOKIE_SECRET')));
      app.setGlobalPrefix('api');
      app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
      app.useGlobalPipes(createGlobalValidationPipe());
      await app.init();
      prisma = app.get(PrismaService);
    });

    afterAll(async () => {
      // Token issuance + mail run in the background: let them land first.
      await new Promise((r) => setTimeout(r, 1000));
      const ids = (
        await prisma.customer.findMany({
          where: { email: { in: emails } },
          select: { id: true },
        })
      ).map((c) => c.id);
      await prisma.customerVerification.deleteMany({
        where: { value: { in: ids } },
      });
      await prisma.customer.deleteMany({ where: { email: { in: emails } } });
      for (const e of emails) await clearMailsTo(e);
      await app.close();
    });

    /** Direct insert (no HTTP -> no throttle budget used, no register floor). */
    async function mkCustomer(k: string, emailVerified: boolean) {
      const email = emailOf(k);
      emails.push(email);
      const c = await prisma.customer.create({
        data: { email, name: 'Resend Tester', emailVerified },
      });
      await clearMailsTo(email);
      return { email, id: c.id };
    }

    const resend = (body: Record<string, unknown>) =>
      request(server()).post('/api/v1/auth/resend-verification').send(body);
    const pending = (id: string) =>
      prisma.customerVerification.count({
        where: { value: id, identifier: { startsWith: 'email-verification:' } },
      });

    it('generic 200 for unknown / verified / unverified; only unverified gets a new mail; old tokens invalidated; strict body; 429 on the 6th', async () => {
      const unverified = await mkCustomer('unv', false);
      const verified = await mkCustomer('ver', true);
      const ghost = emailOf('ghost');
      emails.push(ghost);
      await clearMailsTo(ghost);

      const svc = app.get(CustomerAuthService);
      // First (old) token comes from a first resend through the service.
      await svc.resendVerification(unverified.email);
      const [first] = await waitForVerificationMails(unverified.email, 1);
      const oldToken = tokenOf(first);
      expect(await pending(unverified.id)).toBe(1);

      // 1..3: HTTP, the three branches -> identical status and body.
      const bodies: unknown[] = [];
      for (const email of [ghost, verified.email, unverified.email]) {
        const res = await resend({ email }).expect(200);
        bodies.push(res.body);
      }
      expect(bodies[0]).toEqual({ message: GENERIC });
      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);

      // Only the unverified account got a NEW mail.
      const mails = await waitForVerificationMails(unverified.email, 2);
      expect(mails).toHaveLength(2);
      await new Promise((r) => setTimeout(r, 300));
      expect(await mailsTo(ghost)).toHaveLength(0);
      expect(await mailsTo(verified.email)).toHaveLength(0);

      // Exactly one live token; the previous unused one no longer works.
      expect(await pending(unverified.id)).toBe(1);
      const newMail = mails.find((m) => tokenOf(m) !== oldToken) as Mail;
      const newToken = tokenOf(newMail);
      await request(server())
        .post('/api/v1/auth/verify-email')
        .send({ token: oldToken })
        .expect(400)
        .expect((r) =>
          expect((r.body as { errorCode: string }).errorCode).toBe(
            'INVALID_VERIFICATION_TOKEN',
          ),
        );
      await request(server())
        .post('/api/v1/auth/verify-email')
        .send({ token: newToken })
        .expect(200);
      expect(
        (
          await prisma.customer.findUniqueOrThrow({
            where: { id: unverified.id },
          })
        ).emailVerified,
      ).toBe(true);

      // 4: strict body / invalid email -> 400 (counts toward the throttle).
      await resend({ email: ghost, extra: 1 }).expect(400);
      // 5: ok, 6: throttled (shared 5/IP/10min budget).
      await resend({ email: ghost }).expect(200);
      await resend({ email: ghost }).expect(429);
    });

    it('concurrent resends leave exactly one live token', async () => {
      const c = await mkCustomer('conc', false);
      const svc = app.get(CustomerAuthService);
      await Promise.all(
        Array.from({ length: 6 }, () => svc.resendVerification(c.email)),
      );
      await waitForVerificationMails(c.email, 6);
      expect(await pending(c.id)).toBe(1);
    });

    it('timing: >=40 service-level samples per branch show no oracle', async () => {
      const unverified = await mkCustomer('t-unv', false);
      const verified = await mkCustomer('t-ver', true);
      const ghost = emailOf('t-ghost');
      const svc = app.get(CustomerAuthService);
      const N = 40;
      const samples: Record<string, number[]> = {
        unknown: [],
        verified: [],
        unverified: [],
      };
      const target: Record<string, string> = {
        unknown: ghost,
        verified: verified.email,
        unverified: unverified.email,
      };
      // Interleaved in a rotating order (no position bias); round 0 = warm-up.
      for (let i = 0; i <= N; i++) {
        const order = ['unverified', 'unknown', 'verified'];
        order.push(...order.splice(0, i % 3));
        for (const branch of order) {
          const t = performance.now();
          await svc.resendVerification(target[branch]);
          if (i > 0) samples[branch].push(performance.now() - t);
        }
      }
      const med = Object.fromEntries(
        Object.entries(samples).map(([k, v]) => [k, median(v)]),
      );
      process.stdout.write(
        `[AC11 timing] n=${N}/branch median ms: ${JSON.stringify(
          Object.fromEntries(
            Object.entries(med).map(([k, v]) => [k, +v.toFixed(2)]),
          ),
        )} max ms: ${JSON.stringify(
          Object.fromEntries(
            Object.entries(samples).map(([k, v]) => [
              k,
              +Math.max(...v).toFixed(2),
            ]),
          ),
        )}\n`,
      );
      expect(samples.unknown).toHaveLength(N);
      const meds = Object.values(med);
      // The only awaited work is the same single lookup: medians agree.
      expect(Math.max(...meds) - Math.min(...meds)).toBeLessThan(3);
    });
  },
);
