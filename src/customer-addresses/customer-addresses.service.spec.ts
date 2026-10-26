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

const U1 = '11111111-1111-4111-8111-111111111111';

function buildWrite(opts: {
  row?: Record<string, unknown> | null;
  next?: { id: string } | null;
  updateImpl?: () => Promise<unknown>;
}) {
  const row =
    opts.row === undefined
      ? {
          id: U1,
          agencyId: 'ag',
          label: null,
          recipientName: 'Maria',
          recipientPhone: '+584121234567',
          recipientIdDoc: 'V-12345678',
          deliveryMode: 'HOME_DELIVERY',
          agencyBranchName: null,
          agencyBranchCode: null,
          state: 'Miranda',
          municipality: 'Baruta',
          parish: null,
          addressLine1: 'Calle 1',
          addressLine2: null,
          referencePoint: null,
          isDefault: true,
        }
      : opts.row;
  const full = {
    ...row,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const ca = {
    findFirst: vi
      .fn()
      .mockImplementation((a: { where: { id?: string } }) =>
        Promise.resolve(a.where.id ? row : (opts.next ?? null)),
      ),
    findUniqueOrThrow: vi.fn().mockResolvedValue(full),
    update: vi.fn(opts.updateImpl ?? (() => Promise.resolve(full))),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    delete: vi.fn().mockResolvedValue({}),
  };
  const tx = { $queryRaw: vi.fn().mockResolvedValue([]), customerAddress: ca };
  const prisma = { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) };
  const assert = vi.fn().mockResolvedValue({});
  const svc = new CustomerAddressesService(
    prisma as never,
    { assertAgencyUsable: assert } as never,
  );
  return { svc, ca, tx, assert };
}

describe('CustomerAddressesService.update', () => {
  it('404 for missing/foreign/non-uuid ids', async () => {
    const a = buildWrite({ row: null });
    expect(await code(a.svc.update('c', U1, { state: 'X' }))).toBe(
      'ADDRESS_NOT_FOUND',
    );
    const b = buildWrite({});
    expect(await code(b.svc.update('c', 'nope', { state: 'X' }))).toBe(
      'ADDRESS_NOT_FOUND',
    );
    expect(b.ca.findFirst).not.toHaveBeenCalled();
  });

  it('empty patch -> 400', async () => {
    const { svc } = buildWrite({});
    expect(await code(svc.update('c', U1, {}))).toBe('EMPTY_UPDATE');
  });

  it('merged result is validated: switching to agency_office needs a branch', async () => {
    const { svc, ca } = buildWrite({});
    expect(
      await code(svc.update('c', U1, { deliveryMode: 'agency_office' })),
    ).toBe('SHIPPING_INVALID');
    expect(ca.update).not.toHaveBeenCalled();
  });

  it('agencyId: null -> SHIPPING_INVALID {agencyId, REQUIRED}', async () => {
    const { svc, ca } = buildWrite({});
    await expect(
      svc.update('c', U1, { agencyId: null as unknown as string }),
    ).rejects.toMatchObject({
      response: {
        errorCode: 'SHIPPING_INVALID',
        details: { errors: [{ field: 'agencyId', code: 'REQUIRED' }] },
      },
    });
    expect(ca.update).not.toHaveBeenCalled();
  });

  it('agency activity only required when agencyId is sent (A52)', async () => {
    const a = buildWrite({});
    await a.svc.update('c', U1, { state: 'Zulia' });
    expect(a.assert).toHaveBeenCalledWith(
      'ag',
      'home_delivery',
      { requireActive: false },
      a.tx,
    );
    const b = buildWrite({});
    await b.svc.update('c', U1, { agencyId: U1 });
    expect(b.assert).toHaveBeenCalledWith(
      U1,
      'home_delivery',
      { requireActive: true },
      b.tx,
    );
  });

  it('never writes isDefault', async () => {
    const { svc, ca } = buildWrite({});
    await svc.update('c', U1, { state: 'Zulia' });
    const data = (
      ca.update.mock.calls[0][0] as { data: Record<string, unknown> }
    ).data;
    expect(data).not.toHaveProperty('isDefault');
    expect(data).toMatchObject({
      state: 'Zulia',
      recipientIdDoc: 'V-12345678',
    });
  });
});

describe('CustomerAddressesService.setDefault', () => {
  it('clears others then sets, under the customer lock', async () => {
    const { svc, ca, tx } = buildWrite({
      row: { id: U1, isDefault: false, deliveryMode: 'HOME_DELIVERY' },
    });
    await svc.setDefault('c', U1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(ca.updateMany).toHaveBeenCalledWith({
      where: { customerId: 'c', isDefault: true },
      data: { isDefault: false },
    });
    expect(ca.update).toHaveBeenCalledWith({
      where: { id: U1 },
      data: { isDefault: true },
    });
  });

  it('already default -> no writes', async () => {
    const { svc, ca } = buildWrite({});
    await svc.setDefault('c', U1);
    expect(ca.updateMany).not.toHaveBeenCalled();
    expect(ca.update).not.toHaveBeenCalled();
  });

  it('P2002 retried once, persistent -> 409', async () => {
    let n = 0;
    const a = buildWrite({
      row: { id: U1, isDefault: false, deliveryMode: 'HOME_DELIVERY' },
      updateImpl: () =>
        n++ === 0 ? Promise.reject(p2002()) : Promise.resolve({}),
    });
    await expect(a.svc.setDefault('c', U1)).resolves.toBeDefined();
    const b = buildWrite({
      row: { id: U1, isDefault: false, deliveryMode: 'HOME_DELIVERY' },
      updateImpl: () => Promise.reject(p2002()),
    });
    expect(await code(b.svc.setDefault('c', U1))).toBe(
      'ADDRESS_DEFAULT_CONFLICT',
    );
    expect(b.ca.update).toHaveBeenCalledTimes(2);
  });
});

describe('CustomerAddressesService.remove', () => {
  it('deleting the default promotes the most recent remaining', async () => {
    const { svc, ca } = buildWrite({ next: { id: 'n1' } });
    await svc.remove('c', U1);
    expect(ca.findFirst).toHaveBeenLastCalledWith({
      where: { customerId: 'c' },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(ca.update).toHaveBeenCalledWith({
      where: { id: 'n1' },
      data: { isDefault: true },
    });
  });

  it('deleting a non-default or the last one promotes nobody', async () => {
    const a = buildWrite({ row: { id: U1, isDefault: false } });
    await a.svc.remove('c', U1);
    expect(a.ca.update).not.toHaveBeenCalled();
    const b = buildWrite({ next: null });
    await b.svc.remove('c', U1);
    expect(b.ca.update).not.toHaveBeenCalled();
  });

  it('404 when not owned', async () => {
    const { svc, ca } = buildWrite({ row: null });
    expect(await code(svc.remove('c', U1))).toBe('ADDRESS_NOT_FOUND');
    expect(ca.delete).not.toHaveBeenCalled();
  });
});
