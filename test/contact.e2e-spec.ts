import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

type App = Parameters<typeof request>[0];

interface ContactInquiryResponse {
  id: string;
  createdAt: string;
}

interface BadRequestBody {
  statusCode: number;
  error: string;
  message: unknown;
}

// Seeded Products (Story 1.4, prisma/seed.ts), read-only here — same
// reasoning as cart.e2e-spec.ts/products.e2e-spec.ts reusing seed rows
// rather than throwaway fixtures. Distinct from the ids cart.e2e-spec.ts
// mutates, so a parallel run can't race against those.
const LUFFY_LEADER_ID = '76f4d753-8142-417e-ba0f-f0c426369a8d';
const NONEXISTENT_PRODUCT_ID = '00000000-0000-0000-0000-000000000000';

// Story 6.1: this file relies on a REAL SMTP test server (MailHog) at
// SMTP_HOST/SMTP_PORT (see .env) being reachable for the "email actually
// sent" tests — same server the story's live curl verification uses. The
// "persists despite SMTP failure" test below builds its own isolated app
// with a deliberately unreachable SMTP target instead, so it doesn't
// depend on MailHog being down.
const MAILHOG_API_BASE = 'http://localhost:8025';

async function mailhogMessagesTo(email: string): Promise<unknown[]> {
  const res = await fetch(`${MAILHOG_API_BASE}/api/v2/messages?limit=50`);
  if (!res.ok) {
    throw new Error(`MailHog API returned ${res.status}`);
  }
  const body = (await res.json()) as {
    items: { To: { Mailbox: string; Domain: string }[] }[];
  };
  const [mailbox, domain] = email.split('@');
  return body.items.filter((item) =>
    item.To.some((to) => to.Mailbox === mailbox && to.Domain === domain),
  );
}

