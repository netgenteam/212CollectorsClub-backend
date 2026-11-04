import { fakeAudit } from '../../test/helpers/fake-audit.js';
import { makeTestCrypto } from '../../test/helpers/iddoc-test-crypto.js';
import { FxRateService } from '../fx/fx-rate.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { CheckoutService } from './checkout.service.js';
import {
  ABSENT_TTL_MS,
  customerAnonymizedAtExists,
  resetCustomerAnonymizedAtProbe,
} from './checkout-account-lock.js';
import {
  CheckoutFulfillmentType,
  CheckoutPaymentRail,
  type CheckoutDto,
} from './dto/checkout.dto.js';

const AGENCY_ID = '11111111-1111-4111-8111-111111111111';
const ADDRESS_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ACCOUNT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const FLAT: CheckoutDto = {
  paymentRail: CheckoutPaymentRail.PAGO_MOVIL,
  fulfillmentType: CheckoutFulfillmentType.DELIVERY,
  recipientName: 'Maria Perez',
  recipientPhone: '0412-1234567',
  addressLine1: 'Av. Francisco de Miranda',
  city: 'Caracas',
  state: 'Distrito Capital',
};

const AGENCY: CheckoutDto = {
  paymentRail: CheckoutPaymentRail.PAGO_MOVIL,
  fulfillmentType: CheckoutFulfillmentType.DELIVERY,
  recipientName: 'Maria Perez',
  recipientPhone: '+58 412-1234567',
  recipientIdDoc: 'V-12345678',
  deliveryMode: 'home_delivery',
  shippingAgencyId: AGENCY_ID,
  state: 'Distrito Capital',
  municipality: 'Libertador',
  addressLine1: 'Av. Francisco de Miranda',
};

const crypto = makeTestCrypto();
const CLEAR = ['12345678', '81234567', '070133805'];

