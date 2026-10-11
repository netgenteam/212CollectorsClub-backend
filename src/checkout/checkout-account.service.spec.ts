import { Prisma } from '../generated/prisma/client.js';
import { CheckoutService } from './checkout.service.js';
import {
  CheckoutFulfillmentType,
  CheckoutPaymentRail,
} from './dto/checkout.dto.js';

const DTO = {
  paymentRail: CheckoutPaymentRail.PAGO_MOVIL,
  fulfillmentType: CheckoutFulfillmentType.PICKUP,
  recipientName: 'Maria Perez',
  recipientPhone: '0412-1234567',
};

/** Story 12.6 (FR-45, AD-31): account checkout. */
describe('CheckoutService (account)', () => {
  let tx: Record<string, Record<string, ReturnType<typeof vi.fn>>> &
    Record<string, ReturnType<typeof vi.fn>>;
  let customerFind: ReturnType<typeof vi.fn>;
  let transaction: ReturnType<typeof vi.fn>;
  let service: CheckoutService;

  beforeEach(() => {
    tx = {
      cart: { findFirst: vi.fn(), delete: vi.fn() },
      fxRateSetting: { findUnique: vi.fn() },
      order: { create: vi.fn() },
      stockHold: { create: vi.fn() },
      orderStatusHistory: { create: vi.fn() },
      $executeRaw: vi.fn().mockResolvedValue(1),
    } as never;
    tx.cart.findFirst.mockResolvedValue({
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
    tx.fxRateSetting.findUnique.mockResolvedValue({
      vesPerUsd: new Prisma.Decimal('200'),
    });
    tx.order.create.mockResolvedValue({ id: 'o1', paymentRail: 'PAGO_MOVIL' });
    customerFind = vi.fn();
    transaction = vi.fn((cb: (t: unknown) => unknown) => cb(tx));
    service = new CheckoutService(
      {
        $transaction: transaction,
        customer: { findUnique: customerFind },
      } as never,
      {} as never,
    );
  });

  it('unverified email: 409 EMAIL_NOT_VERIFIED before any transaction (no order, no hold)', async () => {
    customerFind.mockResolvedValue({ emailVerified: false });
    await expect(
      service.checkout(null, DTO, { id: 'c1' }),
    ).rejects.toMatchObject({
      status: 409,
      response: { errorCode: 'EMAIL_NOT_VERIFIED' },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('verified: uses the account cart (customerId filter), ignores cartId, stores customerId', async () => {
    customerFind.mockResolvedValue({ emailVerified: true });
    const res = await service.checkout('stale-cookie-cart', DTO, {
      id: 'c1',
    });
    expect(res.orderAccessToken).toEqual(expect.any(String));
    const where = (
      tx.cart.findFirst.mock.calls[0] as [{ where: Record<string, unknown> }]
    )[0].where;
    expect(where).toEqual({ customerId: 'c1' });
    const data = (
      tx.order.create.mock.calls[0] as [{ data: Record<string, unknown> }]
    )[0].data;
    expect(data.customerId).toBe('c1');
  });

  it('guest: customerId null and cart still filtered customerId:null', async () => {
    await service.checkout('cart-1', DTO);
    const where = (
      tx.cart.findFirst.mock.calls[0] as [{ where: Record<string, unknown> }]
    )[0].where;
    expect(where).toMatchObject({ id: 'cart-1', customerId: null });
    const data = (
      tx.order.create.mock.calls[0] as [{ data: Record<string, unknown> }]
    )[0].data;
    expect(data.customerId).toBeNull();
    expect(customerFind).not.toHaveBeenCalled();
  });

  it('deleted account (stale session): 401 INVALID_CUSTOMER_TOKEN', async () => {
    customerFind.mockResolvedValue(null);
    await expect(
      service.checkout(null, DTO, { id: 'gone' }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it('empty account cart: 422 EMPTY_CART', async () => {
    customerFind.mockResolvedValue({ emailVerified: true });
    tx.cart.findFirst.mockResolvedValue(null);
    await expect(
      service.checkout(null, DTO, { id: 'c1' }),
    ).rejects.toMatchObject({ response: { errorCode: 'EMPTY_CART' } });
  });
});
