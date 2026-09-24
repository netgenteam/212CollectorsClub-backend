import { randomBytes, createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  PROOF_OF_PAYMENT_DIR,
  UPLOADS_PRIVATE_ROOT,
} from './../src/orders/upload-paths.constants.js';

type App = Parameters<typeof request>[0];

interface ProofOfPaymentDto {
  id: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
}

interface ProofOfPaymentStatusResponse {
  hasProofOfPayment: boolean;
  latestProofOfPayment: ProofOfPaymentDto | null;
}

interface ApiErrorBody {
  errorCode?: string;
}

/**
 * Story 4.2 e2e suite. Deliberately does NOT drive a real Story 4.1
 * checkout to obtain its Order/token fixtures (unlike checkout.e2e-spec.ts)
 * — every seeded catalog Product is already claimed by an existing
 * *.e2e-spec.ts file's own Product.stock/heldQty mutations (see that
 * file's own comment on cross-file flakiness under Vitest's parallel file
 * execution), and this story's own scope is the upload endpoint itself,
 * not checkout. Instead, an Order fixture is created directly via Prisma
 * with a real raw token hashed the EXACT SAME way `CheckoutService` does
 * (`SHA-256` hex, matching `hashOrderAccessToken` — see
 * `src/common/order-access-token.ts`), which exercises
 * `OrderAccessTokenGuard` against a real DB row exactly as it would see a
 * genuine checkout-issued Order. A full real-checkout-then-upload flow is
 * additionally verified once, by hand, via the live `curl` check in the
 * Dev report (not duplicated here to avoid the catalog-contention risk
 * above).
 */
