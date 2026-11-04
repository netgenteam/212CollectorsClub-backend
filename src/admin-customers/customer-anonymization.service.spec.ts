import { fakeAudit } from '../../test/helpers/fake-audit.js';
import { CustomerAnonymizationService } from './customer-anonymization.service.js';

const ID = '0b9a8a4e-6a5f-4d0d-9e3a-1c2d3e4f5a6b';
const ADMIN = '9f9f9f9f-6a5f-4d0d-9e3a-1c2d3e4f5a6b';
const EMAIL = 'ana@example.com';
const GOOD = 'Solicitud del titular por WhatsApp, ref TKT-1234, 2026-11-04';

type Mock = ReturnType<typeof vi.fn>;

describe('CustomerAnonymizationService (unit; the real locks are in test/customer-anonymize.e2e-spec.ts)', () => {
  let tx: Record<string, Record<string, Mock>> & Record<string, Mock>;
  let calls: string[];
  let service: CustomerAnonymizationService;
  let audit: ReturnType<typeof fakeAudit>;
  let selectRow: { id: string; email: string; anonymizedAt: Date | null }[];

  const run = (dto: { confirmEmail?: string; reason?: string }) =>
    service.anonymize(ADMIN, ID, dto as never);
  const code = async (p: Promise<unknown>) =>
    p.then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: {
        status: number;
        response: { errorCode: string; details?: unknown };
      }) => ({
        status: e.status,
        errorCode: e.response.errorCode,
        details: e.response.details,
      }),
    );

  beforeEach(() => {
    calls = [];
    selectRow = [{ id: ID, email: EMAIL, anonymizedAt: null }];
    const del = (name: string, count = 1) =>
      vi.fn(() => {
        calls.push(name);
        return Promise.resolve({ count });
      });
    tx = {
      order: {
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
      },
      consentRecord: { count: vi.fn().mockResolvedValue(3) },
      customerVerification: { deleteMany: del('verifications', 2) },
      customerSession: { deleteMany: del('sessions', 4) },
      customerAccount: { deleteMany: del('accounts') },
      customerAddress: { deleteMany: del('addresses', 5) },
      cart: { deleteMany: del('carts') },
      wishlist: { deleteMany: del('wishlists') },
      $executeRaw: vi.fn((strings: TemplateStringsArray) => {
        // set_config(...) of the lock budget is not a business effect
        if (strings.join('?').includes('Contact_Inquiries'))
          calls.push('inquiries');
        return Promise.resolve(2);
      }),
      $queryRaw: vi.fn((strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('FOR UPDATE')) {
          calls.push('lock');
          return Promise.resolve(selectRow);
        }
        calls.push('update');
        return Promise.resolve([
          { anonymizedAt: new Date('2026-11-04T10:00:00.000Z') },
        ]);
      }),
    } as never;
    const prisma = {
      $transaction: vi.fn((cb: (t: unknown) => unknown) => cb(tx)),
    };
    audit = fakeAudit(prisma);
    service = new CustomerAnonymizationService(prisma as never, audit, {
      hashEmail: vi.fn().mockReturnValue('h'.repeat(64)),
    } as never);
  });

  it('happy path: locks FIRST, deletes, updates, and emits ONE event with no email and no PII', async () => {
    const r = await run({ confirmEmail: '  ANA@Example.com ', reason: GOOD });
    expect(r).toMatchObject({
      customerId: ID,
      anonymizedAt: '2026-11-04T10:00:00.000Z',
      alreadyAnonymized: false,
    });
    expect(r.notices).toContain('BROWSER_LOCAL_STORAGE_NOT_ERASED');
    expect(calls[0]).toBe('lock');
    expect(calls.at(-1)).toBe('update');
    expect(audit.events).toHaveLength(1);
    const ev = audit.events[0];
    expect(ev).toMatchObject({
      actorType: 'ADMIN',
      actorId: ADMIN,
      action: 'CUSTOMER_ANONYMIZED',
      entityId: ID,
      reason: GOOD,
    });
    expect(ev.after).toMatchObject({
      emailHash: 'h'.repeat(64),
      addressesDeleted: 5,
      sessionsRevoked: 4,
      ordersRetained: 0,
    });
    expect(JSON.stringify(ev)).not.toContain('ana@example.com');
  });

  it('404 CUSTOMER_NOT_FOUND, nothing else runs', async () => {
    selectRow = [];
    expect(
      await code(run({ confirmEmail: EMAIL, reason: GOOD })),
    ).toMatchObject({
      status: 404,
      errorCode: 'CUSTOMER_NOT_FOUND',
    });
    expect(calls).toEqual(['lock']);
  });

  it('already anonymized: 200 idempotent, no effect, no event, even with a wrong confirmEmail', async () => {
    selectRow = [
      {
        id: ID,
        email: 'deleted+x@anonymized.invalid',
        anonymizedAt: new Date('2026-11-01T00:00:00.000Z'),
      },
    ];
    const r = await run({ confirmEmail: 'nope', reason: 'x' });
    expect(r).toMatchObject({
      alreadyAnonymized: true,
      anonymizedAt: '2026-11-01T00:00:00.000Z',
      notices: [],
    });
    expect(calls).toEqual(['lock']);
    expect(audit.events).toHaveLength(0);
  });

  it.each([undefined, '', 'ana@example.co', 'ANA@EXAMPLE.COMM', 'bob@x.com'])(
    'confirmEmail %j: 400 ANONYMIZE_CONFIRMATION_MISMATCH that never contains the real email',
    async (confirmEmail) => {
      const r = await code(run({ confirmEmail, reason: GOOD }));
      expect(r).toMatchObject({
        status: 400,
        errorCode: 'ANONYMIZE_CONFIRMATION_MISMATCH',
      });
      expect(JSON.stringify(r)).not.toContain('ana@');
      expect(calls).toEqual(['lock']);
    },
  );

  it.each([
    [undefined, 'ANONYMIZE_REASON_REQUIRED'],
    ['', 'ANONYMIZE_REASON_REQUIRED'],
    ['         x         ', 'ANONYMIZE_REASON_REQUIRED'],
    ['123456789', 'ANONYMIZE_REASON_REQUIRED'], // 9 < 10
    ['a'.repeat(501), 'ANONYMIZE_REASON_REQUIRED'],
    ['pidió el titular, cédula V-12345678', 'REASON_CONTAINS_ID_DOC'],
    ['pidió el titular, j123456789 por correo', 'REASON_CONTAINS_ID_DOC'],
    ['lo pidió ana@example.com por correo', 'REASON_CONTAINS_PERSONAL_DATA'],
    ['llamó desde +58 412 555 1234 pidiendo', 'REASON_CONTAINS_PERSONAL_DATA'],
  ])('reason %j -> 400 %s', async (reason, errorCode) => {
    expect(await code(run({ confirmEmail: EMAIL, reason }))).toMatchObject({
      status: 400,
      errorCode,
    });
    expect(calls).toEqual(['lock']);
    expect(audit.events).toHaveLength(0);
  });

  it('exactly 10 and exactly 500 characters are accepted (counted in code points)', async () => {
    await run({ confirmEmail: EMAIL, reason: 'a'.repeat(10) });
    await run({ confirmEmail: EMAIL, reason: '😀'.repeat(500) });
    expect(audit.events).toHaveLength(2);
  });

  it('active orders: 409 with total and the list (<= 20), NO deletes, NO event', async () => {
    tx.order.count.mockResolvedValue(25);
    tx.order.findMany.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({
        id: `o${i}`,
        status: 'PAID',
        createdAt: new Date('2026-11-01T00:00:00.000Z'),
      })),
    );
    const r = await code(run({ confirmEmail: EMAIL, reason: GOOD }));
    expect(r).toMatchObject({
      status: 409,
      errorCode: 'ACCOUNT_HAS_ACTIVE_ORDERS',
    });
    const d = r.details as {
      total: number;
      orders: { id: string; status: string }[];
    };
    expect(d.total).toBe(25);
    expect(d.orders).toHaveLength(20);
    expect(d.orders[0].status).toBe('paid');
    expect(calls).toEqual(['lock']);
    expect(audit.events).toHaveLength(0);
    const where = (
      tx.order.findMany.mock.calls[0][0] as {
        where: { status: { in: string[] } };
      }
    ).where;
    expect(where.status.in).toEqual([
      'PAYMENT_PROCESSING',
      'PENDING_VERIFICATION',
      'PAID',
    ]);
  });

  it('a lock timeout or a deadlock is 409 ANONYMIZE_BUSY (never a 500)', async () => {
    tx.customerSession.deleteMany.mockRejectedValue(
      Object.assign(new Error('canceling statement due to lock timeout'), {
        code: '55P03',
      }),
    );
    expect(
      await code(run({ confirmEmail: EMAIL, reason: GOOD })),
    ).toMatchObject({
      status: 409,
      errorCode: 'ANONYMIZE_BUSY',
    });
    tx.customerSession.deleteMany.mockRejectedValue(
      Object.assign(new Error('deadlock detected'), { code: 'P2034' }),
    );
    expect(
      await code(run({ confirmEmail: EMAIL, reason: GOOD })),
    ).toMatchObject({
      status: 409,
      errorCode: 'ANONYMIZE_BUSY',
    });
  });

  it('any other failure propagates (the transaction rolls back)', async () => {
    tx.cart.deleteMany.mockRejectedValue(new Error('boom'));
    await expect(run({ confirmEmail: EMAIL, reason: GOOD })).rejects.toThrow(
      'boom',
    );
    expect(audit.events).toHaveLength(0);
  });

  it('writes the placeholder email and never an upsert', async () => {
    await run({ confirmEmail: EMAIL, reason: GOOD });
    const update = tx.$queryRaw.mock.calls.find((c) =>
      (c[0] as string[]).join('?').includes('SET "email"'),
    )!;
    expect(update.slice(1)).toContain(`deleted+${ID}@anonymized.invalid`);
  });
});
