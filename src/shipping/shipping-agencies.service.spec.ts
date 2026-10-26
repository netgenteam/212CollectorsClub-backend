import { ApiException } from '../common/api-exception.js';
import { ShippingAgenciesService } from './shipping-agencies.service.js';

const base = {
  id: 'a',
  name: 'MRW',
  code: 'MRW',
  isActive: true,
  allowsOfficePickup: true,
  allowsHomeDelivery: true,
  trackingUrlTemplate: null,
  sortOrder: 1,
};

function build(current: typeof base | null) {
  const update = vi.fn((args: { data: object }) =>
    Promise.resolve({ ...base, ...args.data }),
  );
  const tx = {
    shippingAgency: {
      findUnique: vi.fn().mockResolvedValue(current),
      update,
    },
  };
  const prisma = {
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  const service = new ShippingAgenciesService(prisma as never);
  return { service, update };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return ((e as ApiException).getResponse() as { errorCode: string })
      .errorCode;
  }
  return 'NO_ERROR';
}

describe('ShippingAgenciesService.update', () => {
  it('updates only the provided fields', async () => {
    const { service, update } = build(base);
    await service.update('a', { name: 'MRW Express' });
    expect(update.mock.calls[0][0].data).toEqual({ name: 'MRW Express' });
  });

  it('null clears the tracking template', async () => {
    const { service, update } = build(base);
    await service.update('a', { trackingUrlTemplate: null });
    expect(update.mock.calls[0][0].data).toEqual({ trackingUrlTemplate: null });
  });

  it('rejects an empty body', async () => {
    const { service } = build(base);
    expect(await codeOf(service.update('a', {}))).toBe(
      'SHIPPING_AGENCY_EMPTY_UPDATE',
    );
  });

  it('rejects an invalid template', async () => {
    const { service } = build(base);
    expect(
      await codeOf(
        service.update('a', {
          trackingUrlTemplate: 'http://x/{trackingNumber}',
        }),
      ),
    ).toBe('TRACKING_TEMPLATE_INVALID');
  });

  it('404 when missing', async () => {
    const { service } = build(null);
    expect(await codeOf(service.update('a', { name: 'x' }))).toBe(
      'SHIPPING_AGENCY_NOT_FOUND',
    );
  });

  it('422 when an active agency would allow no mode', async () => {
    const { service } = build({ ...base, allowsHomeDelivery: false });
    expect(
      await codeOf(service.update('a', { allowsOfficePickup: false })),
    ).toBe('AGENCY_WITHOUT_DELIVERY_MODE');
  });

  it('allows an inactive agency with no modes', async () => {
    const { service, update } = build(base);
    await service.update('a', {
      isActive: false,
      allowsOfficePickup: false,
      allowsHomeDelivery: false,
    });
    expect(update).toHaveBeenCalled();
  });
});

describe('ShippingAgenciesService.create/remove', () => {
  it('maps P2002 on create to 409 SHIPPING_AGENCY_CODE_TAKEN', async () => {
    const { Prisma } = await import('../generated/prisma/client.js');
    const err = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
    });
    const prisma = {
      shippingAgency: { create: vi.fn().mockRejectedValue(err) },
    };
    const service = new ShippingAgenciesService(prisma as never);
    expect(await codeOf(service.create({ name: 'A', code: 'AA' }))).toBe(
      'SHIPPING_AGENCY_CODE_TAKEN',
    );
  });

  it('refuses to delete an agency in use', async () => {
    const tx = {
      shippingAgency: {
        findUnique: vi.fn().mockResolvedValue({ id: 'a' }),
        delete: vi.fn(),
      },
      customerAddress: { count: vi.fn().mockResolvedValue(1) },
      order: { count: vi.fn().mockResolvedValue(0) },
    };
    const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
    const service = new ShippingAgenciesService(prisma as never);
    expect(await codeOf(service.remove('a'))).toBe('SHIPPING_AGENCY_IN_USE');
    expect(tx.shippingAgency.delete).not.toHaveBeenCalled();
  });
});