describe('ProofOfPaymentController (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();

    const configService = app.get(ConfigService);
    app.use(cookieParser(configService.getOrThrow<string>('COOKIE_SECRET')));
    app.setGlobalPrefix('api');
    app.enableVersioning({
      type: VersioningType.URI,
      defaultVersion: '1',
    });
    app.useGlobalPipes(createGlobalValidationPipe());

    await app.init();
    prisma = app.get(PrismaService);
  });

  afterEach(async () => {
    await app.close();
  });

  /** Creates a real Order row (bypassing checkout/cart entirely — see the
   * suite's own doc comment) with a real orderAccessToken hashed the same
   * way CheckoutService does, returning both. */
  async function createTestOrder(
    overrides: { status?: string } = {},
  ): Promise<{ orderId: string; rawToken: string }> {
    const rawToken = randomBytes(32).toString('hex');
    const accessTokenHash = createHash('sha256').update(rawToken).digest('hex');
    const order = await prisma.order.create({
      data: {
        status: (overrides.status ?? 'PENDING_VERIFICATION') as never,
        paymentRail: 'PAGO_MOVIL' as never,
        fulfillmentType: 'PICKUP' as never,
        recipientName: 'Proof Of Payment Test Buyer',
        recipientPhone: '0412-0000000',
        totalUsd: '10.00' as never,
        accessTokenHash,
      },
    });
    return { orderId: order.id, rawToken };
  }

  /** Deletes the Order (cascades to ProofOfPayment via onDelete: Cascade)
   * and, if a ProofOfPayment file was actually written to disk, removes it
   * too — this suite's disk footprint should never outlive a test. */
  async function cleanupOrder(orderId: string): Promise<void> {
    const rows = await prisma.proofOfPayment.findMany({ where: { orderId } });
    await prisma.order
      .delete({ where: { id: orderId } })
      .catch(() => undefined);
    for (const row of rows) {
      const absolutePath = join(UPLOADS_PRIVATE_ROOT, row.filePath);
      await import('node:fs/promises').then((fs) =>
        fs.unlink(absolutePath).catch(() => undefined),
      );
    }
  }

  async function listProofOfPaymentFiles(): Promise<string[]> {
    try {
      return await readdir(PROOF_OF_PAYMENT_DIR);
    } catch {
      return [];
    }
  }

  const VALID_PNG_BUFFER = Buffer.from('fake-png-bytes-for-testing');

  describe('POST /api/v1/orders/:orderId/proof-of-payment', () => {
    it('valid token: stores the file under uploads/private/proof-of-payment/ and creates a ProofOfPayment row', async () => {
      const { orderId, rawToken } = await createTestOrder();

      try {
        const res = await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/proof-of-payment`)
          .set('Authorization', `Bearer ${rawToken}`)
          .attach('file', VALID_PNG_BUFFER, {
            filename: 'transferencia.png',
            contentType: 'image/png',
          })
          .expect(201);

        const body = res.body as ProofOfPaymentStatusResponse;
        if (!body.hasProofOfPayment || !body.latestProofOfPayment) {
          throw new Error(
            `Expected a created proof, got: ${JSON.stringify(body)}`,
          );
        }
        if (body.latestProofOfPayment.mimeType !== 'image/png') {
          throw new Error(`Unexpected mimeType: ${JSON.stringify(body)}`);
        }

        const row = await prisma.proofOfPayment.findUniqueOrThrow({
          where: { id: body.latestProofOfPayment.id },
        });
        if (row.orderId !== orderId || row.mimeType !== 'image/png') {
          throw new Error(
            `Unexpected ProofOfPayment row: ${JSON.stringify(row)}`,
          );
        }
        if (!row.filePath.startsWith('proof-of-payment/')) {
          throw new Error(`Unexpected filePath: ${row.filePath}`);
        }
        // The client's original filename never appears in the stored path.
        if (row.filePath.includes('transferencia')) {
          throw new Error(
            `filePath must never contain the client-supplied filename: ${row.filePath}`,
          );
        }

        // The file genuinely exists on disk under uploads/private/.
        const absolutePath = join(UPLOADS_PRIVATE_ROOT, row.filePath);
        const stats = await stat(absolutePath);
        if (!stats.isFile() || stats.size !== VALID_PNG_BUFFER.length) {
          throw new Error(`Expected a real file of the uploaded size on disk`);
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('401 MISSING_ORDER_ACCESS_TOKEN when there is no Authorization header at all, and creates nothing', async () => {
      const { orderId } = await createTestOrder();

      try {
        await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/proof-of-payment`)
          .attach('file', VALID_PNG_BUFFER, {
            filename: 'proof.png',
            contentType: 'image/png',
          })
          .expect(401)
          .expect((res) => {
            const body = res.body as ApiErrorBody;
            if (body.errorCode !== 'MISSING_ORDER_ACCESS_TOKEN') {
              throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
            }
          });

        const count = await prisma.proofOfPayment.count({ where: { orderId } });
        if (count !== 0) {
          throw new Error(
            'Expected no ProofOfPayment row on a missing-token request',
          );
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('401 INVALID_ORDER_ACCESS_TOKEN when the token is simply wrong, and creates nothing', async () => {
      const { orderId } = await createTestOrder();

      try {
        await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/proof-of-payment`)
          .set('Authorization', 'Bearer this-is-not-the-right-token')
          .attach('file', VALID_PNG_BUFFER, {
            filename: 'proof.png',
            contentType: 'image/png',
          })
          .expect(401)
          .expect((res) => {
            const body = res.body as ApiErrorBody;
            if (body.errorCode !== 'INVALID_ORDER_ACCESS_TOKEN') {
              throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
            }
          });

        const count = await prisma.proofOfPayment.count({ where: { orderId } });
        if (count !== 0) {
          throw new Error(
            'Expected no ProofOfPayment row on a wrong-token request',
          );
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('401 INVALID_ORDER_ACCESS_TOKEN when the token is valid, but for a DIFFERENT Order, and creates nothing on either Order', async () => {
      const orderA = await createTestOrder();
      const orderB = await createTestOrder();

      try {
        await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderA.orderId}/proof-of-payment`)
          .set('Authorization', `Bearer ${orderB.rawToken}`)
          .attach('file', VALID_PNG_BUFFER, {
            filename: 'proof.png',
            contentType: 'image/png',
          })
          .expect(401)
          .expect((res) => {
            const body = res.body as ApiErrorBody;
            if (body.errorCode !== 'INVALID_ORDER_ACCESS_TOKEN') {
              throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
            }
          });

        const [countA, countB] = await Promise.all([
          prisma.proofOfPayment.count({ where: { orderId: orderA.orderId } }),
          prisma.proofOfPayment.count({ where: { orderId: orderB.orderId } }),
        ]);
        if (countA !== 0 || countB !== 0) {
          throw new Error('Expected no ProofOfPayment row on either Order');
        }
      } finally {
        await cleanupOrder(orderA.orderId);
        await cleanupOrder(orderB.orderId);
      }
    });

    it('400 UNSUPPORTED_FILE_TYPE when the MIME type is outside the allowlist, and writes no file to disk', async () => {
      const { orderId, rawToken } = await createTestOrder();

      try {
        const before = await listProofOfPaymentFiles();

        await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/proof-of-payment`)
          .set('Authorization', `Bearer ${rawToken}`)
          .attach('file', Buffer.from('not an image'), {
            filename: 'note.txt',
            contentType: 'text/plain',
          })
          .expect(400)
          .expect((res) => {
            const body = res.body as ApiErrorBody;
            if (body.errorCode !== 'UNSUPPORTED_FILE_TYPE') {
              throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
            }
          });

        const after = await listProofOfPaymentFiles();
        if (after.length !== before.length) {
          throw new Error(
            `Expected no new file on disk for a rejected MIME type: before=${before.length} after=${after.length}`,
          );
        }
        const count = await prisma.proofOfPayment.count({ where: { orderId } });
        if (count !== 0) {
          throw new Error(
            'Expected no ProofOfPayment row for a rejected MIME type',
          );
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it("413 when the file exceeds the configured maximum size (Nest's own FileInterceptor translates multer's LIMIT_FILE_SIZE into a typed PayloadTooLargeException — see ProofOfPaymentController's doc comment)", async () => {
      const { orderId, rawToken } = await createTestOrder();
      const oversizedBuffer = Buffer.alloc(10 * 1024 * 1024 + 1024, 1); // 10 MiB + 1 KiB

      try {
        await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/proof-of-payment`)
          .set('Authorization', `Bearer ${rawToken}`)
          .attach('file', oversizedBuffer, {
            filename: 'huge.png',
            contentType: 'image/png',
          })
          .expect(413)
          .expect((res) => {
            // Nest's own default exception shape here (no errorCode) — see
            // this suite's it() title.
            const body = res.body as { statusCode?: number };
            if (body.statusCode !== 413) {
              throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
            }
          });

        const count = await prisma.proofOfPayment.count({ where: { orderId } });
        if (count !== 0) {
          throw new Error(
            'Expected no ProofOfPayment row for an oversized file',
          );
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('400 FILE_REQUIRED when no file field is sent at all', async () => {
      const { orderId, rawToken } = await createTestOrder();

      try {
        await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/proof-of-payment`)
          .set('Authorization', `Bearer ${rawToken}`)
          .expect(400)
          .expect((res) => {
            const body = res.body as ApiErrorBody;
            if (body.errorCode !== 'FILE_REQUIRED') {
              throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
            }
          });
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('path-traversal attempt in the client-supplied filename never escapes uploads/private/proof-of-payment/ — the server-generated name ignores it entirely', async () => {
      const { orderId, rawToken } = await createTestOrder();
      const maliciousFilename = '../../../../../../etc/passwd';

      try {
        const res = await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/proof-of-payment`)
          .set('Authorization', `Bearer ${rawToken}`)
          .attach('file', Buffer.from('attempted traversal payload'), {
            filename: maliciousFilename,
            contentType: 'image/png',
          })
          .expect(201);

        const body = res.body as ProofOfPaymentStatusResponse;
        const row = await prisma.proofOfPayment.findUniqueOrThrow({
          where: { id: body.latestProofOfPayment!.id },
        });

        // The stored relative path never contains a traversal sequence or
        // any fragment of the malicious filename.
        if (row.filePath.includes('..') || row.filePath.includes('passwd')) {
          throw new Error(
            `filePath leaked the malicious filename/traversal: ${row.filePath}`,
          );
        }

        // The resolved absolute path is CONTAINED within
        // PROOF_OF_PAYMENT_DIR — never escapes it.
        const absolutePath = resolve(UPLOADS_PRIVATE_ROOT, row.filePath);
        if (!absolutePath.startsWith(PROOF_OF_PAYMENT_DIR + '/')) {
          throw new Error(
            `Stored file escaped the upload directory: ${absolutePath}`,
          );
        }

        // The literal traversal target the attack was aiming for was never
        // touched/created.
        const traversalTarget = resolve(
          PROOF_OF_PAYMENT_DIR,
          maliciousFilename,
        );
        if (existsSync(traversalTarget) && traversalTarget !== '/etc/passwd') {
          throw new Error(
            `A file was unexpectedly created at the traversal target: ${traversalTarget}`,
          );
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('409 ORDER_NOT_AWAITING_PROOF when the Order already left pending_verification, and deletes the already-written file (no orphan left behind)', async () => {
      const { orderId, rawToken } = await createTestOrder({ status: 'PAID' });

      try {
        const before = await listProofOfPaymentFiles();

        await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/proof-of-payment`)
          .set('Authorization', `Bearer ${rawToken}`)
          .attach('file', VALID_PNG_BUFFER, {
            filename: 'too-late.png',
            contentType: 'image/png',
          })
          .expect(409)
          .expect((res) => {
            const body = res.body as ApiErrorBody;
            if (body.errorCode !== 'ORDER_NOT_AWAITING_PROOF') {
              throw new Error(`Unexpected body: ${JSON.stringify(body)}`);
            }
          });

        const count = await prisma.proofOfPayment.count({ where: { orderId } });
        if (count !== 0) {
          throw new Error(
            'Expected no ProofOfPayment row for a non-pending Order',
          );
        }

        const after = await listProofOfPaymentFiles();
        if (after.length !== before.length) {
          throw new Error(
            `Expected the multer-written file to be cleaned up (no net new file): before=${before.length} after=${after.length}`,
          );
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });
  });

  describe('GET /api/v1/orders/:orderId/proof-of-payment', () => {
    it('returns a normal 200 (hasProofOfPayment=false, latestProofOfPayment=null) for an Order with nothing uploaded yet — never hidden, never an error', async () => {
      const { orderId, rawToken } = await createTestOrder();

      try {
        const res = await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}/proof-of-payment`)
          .set('Authorization', `Bearer ${rawToken}`)
          .expect(200);

        const body = res.body as ProofOfPaymentStatusResponse;
        if (
          body.hasProofOfPayment !== false ||
          body.latestProofOfPayment !== null
        ) {
          throw new Error(
            `Expected the pending shape, got: ${JSON.stringify(body)}`,
          );
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('returns hasProofOfPayment=true with the uploaded file metadata after a successful upload', async () => {
      const { orderId, rawToken } = await createTestOrder();

      try {
        await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/proof-of-payment`)
          .set('Authorization', `Bearer ${rawToken}`)
          .attach('file', VALID_PNG_BUFFER, {
            filename: 'proof.png',
            contentType: 'image/png',
          })
          .expect(201);

        const res = await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}/proof-of-payment`)
          .set('Authorization', `Bearer ${rawToken}`)
          .expect(200);

        const body = res.body as ProofOfPaymentStatusResponse;
        if (
          !body.hasProofOfPayment ||
          body.latestProofOfPayment?.mimeType !== 'image/png'
        ) {
          throw new Error(
            `Expected the uploaded proof reflected, got: ${JSON.stringify(body)}`,
          );
        }
      } finally {
        await cleanupOrder(orderId);
      }
    });

    it('401 when no token is presented, same as the upload route', async () => {
      const { orderId } = await createTestOrder();

      try {
        await request(app.getHttpServer())
          .get(`/api/v1/orders/${orderId}/proof-of-payment`)
          .expect(401);
      } finally {
        await cleanupOrder(orderId);
      }
    });
  });

  describe('never publicly reachable (AD-12 / NFR-5)', () => {
    it('the uploaded file is not reachable through any static-serve path — a direct GET where it lives on disk 404s', async () => {
      const { orderId, rawToken } = await createTestOrder();

      try {
        const res = await request(app.getHttpServer())
          .post(`/api/v1/orders/${orderId}/proof-of-payment`)
          .set('Authorization', `Bearer ${rawToken}`)
          .attach('file', VALID_PNG_BUFFER, {
            filename: 'proof.png',
            contentType: 'image/png',
          })
          .expect(201);

        const body = res.body as ProofOfPaymentStatusResponse;
        const row = await prisma.proofOfPayment.findUniqueOrThrow({
          where: { id: body.latestProofOfPayment!.id },
        });

        // Neither an unversioned static-root guess, nor one nested under
        // the API's own prefix, ever resolves — there is no
        // ServeStaticModule/useStaticAssets root registered at all.
        await request(app.getHttpServer())
          .get(`/uploads/private/${row.filePath}`)
          .expect(404);
        await request(app.getHttpServer())
          .get(`/api/v1/uploads/private/${row.filePath}`)
          .expect(404);
      } finally {
        await cleanupOrder(orderId);
      }
    });
  });
});