describe('ContactController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestExpressApplication>();

    // Mirrors main.ts bootstrap, including Story 6.1's `trust proxy`
    // setting — without it every supertest request looks like it comes
    // from the same loopback address and the per-IP rate-limit tests below
    // (which simulate distinct IPs via X-Forwarded-For) couldn't work.
    (app as unknown as NestExpressApplication).set('trust proxy', 1);
    const configService = app.get(ConfigService);
    app.use(cookieParser(configService.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    app.useGlobalPipes(createGlobalValidationPipe());

    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  function validPayload(overrides: Record<string, unknown> = {}) {
    return {
      name: 'Maria Perez',
      email: `maria+${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
      message: 'Is this card still available in near-mint condition?',
      ...overrides,
    };
  }

  it('POST /api/v1/contact with a valid submission persists the ContactInquiry, attempts the admin email against the real MailHog test server, and returns 201 (FR-18)', async () => {
    const payload = validPayload();

    const res = await request(app.getHttpServer())
      .post('/api/v1/contact')
      .send(payload)
      .expect(201);

    const body = res.body as ContactInquiryResponse;
    if (!body.id || !body.createdAt) {
      throw new Error(
        `Expected id + createdAt in response, got: ${JSON.stringify(body)}`,
      );
    }

    const prisma = app.get(PrismaService);
    const row = await prisma.contactInquiry.findUniqueOrThrow({
      where: { id: body.id },
    });
    if (
      row.name !== payload.name ||
      row.email !== payload.email ||
      row.message !== payload.message
    ) {
      throw new Error(
        `Persisted row does not match submission: ${JSON.stringify(row)}`,
      );
    }
    // The controller awaits the full persist-then-email flow before
    // responding, so by the time 201 comes back the email attempt has
    // already resolved one way or the other — no polling needed.
    if (row.emailStatus !== 'SENT') {
      throw new Error(
        `Expected emailStatus SENT (MailHog must be running on SMTP_HOST/PORT from .env), got: ${row.emailStatus} (${row.emailErrorMessage ?? 'no error message'})`,
      );
    }

    // Real end-to-end proof the email reached the test SMTP server, not
    // just that MailerService didn't throw — queries MailHog's own API.
    const adminEmail = configServiceFrom(app).getOrThrow<string>(
      'ADMIN_CONTACT_EMAIL',
    );
    const messages = await mailhogMessagesTo(adminEmail);
    if (messages.length === 0) {
      throw new Error(
        `Expected at least one message in MailHog for ${adminEmail} — none found. Is the MailHog container running (docker ps | grep 212cc-mailhog)?`,
      );
    }
  });

  it('an optional productId that resolves to a real Product is persisted on the row', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/contact')
      .send(validPayload({ productId: LUFFY_LEADER_ID }))
      .expect(201);
    const body = res.body as ContactInquiryResponse;

    const prisma = app.get(PrismaService);
    const row = await prisma.contactInquiry.findUniqueOrThrow({
      where: { id: body.id },
    });
    if (row.productId !== LUFFY_LEADER_ID) {
      throw new Error(
        `Expected productId ${LUFFY_LEADER_ID}, got: ${row.productId}`,
      );
    }
  });

  it('a productId that does not match any existing Product still persists the inquiry (201), with productId stored as null rather than rejecting', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/contact')
      .send(validPayload({ productId: NONEXISTENT_PRODUCT_ID }))
      .expect(201);
    const body = res.body as ContactInquiryResponse;

    const prisma = app.get(PrismaService);
    const row = await prisma.contactInquiry.findUniqueOrThrow({
      where: { id: body.id },
    });
    if (row.productId !== null) {
      throw new Error(`Expected productId null, got: ${row.productId}`);
    }
  });

  it('persists the ContactInquiry (201) and marks emailStatus FAILED even when the SMTP transport is completely unreachable — the row is never lost', async () => {
    // A dedicated app instance, pointed at a host:port nothing listens on,
    // so MailerService's send genuinely fails (ECONNREFUSED) regardless of
    // whether the real MailHog container happens to be up for this run.
    const originalHost = process.env.SMTP_HOST;
    const originalPort = process.env.SMTP_PORT;
    process.env.SMTP_HOST = '127.0.0.1';
    process.env.SMTP_PORT = '1'; // nothing listens here

    let brokenApp: INestApplication<App> | undefined;
    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      brokenApp = moduleFixture.createNestApplication<NestExpressApplication>();
      (brokenApp as unknown as NestExpressApplication).set('trust proxy', 1);
      const cs = brokenApp.get(ConfigService);
      brokenApp.use(cookieParser(cs.getOrThrow<string>('COOKIE_SECRET')));
      brokenApp.setGlobalPrefix('api');
      brokenApp.enableVersioning({
        type: VersioningType.URI,
        defaultVersion: '1',
      });
      brokenApp.useGlobalPipes(createGlobalValidationPipe());
      await brokenApp.init();

      const payload = validPayload();
      const res = await request(brokenApp.getHttpServer())
        .post('/api/v1/contact')
        .send(payload)
        .expect(201);
      const body = res.body as ContactInquiryResponse;

      const prisma = brokenApp.get(PrismaService);
      const row = await prisma.contactInquiry.findUniqueOrThrow({
        where: { id: body.id },
      });
      if (row.name !== payload.name || row.email !== payload.email) {
        throw new Error(`Row not persisted correctly: ${JSON.stringify(row)}`);
      }
      if (row.emailStatus !== 'FAILED') {
        throw new Error(
          `Expected emailStatus FAILED against an unreachable SMTP host, got: ${row.emailStatus}`,
        );
      }
      if (!row.emailErrorMessage) {
        throw new Error('Expected emailErrorMessage to be recorded on failure');
      }
    } finally {
      if (brokenApp) {
        await brokenApp.close();
      }
      process.env.SMTP_HOST = originalHost;
      process.env.SMTP_PORT = originalPort;
    }
  }, 20000);

  describe('field-level validation (never a generic failure)', () => {
    it('rejects a missing name with a stable 400 shape naming the field', () => {
      return request(app.getHttpServer())
        .post('/api/v1/contact')
        .send({ email: 'a@example.com', message: 'hello' })
        .expect(400)
        .expect((res) => {
          const body = res.body as BadRequestBody;
          const messages = Array.isArray(body.message)
            ? (body.message as string[])
            : [];
          if (
            body.statusCode !== 400 ||
            body.error !== 'Bad Request' ||
            !messages.some((m) => m.toLowerCase().includes('name'))
          ) {
            throw new Error(
              `Expected a field-level 400 naming "name", got: ${JSON.stringify(body)}`,
            );
          }
        });
    });

    it('rejects a missing email with a stable 400 shape naming the field', () => {
      return request(app.getHttpServer())
        .post('/api/v1/contact')
        .send({ name: 'Maria', message: 'hello' })
        .expect(400)
        .expect((res) => {
          const body = res.body as BadRequestBody;
          const messages = Array.isArray(body.message)
            ? (body.message as string[])
            : [];
          if (!messages.some((m) => m.toLowerCase().includes('email'))) {
            throw new Error(
              `Expected a field-level 400 naming "email", got: ${JSON.stringify(body)}`,
            );
          }
        });
    });

    it('rejects a malformed email with a stable 400 shape naming the field, not a generic failure', () => {
      return request(app.getHttpServer())
        .post('/api/v1/contact')
        .send({ name: 'Maria', email: 'not-an-email', message: 'hello' })
        .expect(400)
        .expect((res) => {
          const body = res.body as BadRequestBody;
          const messages = Array.isArray(body.message)
            ? (body.message as string[])
            : [];
          if (!messages.some((m) => m.toLowerCase().includes('email'))) {
            throw new Error(
              `Expected a field-level 400 naming "email", got: ${JSON.stringify(body)}`,
            );
          }
        });
    });

    it('rejects a missing message with a stable 400 shape naming the field', () => {
      return request(app.getHttpServer())
        .post('/api/v1/contact')
        .send({ name: 'Maria', email: 'maria@example.com' })
        .expect(400)
        .expect((res) => {
          const body = res.body as BadRequestBody;
          const messages = Array.isArray(body.message)
            ? (body.message as string[])
            : [];
          if (!messages.some((m) => m.toLowerCase().includes('message'))) {
            throw new Error(
              `Expected a field-level 400 naming "message", got: ${JSON.stringify(body)}`,
            );
          }
        });
    });

    it('rejects a syntactically invalid productId with a stable 400, never a 500', () => {
      return request(app.getHttpServer())
        .post('/api/v1/contact')
        .send(validPayload({ productId: 'not-a-uuid' }))
        .expect(400);
    });
  });

  describe('rate limiting (FR-19, NFR-2: 5 requests/IP/10min)', () => {
    it('the 6th request within 10 minutes from the same IP is rejected with 429, while a different IP is unaffected', async () => {
      const sameIp = '203.0.113.10';
      const otherIp = '203.0.113.99';

      for (let i = 0; i < 5; i++) {
        await request(app.getHttpServer())
          .post('/api/v1/contact')
          .set('X-Forwarded-For', sameIp)
          .send(
            validPayload({ message: `Message #${i} from the rate-limited IP` }),
          )
          .expect(201);
      }

      // 6th request from the same IP within the window: rejected.
      await request(app.getHttpServer())
        .post('/api/v1/contact')
        .set('X-Forwarded-For', sameIp)
        .send(validPayload({ message: 'Message #6, should be throttled' }))
        .expect(429);

      // A different IP's first request in this same window is completely
      // unaffected by the other IP's exhausted budget.
      await request(app.getHttpServer())
        .post('/api/v1/contact')
        .set('X-Forwarded-For', otherIp)
        .send(validPayload({ message: 'First message from a distinct IP' }))
        .expect(201);
    }, 30000);
  });
});

function configServiceFrom(app: INestApplication<App>): ConfigService {
  return app.get(ConfigService);
}
