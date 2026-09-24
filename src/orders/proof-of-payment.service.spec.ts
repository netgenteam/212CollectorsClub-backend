import { join } from 'node:path';
import { ProofOfPaymentService } from './proof-of-payment.service.js';
import { OrderStatus } from '../generated/prisma/enums.js';
import type { Order } from '../generated/prisma/client.js';
import { PROOF_OF_PAYMENT_SUBDIR } from './upload-paths.constants.js';

const unlinkMock = vi.fn().mockResolvedValue(undefined);
vi.mock('node:fs/promises', () => ({
  unlink: (...args: unknown[]) =>
    (unlinkMock as (...a: unknown[]) => unknown)(...args),
}));

function buildOrder(
  overrides: Partial<{ id: string; status: OrderStatus }> = {},
): Order {
  return {
    id: overrides.id ?? 'order-1',
    status: overrides.status ?? OrderStatus.PENDING_VERIFICATION,
  } as unknown as Order;
}

function buildFile(
  overrides: Partial<Express.Multer.File> = {},
): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname: '../../etc/passwd',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 12345,
    destination: '/tmp/uploads/private/proof-of-payment',
    filename: 'generated-uuid.png',
    path: '/tmp/uploads/private/proof-of-payment/generated-uuid.png',
    buffer: Buffer.from(''),
    stream: undefined as never,
    ...overrides,
  };
}

describe('ProofOfPaymentService', () => {
  let prisma: {
    proofOfPayment: {
      create: ReturnType<typeof vi.fn>;
      findFirst: ReturnType<typeof vi.fn>;
    };
  };
  let service: ProofOfPaymentService;

  beforeEach(() => {
    unlinkMock.mockClear();
    prisma = {
      proofOfPayment: { create: vi.fn(), findFirst: vi.fn() },
    };
    service = new ProofOfPaymentService(prisma as never);
  });

  describe('recordUpload', () => {
    it('creates a ProofOfPayment row with a filePath relative to uploads/private/ built from the SERVER-generated filename, never the client originalname', async () => {
      const order = buildOrder();
      const file = buildFile();
      const createdRow = {
        id: 'pop-1',
        orderId: order.id,
        filePath: join(PROOF_OF_PAYMENT_SUBDIR, file.filename),
        mimeType: file.mimetype,
        sizeBytes: file.size,
        createdAt: new Date('2026-09-24T00:00:00.000Z'),
      };
      prisma.proofOfPayment.create.mockResolvedValue(createdRow);

      const result = await service.recordUpload(order, file);

      expect(prisma.proofOfPayment.create).toHaveBeenCalledWith({
        data: {
          orderId: order.id,
          filePath: join(PROOF_OF_PAYMENT_SUBDIR, 'generated-uuid.png'),
          mimeType: 'image/png',
          sizeBytes: 12345,
        },
      });
      // The client's path-traversal attempt (`../../etc/passwd` as
      // originalname) never appears anywhere in what was persisted.
      const createArg = prisma.proofOfPayment.create.mock.calls[0][0] as {
        data: { filePath: string };
      };
      expect(createArg.data.filePath).not.toContain('..');
      expect(createArg.data.filePath).not.toContain('passwd');
      expect(unlinkMock).not.toHaveBeenCalled();
      expect(result).toEqual({
        hasProofOfPayment: true,
        latestProofOfPayment: {
          id: 'pop-1',
          mimeType: 'image/png',
          sizeBytes: 12345,
          createdAt: '2026-09-24T00:00:00.000Z',
        },
      });
    });

    it.each([
      OrderStatus.PAID,
      OrderStatus.PAYMENT_REJECTED,
      OrderStatus.EXPIRED,
      OrderStatus.CANCELLED,
      OrderStatus.FULFILLED,
    ])(
      'rejects with 409 ORDER_NOT_AWAITING_PROOF and deletes the already-written file, creating NO row, when Order.status=%s',
      async (status) => {
        const order = buildOrder({ status });
        const file = buildFile();

        await expect(service.recordUpload(order, file)).rejects.toMatchObject({
          status: 409,
          response: { errorCode: 'ORDER_NOT_AWAITING_PROOF' },
        });

        expect(prisma.proofOfPayment.create).not.toHaveBeenCalled();
        expect(unlinkMock).toHaveBeenCalledWith(file.path);
      },
    );

    it('still rejects with 409 even if the best-effort disk cleanup itself fails (never surfaces a second error)', async () => {
      unlinkMock.mockRejectedValueOnce(new Error('ENOENT'));
      const order = buildOrder({ status: OrderStatus.PAID });
      const file = buildFile();

      await expect(service.recordUpload(order, file)).rejects.toMatchObject({
        status: 409,
        response: { errorCode: 'ORDER_NOT_AWAITING_PROOF' },
      });
    });
  });

  describe('getStatus', () => {
    it('returns hasProofOfPayment=false and latestProofOfPayment=null (a normal 200 shape, never an error) when nothing has been uploaded yet', async () => {
      prisma.proofOfPayment.findFirst.mockResolvedValue(null);

      const result = await service.getStatus('order-1');

      expect(result).toEqual({
        hasProofOfPayment: false,
        latestProofOfPayment: null,
      });
    });

    it('returns the most recent ProofOfPayment (queried ordered by createdAt desc) when one exists', async () => {
      prisma.proofOfPayment.findFirst.mockResolvedValue({
        id: 'pop-2',
        mimeType: 'application/pdf',
        sizeBytes: 999,
        createdAt: new Date('2026-09-24T12:00:00.000Z'),
      });

      const result = await service.getStatus('order-1');

      expect(prisma.proofOfPayment.findFirst).toHaveBeenCalledWith({
        where: { orderId: 'order-1' },
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toEqual({
        hasProofOfPayment: true,
        latestProofOfPayment: {
          id: 'pop-2',
          mimeType: 'application/pdf',
          sizeBytes: 999,
          createdAt: '2026-09-24T12:00:00.000Z',
        },
      });
    });
  });
});