/** Story 20.4 (AC1-AC4): unit coverage of buyer ID, expected account and the account lock hook. */
describe('CheckoutService (story 20.4: buyer ID, expected account, account lock)', () => {
  type Mock = ReturnType<typeof vi.fn>;
  let tx: Record<string, Record<string, Mock>> & Record<string, Mock>;
  let prisma: Record<string, unknown>;
  let customerFind: Mock;
  let transaction: Mock;
  let probe: Mock;
  let shipping: { assertAgencyUsable: Mock };
  let calls: string[];
  let service: CheckoutService;
  let saved: string | undefined;

  const createdData = (): Record<string, unknown> =>
    (tx.order.create.mock.calls[0][0] as { data: Record<string, unknown> })
      .data;
  const errorCodeOf = async (p: Promise<unknown>): Promise<unknown> =>
    p.then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: { status: number; response: Record<string, unknown> }) => ({
        status: e.status,
        ...e.response,
      }),
    );

  beforeEach(() => {
    saved = process.env.CHECKOUT_REQUIRE_BUYER_ID;
    delete process.env.CHECKOUT_REQUIRE_BUYER_ID;
    resetCustomerAnonymizedAtProbe();
    calls = [];
    tx = {
      cart: {
        findFirst: vi.fn(() => {
          calls.push('cart');
          return Promise.resolve({
            id: 'cart-1',
            items: [
              {
                productId: 'p1',
                quantity: 1,
                product: {
                  id: 'p1',
                  name: 'X',
                  priceUsd: new Prisma.Decimal('10.00'),
                  stock: 5,
                  heldQty: 0,
                },
              },
            ],
          });
        }),
        delete: vi.fn(),
      },
      customerAddress: { findFirst: vi.fn() },
      fxRateSetting: { findUnique: vi.fn() },
      order: { create: vi.fn() },
      stockHold: { create: vi.fn() },
      orderStatusHistory: { create: vi.fn() },
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn(() => {
        calls.push('lock');
        return Promise.resolve([{ anonymizedAt: null }]);
      }),
    } as never;
    tx.fxRateSetting.findUnique.mockResolvedValue({
      source: 'BCV_USD',
      maxAgeHours: 48,
      updatedAt: new Date(),
      rateFetchedAt: new Date(),
      providerUpdatedAt: null,
      vesPerUsd: new Prisma.Decimal('200'),
    });
    tx.order.create.mockResolvedValue({ id: 'o1', paymentRail: 'PAGO_MOVIL' });
    customerFind = vi
      .fn()
      .mockResolvedValue({ emailVerified: true, email: 'a@x.test' });
    transaction = vi.fn((cb: (t: unknown) => unknown) => cb(tx));
    probe = vi.fn().mockResolvedValue([{ present: false }]);
    prisma = {
      $transaction: transaction,
      $queryRaw: probe,
      customer: { findUnique: customerFind },
    };
    shipping = { assertAgencyUsable: vi.fn().mockResolvedValue(undefined) };
    service = new CheckoutService(
      prisma as never,
      {} as never,
      {} as never,
      shipping as never,
      new FxRateService(null as never),
      {
        assertAccepted: () => {
          calls.push('consent');
          return Promise.resolve({ now: new Date(), versions: {} });
        },
        recordConsents: () => Promise.resolve(0),
      } as never,
      crypto,
      fakeAudit({ $transaction: transaction }),
    );
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.CHECKOUT_REQUIRE_BUYER_ID;
    else process.env.CHECKOUT_REQUIRE_BUYER_ID = saved;
  });

  describe('AC1: resolved before the transaction, with no Order and no StockHold', () => {
    beforeEach(() => {
      process.env.CHECKOUT_REQUIRE_BUYER_ID = 'true';
    });

    it('missing => 400 BUYER_ID_REQUIRED, no DB touched at all', async () => {
      const r = await errorCodeOf(service.checkout('cart-1', FLAT));
      expect(r).toMatchObject({
        status: 400,
        errorCode: 'BUYER_ID_REQUIRED',
        details: { field: 'buyerId', reason: 'REQUIRED' },
      });
      expect(transaction).not.toHaveBeenCalled();
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(tx.stockHold.create).not.toHaveBeenCalled();
      expect(tx.cart.findFirst).not.toHaveBeenCalled();
    });

    it('missing for an account: rejected before the account is even read', async () => {
      const r = await errorCodeOf(
        service.checkout(null, AGENCY, { id: ACCOUNT_A }),
      );
      expect(r).toMatchObject({ status: 400, errorCode: 'BUYER_ID_REQUIRED' });
      expect(customerFind).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('invalid => 400 BUYER_ID_INVALID with field/reason, nothing created', async () => {
      const r = await errorCodeOf(
        service.checkout('cart-1', {
          ...FLAT,
          buyerId: { type: 'V', number: '123' },
        }),
      );
      expect(r).toMatchObject({
        status: 400,
        errorCode: 'BUYER_ID_INVALID',
        details: { field: 'buyerId.number', reason: 'INVALID_LENGTH' },
      });
      expect(transaction).not.toHaveBeenCalled();
      expect(JSON.stringify(r)).not.toContain('"123"');
    });

    it('J without buyerLegalName => 400 BUYER_ID_REQUIRED (buyerLegalName)', async () => {
      const r = await errorCodeOf(
        service.checkout('cart-1', {
          ...FLAT,
          buyerId: { type: 'J', number: '070133805' },
        }),
      );
      expect(r).toMatchObject({
        status: 400,
        errorCode: 'BUYER_ID_REQUIRED',
        details: { field: 'buyerLegalName' },
      });
      expect(transaction).not.toHaveBeenCalled();
    });

    it('buyerSameAsRecipient in the legacy flat format => BUYER_ID_REQUIRED', async () => {
      const r = await errorCodeOf(
        service.checkout('cart-1', { ...FLAT, buyerSameAsRecipient: true }),
      );
      expect(r).toMatchObject({ status: 400, errorCode: 'BUYER_ID_REQUIRED' });
      expect(transaction).not.toHaveBeenCalled();
    });

    it('it composes with CHECKOUT_REQUIRE_SHIPPING: shipping is asked first (flat format refused)', async () => {
      process.env.CHECKOUT_REQUIRE_SHIPPING = 'true';
      try {
        const r = await errorCodeOf(service.checkout('cart-1', FLAT));
        expect(r).toMatchObject({
          status: 400,
          errorCode: 'SHIPPING_REQUIRED',
        });
      } finally {
        delete process.env.CHECKOUT_REQUIRE_SHIPPING;
      }
    });
  });

  describe('the deployment switch: CHECKOUT_REQUIRE_BUYER_ID is OFF by default', () => {
    it('without it, a checkout with no buyerId still sells (the order keeps no buyer ID)', async () => {
      await service.checkout('cart-1', FLAT);
      expect(createdData()).toMatchObject({
        buyerIdType: null,
        buyerIdDocEnc: null,
        buyerIdDocBlind: null,
        buyerLegalName: null,
      });
    });

    it('a buyerId that IS sent is validated and stored even while the switch is off', async () => {
      await service.checkout('cart-1', {
        ...FLAT,
        buyerId: { type: 'V', number: '12345678' },
      });
      expect(createdData()).toMatchObject({ buyerIdType: 'V' });
      const bad = await errorCodeOf(
        service.checkout('cart-1', {
          ...FLAT,
          buyerId: { type: 'V', number: '1' },
        }),
      );
      expect(bad).toMatchObject({ errorCode: 'BUYER_ID_INVALID' });
    });
  });

  describe('AC3: what the order stores', () => {
    it('explicit V: type, ciphertext and blind index; never the clear value', async () => {
      await service.checkout('cart-1', {
        ...AGENCY,
        buyerId: { type: 'E', number: '81.234.567' },
      });
      const data = createdData();
      expect(data.buyerIdType).toBe('E');
      expect(crypto.isEncrypted(data.buyerIdDocEnc)).toBe(true);
      expect(crypto.decrypt(data.buyerIdDocEnc as string)).toBe('E-81234567');
      expect(data.buyerIdDocBlind).toBe(crypto.blindIndexOf('E-81234567'));
      expect(data.buyerLegalName).toBeNull();
      const dump = JSON.stringify(data);
      for (const c of CLEAR) expect(dump).not.toContain(c);
      // independent from the recipient (V-12345678)
      expect(data.recipientIdDocBlind).toBe(crypto.blindIndexOf('V-12345678'));
      expect(data.buyerIdDocBlind).not.toBe(data.recipientIdDocBlind);
    });

    it('J: stores the RIF and the legal name', async () => {
      await service.checkout('cart-1', {
        ...AGENCY,
        buyerId: { type: 'J', number: '07013380-5' },
        buyerLegalName: '  Banesco   Banco Universal ',
      });
      expect(createdData()).toMatchObject({
        buyerIdType: 'J',
        buyerIdDocBlind: crypto.blindIndexOf('J-070133805'),
        buyerLegalName: 'Banesco Banco Universal',
      });
    });

    it('buyerSameAsRecipient (agency format): the recipient ciphertext is COPIED', async () => {
      await service.checkout('cart-1', {
        ...AGENCY,
        buyerSameAsRecipient: true,
      });
      const data = createdData();
      expect(data.buyerIdType).toBe('V');
      expect(data.buyerIdDocEnc).toBe(data.recipientIdDocEnc);
      expect(data.buyerIdDocBlind).toBe(data.recipientIdDocBlind);
      expect(data.buyerLegalName).toBeNull();
    });

    it('buyerSameAsRecipient with a saved address: copies its Enc/Blind and reads the type from it', async () => {
      const p = crypto.protect('E-81234567');
      tx.customerAddress.findFirst.mockResolvedValue({
        recipientName: 'Maria Perez',
        recipientPhone: '+584121234567',
        recipientIdDoc: null,
        recipientIdDocEnc: p?.enc,
        recipientIdDocBlind: p?.blind,
        deliveryMode: 'HOME_DELIVERY',
        agencyId: AGENCY_ID,
        agencyBranchName: null,
        agencyBranchCode: null,
        addressLine1: 'x',
        addressLine2: null,
        municipality: 'Libertador',
        parish: null,
        referencePoint: null,
        state: 'Distrito Capital',
      });
      await service.checkout(
        null,
        {
          paymentRail: CheckoutPaymentRail.PAGO_MOVIL,
          fulfillmentType: CheckoutFulfillmentType.DELIVERY,
          customerAddressId: ADDRESS_ID,
          buyerSameAsRecipient: true,
        } as CheckoutDto,
        { id: ACCOUNT_A },
      );
      const data = createdData();
      expect(data.buyerIdType).toBe('E');
      expect(data.buyerIdDocEnc).toBe(p?.enc);
      expect(data.buyerIdDocBlind).toBe(p?.blind);
    });

    it('a saved address without cedula cannot be copied: 400 BUYER_ID_REQUIRED, no Order, no hold', async () => {
      tx.customerAddress.findFirst.mockResolvedValue({
        recipientName: 'Maria Perez',
        recipientPhone: '+584121234567',
        recipientIdDoc: null,
        recipientIdDocEnc: null,
        recipientIdDocBlind: null,
        deliveryMode: 'HOME_DELIVERY',
        agencyId: AGENCY_ID,
        agencyBranchName: null,
        agencyBranchCode: null,
        addressLine1: 'x',
        addressLine2: null,
        municipality: 'Libertador',
        parish: null,
        referencePoint: null,
        state: 'Distrito Capital',
      });
      const r = await errorCodeOf(
        service.checkout(
          null,
          {
            paymentRail: CheckoutPaymentRail.PAGO_MOVIL,
            fulfillmentType: CheckoutFulfillmentType.DELIVERY,
            customerAddressId: ADDRESS_ID,
            buyerSameAsRecipient: true,
          } as CheckoutDto,
          { id: ACCOUNT_A },
        ),
      );
      expect(r).toMatchObject({
        status: 400,
        errorCode: 'BUYER_ID_REQUIRED',
        details: { reason: 'RECIPIENT_ID_MISSING' },
      });
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(tx.stockHold.create).not.toHaveBeenCalled();
    });

    it('a saved address whose blind index does not match its ciphertext is refused (never copied)', async () => {
      const p = crypto.protect('V-12345678');
      const other = crypto.protect('V-87654321');
      tx.customerAddress.findFirst.mockResolvedValue({
        recipientName: 'Maria Perez',
        recipientPhone: '+584121234567',
        recipientIdDoc: null,
        recipientIdDocEnc: p?.enc,
        recipientIdDocBlind: other?.blind, // a moved/edited row
        deliveryMode: 'HOME_DELIVERY',
        agencyId: AGENCY_ID,
        agencyBranchName: null,
        agencyBranchCode: null,
        addressLine1: 'x',
        addressLine2: null,
        municipality: 'Libertador',
        parish: null,
        referencePoint: null,
        state: 'Distrito Capital',
      });
      const r = await errorCodeOf(
        service.checkout(
          null,
          {
            paymentRail: CheckoutPaymentRail.PAGO_MOVIL,
            fulfillmentType: CheckoutFulfillmentType.DELIVERY,
            customerAddressId: ADDRESS_ID,
            buyerSameAsRecipient: true,
          } as CheckoutDto,
          { id: ACCOUNT_A },
        ),
      );
      expect(r).toMatchObject({ status: 400, errorCode: 'BUYER_ID_INVALID' });
      expect(tx.order.create).not.toHaveBeenCalled();
    });
  });

  describe('the expected account (race between /auth/me and POST /checkout)', () => {
    const noEffect = (): void => {
      expect(customerFind).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(tx.stockHold.create).not.toHaveBeenCalled();
      expect(tx.cart.delete).not.toHaveBeenCalled();
    };

    it('the session is account B but the storefront expected A: 409, no effect', async () => {
      const r = await errorCodeOf(
        service.checkout(
          null,
          { ...AGENCY, expectedCustomerId: ACCOUNT_A },
          { id: ACCOUNT_B },
        ),
      );
      expect(r).toMatchObject({
        status: 409,
        errorCode: 'CHECKOUT_ACCOUNT_MISMATCH',
      });
      noEffect();
    });

    it('the session is gone (guest) but the storefront expected A: 409, no effect', async () => {
      const r = await errorCodeOf(
        service.checkout(
          'cart-1',
          { ...AGENCY, expectedCustomerId: ACCOUNT_A },
          null,
        ),
      );
      expect(r).toMatchObject({
        status: 409,
        errorCode: 'CHECKOUT_ACCOUNT_MISMATCH',
      });
      noEffect();
    });

    it('null means "I am a guest": an account session is a 409', async () => {
      const r = await errorCodeOf(
        service.checkout(
          null,
          { ...AGENCY, expectedCustomerId: null },
          { id: ACCOUNT_A },
        ),
      );
      expect(r).toMatchObject({
        status: 409,
        errorCode: 'CHECKOUT_ACCOUNT_MISMATCH',
      });
      noEffect();
    });

    it('it is checked before the buyer ID and before the shipping gates', async () => {
      process.env.CHECKOUT_REQUIRE_BUYER_ID = 'true';
      const r = await errorCodeOf(
        service.checkout(
          'cart-1',
          { ...FLAT, expectedCustomerId: ACCOUNT_A },
          { id: ACCOUNT_B },
        ),
      );
      expect(r).toMatchObject({ errorCode: 'CHECKOUT_ACCOUNT_MISMATCH' });
    });

    it.each([
      ['the same account', ACCOUNT_A, { id: ACCOUNT_A }],
      [
        'the same account in another case',
        ACCOUNT_A.toUpperCase(),
        { id: ACCOUNT_A },
      ],
      ['omitted (no check)', undefined, { id: ACCOUNT_B }],
    ])('%s: proceeds', async (_n, expectedCustomerId, session) => {
      await service.checkout(null, { ...AGENCY, expectedCustomerId }, session);
      expect(tx.order.create).toHaveBeenCalledTimes(1);
    });

    it('a guest that expects to be a guest proceeds', async () => {
      await service.checkout('cart-1', { ...AGENCY, expectedCustomerId: null });
      expect(tx.order.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC4: the account lock is the FIRST statement of the transaction (hook for 20.6)', () => {
    it('with the column present: SELECT "anonymizedAt" ... FOR SHARE runs before consent, cart and Order', async () => {
      probe.mockResolvedValue([{ present: true }]);
      await service.checkout(null, AGENCY, { id: ACCOUNT_A });
      expect(calls.slice(0, 3)).toEqual(['lock', 'consent', 'cart']);
      // The probe ran OUTSIDE the transaction (it would otherwise be the first statement).
      expect(probe).toHaveBeenCalledTimes(1);
      const sql = (tx.$queryRaw.mock.calls[0][0] as string[]).join('?');
      expect(sql).toContain('SELECT "anonymizedAt" FROM "Customers"');
      expect(sql).toContain('FOR SHARE');
    });

    it('an anonymized account is 401 INVALID_CUSTOMER_TOKEN, nothing created', async () => {
      probe.mockResolvedValue([{ present: true }]);
      tx.$queryRaw.mockResolvedValue([{ anonymizedAt: new Date() }]);
      const r = await errorCodeOf(
        service.checkout(null, AGENCY, { id: ACCOUNT_A }),
      );
      expect(r).toMatchObject({
        status: 401,
        errorCode: 'INVALID_CUSTOMER_TOKEN',
      });
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(calls).not.toContain('consent');
    });

    it('an account that no longer exists is 401 too', async () => {
      probe.mockResolvedValue([{ present: true }]);
      tx.$queryRaw.mockResolvedValue([]);
      const r = await errorCodeOf(
        service.checkout(null, AGENCY, { id: ACCOUNT_A }),
      );
      expect(r).toMatchObject({ status: 401 });
    });

    it('a guest takes no lock and runs no probe', async () => {
      probe.mockResolvedValue([{ present: true }]);
      await service.checkout('cart-1', AGENCY);
      expect(calls).not.toContain('lock');
      expect(probe).not.toHaveBeenCalled();
    });

    it('without the column (before 20.6) the hook stays off and checkout works', async () => {
      probe.mockResolvedValue([{ present: false }]);
      await service.checkout(null, AGENCY, { id: ACCOUNT_A });
      expect(calls).not.toContain('lock');
      expect(tx.order.create).toHaveBeenCalledTimes(1);
    });

    it('a probe that fails once is checked again right away (no sale lost, nothing cached as "absent")', async () => {
      probe
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue([{ present: true }]);
      await service.checkout(null, AGENCY, { id: ACCOUNT_A });
      expect(probe).toHaveBeenCalledTimes(2);
      expect(calls[0]).toBe('lock'); // the guard is ON: the error was not read as "absent"
      expect(tx.order.create).toHaveBeenCalledTimes(1);
    });

    it('a probe that fails twice FAILS CLOSED (503 CHECKOUT_UNAVAILABLE), caches nothing, and the next request probes again', async () => {
      probe.mockRejectedValue(new Error('boom'));
      const r = await errorCodeOf(
        service.checkout(null, AGENCY, { id: ACCOUNT_A }),
      );
      expect(r).toMatchObject({
        status: 503,
        errorCode: 'CHECKOUT_UNAVAILABLE',
      });
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
      probe.mockReset();
      probe.mockResolvedValue([{ present: true }]);
      await service.checkout(null, AGENCY, { id: ACCOUNT_A });
      expect(calls[0]).toBe('lock');
    });
  });

  describe('the probe cache (checkout-account-lock.ts)', () => {
    const db = (impl: () => Promise<{ present: boolean }[]>) => ({
      $queryRaw: vi.fn(impl),
    });
    it('"absent" is cached only ABSENT_TTL_MS; "present" for good', async () => {
      const d = db(() => Promise.resolve([{ present: false }]));
      expect(await customerAnonymizedAtExists(d, 1_000)).toBe(false);
      expect(
        await customerAnonymizedAtExists(d, 1_000 + ABSENT_TTL_MS - 1),
      ).toBe(false);
      expect(d.$queryRaw).toHaveBeenCalledTimes(1);
      // the migration created the column: seen as soon as the short TTL expires
      d.$queryRaw.mockResolvedValue([{ present: true }]);
      expect(await customerAnonymizedAtExists(d, 1_000 + ABSENT_TTL_MS)).toBe(
        true,
      );
      expect(d.$queryRaw).toHaveBeenCalledTimes(2);
      expect(await customerAnonymizedAtExists(d, 9_999_999)).toBe(true);
      expect(d.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('an error is never cached as "absent"', async () => {
      const bad = db(() => Promise.reject(new Error('x')));
      await expect(customerAnonymizedAtExists(bad, 5)).rejects.toMatchObject({
        status: 503,
      });
      const good = db(() => Promise.resolve([{ present: true }]));
      expect(await customerAnonymizedAtExists(good, 6)).toBe(true);
    });
  });

  describe('buyerSameAsRecipient with a bad recipient cedula in the agency format', () => {
    it.each(['J-070133805', 'V-12', ''])(
      '%j: SHIPPING_INVALID on recipientIdDoc (the actionable error), nothing created',
      async (recipientIdDoc) => {
        const r = await errorCodeOf(
          service.checkout('cart-1', {
            ...AGENCY,
            recipientIdDoc,
            buyerSameAsRecipient: true,
          }),
        );
        expect(r).toMatchObject({
          status: 400,
          errorCode: 'SHIPPING_INVALID',
          details: { field: 'recipientIdDoc' },
        });
        expect(tx.order.create).not.toHaveBeenCalled();
        expect(tx.stockHold.create).not.toHaveBeenCalled();
      },
    );
  });

  describe('SHIPPING_INVALID carries details.field / details.reason', () => {
    it('flat format with a malformed recipient cedula', async () => {
      const r = await errorCodeOf(
        service.checkout('cart-1', { ...FLAT, recipientIdDoc: 'V-12' }),
      );
      expect(r).toMatchObject({
        status: 400,
        errorCode: 'SHIPPING_INVALID',
        details: {
          field: 'recipientIdDoc',
          reason: 'INVALID',
          errors: [{ field: 'recipientIdDoc', code: 'INVALID' }],
        },
      });
    });

    it('agency format with a non V/E recipient cedula', async () => {
      const r = await errorCodeOf(
        service.checkout('cart-1', {
          ...AGENCY,
          recipientIdDoc: 'J-070133805',
        }),
      );
      expect(r).toMatchObject({
        errorCode: 'SHIPPING_INVALID',
        details: { field: 'recipientIdDoc', reason: 'INVALID' },
      });
    });

    it('two different cedulas inside the name', async () => {
      const r = await errorCodeOf(
        service.checkout('cart-1', {
          ...FLAT,
          recipientName: 'Ana (V-70123456) y Luis (E-81234567)',
        }),
      );
      expect(r).toMatchObject({
        errorCode: 'SHIPPING_INVALID',
        details: { field: 'recipientName', reason: 'INVALID' },
      });
    });
  });
});
