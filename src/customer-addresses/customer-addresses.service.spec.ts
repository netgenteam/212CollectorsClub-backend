import { Prisma } from '../generated/prisma/client.js';
import { ApiException } from '../common/api-exception.js';
import { CustomerAddressesService } from './customer-addresses.service.js';

const dto = {
  agencyId: 'a',
  deliveryMode: 'home_delivery' as const,
  recipientName: 'Maria',
  recipientPhone: '0412 123 4567',
  recipientIdDoc: 'v12345678',
  state: 'Miranda',
  municipality: 'Baruta',
  addressLine1: 'Calle 1',
};

function build(count: number, createImpl?: () => Promise<unknown>) {
  const create = vi.fn(
    createImpl ??
      (() =>
        Promise.resolve({
          id: 'x',
          deliveryMode: 'HOME_DELIVERY',
          createdAt: new Date(),
          updatedAt: new Date(),
        })),
  );
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    customerAddress: { count: vi.fn().mockResolvedValue(count), create },
  };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const assert = vi.fn().mockResolvedValue({});
  const svc = new CustomerAddressesService(
    prisma as never,
    {
      assertAgencyUsable: assert,
    } as never,
  );
  return { svc, create, assert, tx };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return ((e as ApiException).getResponse() as { errorCode: string })
      .errorCode;
  }
  return 'NO_ERROR';
};

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError('dup', {
    code: 'P2002',
    clientVersion: 'test',
  });

describe('CustomerAddressesService.create', () => {
  it('first address is default and data is normalized', async () => {
    const { svc, create, tx } = build(0);
    await svc.create('c', dto);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    const data = (create.mock.calls[0][0] as { data: Record<string, unknown> })
      .data;
    expect(data).toMatchObject({
      isDefault: true,
      recipientIdDoc: 'V-12345678',
      recipientPhone: '04121234567',
      deliveryMode: 'HOME_DELIVERY',
    });
  });

  it('subsequent address is not default', async () => {
    const { svc, create } = build(3);
    await svc.create('c', dto);
    expect(
      (create.mock.calls[0][0] as { data: { isDefault: boolean } }).data
        .isDefault,
    ).toBe(false);
  });

  it('11th address -> ADDRESS_LIMIT_REACHED', async () => {
    const { svc, create } = build(10);
    expect(await code(svc.create('c', dto))).toBe('ADDRESS_LIMIT_REACHED');
    expect(create).not.toHaveBeenCalled();
  });

  it('cross-field errors -> SHIPPING_INVALID before touching the DB', async () => {
    const { svc, tx } = build(0);
    expect(
      await code(svc.create('c', { ...dto, addressLine1: undefined })),
    ).toBe('SHIPPING_INVALID');
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('retries once on P2002, then succeeds', async () => {
    let n = 0;
    const { svc, create } = build(0, () =>
      n++ === 0
        ? Promise.reject(p2002())
        : Promise.resolve({
            id: 'x',
            deliveryMode: 'HOME_DELIVERY',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
    );
    await expect(svc.create('c', dto)).resolves.toMatchObject({ id: 'x' });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('persistent P2002 -> 409 ADDRESS_DEFAULT_CONFLICT', async () => {
    const { svc, create } = build(0, () => Promise.reject(p2002()));
    expect(await code(svc.create('c', dto))).toBe('ADDRESS_DEFAULT_CONFLICT');
    expect(create).toHaveBeenCalledTimes(2);
  });
});
