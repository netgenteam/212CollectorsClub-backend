import { createHash } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { CheckoutService } from './checkout.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { PAYPAL_CLIENT } from '../payments-paypal/paypal-client.interface.js';
import {
  CheckoutDto,
  CheckoutFulfillmentType,
  CheckoutPaymentRail,
} from './dto/checkout.dto.js';
import { SINGLETON_FX_RATE_ID } from './fx-rate.constants.js';

const CHARIZARD_ID = 'f65915f5-2931-4e50-af95-630b1fd7b950';
const PIKACHU_ID = '343c080e-6b92-48d0-9369-6cee233cf673';

function buildCartItem(overrides: {
  productId?: string;
  quantity?: number;
  productName?: string;
  priceUsd?: string;
  stock?: number;
  heldQty?: number;
}) {
  return {
    productId: overrides.productId ?? CHARIZARD_ID,
    quantity: overrides.quantity ?? 1,
    product: {
      id: overrides.productId ?? CHARIZARD_ID,
      name: overrides.productName ?? 'Charizard VMAX',
      priceUsd: new Prisma.Decimal(overrides.priceUsd ?? '89.99'),
      stock: overrides.stock ?? 12,
      heldQty: overrides.heldQty ?? 0,
    },
  };
}

function buildPickupDto(overrides: Partial<CheckoutDto> = {}): CheckoutDto {
  return {
    paymentRail: CheckoutPaymentRail.PAGO_MOVIL,
    fulfillmentType: CheckoutFulfillmentType.PICKUP,
    recipientName: 'Maria Perez',
    recipientPhone: '0412-1234567',
    ...overrides,
  };
}

function buildDeliveryDto(overrides: Partial<CheckoutDto> = {}): CheckoutDto {
  return {
    paymentRail: CheckoutPaymentRail.PAGO_MOVIL,
    fulfillmentType: CheckoutFulfillmentType.DELIVERY,
    recipientName: 'Maria Perez',
    recipientPhone: '0412-1234567',
    addressLine1: 'Av. Francisco de Miranda',
    city: 'Caracas',
    state: 'Distrito Capital',
    ...overrides,
  };
}

function buildPaypalPickupDto(
  overrides: Partial<CheckoutDto> = {},
): CheckoutDto {
  return {
    paymentRail: CheckoutPaymentRail.PAYPAL,
    fulfillmentType: CheckoutFulfillmentType.PICKUP,
    recipientName: 'Maria Perez',
    recipientPhone: '0412-1234567',
    ...overrides,
  };
}

describe('CheckoutService', () => {
  let service: CheckoutService;
  let tx: {
    cart: {
      findFirst: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    fxRateSetting: { findUnique: ReturnType<typeof vi.fn> };
    order: { create: ReturnType<typeof vi.fn> };
    product: { findUniqueOrThrow: ReturnType<typeof vi.fn> };
    stockHold: { create: ReturnType<typeof vi.fn> };
    orderStatusHistory: { create: ReturnType<typeof vi.fn> };
    $executeRaw: ReturnType<typeof vi.fn>;
  };
  let prisma: {
    $transaction: ReturnType<typeof vi.fn>;
    order: { update: ReturnType<typeof vi.fn> };
  };
  let paypalClient: {
    createOrder: ReturnType<typeof vi.fn>;
    captureAndVerifyOrder: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    tx = {
      cart: { findFirst: vi.fn(), delete: vi.fn() },
      fxRateSetting: { findUnique: vi.fn() },
      order: { create: vi.fn() },
      product: { findUniqueOrThrow: vi.fn() },
      stockHold: { create: vi.fn() },
      orderStatusHistory: { create: vi.fn() },
      $executeRaw: vi.fn(),
    };
    prisma = {
      $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(tx)),
      order: { update: vi.fn() },
    };
    paypalClient = {
      createOrder: vi.fn(),
      captureAndVerifyOrder: vi.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CheckoutService,
        { provide: PrismaService, useValue: prisma },
        { provide: PAYPAL_CLIENT, useValue: paypalClient },
      ],
    }).compile();

    service = module.get<CheckoutService>(CheckoutService);

    // Sane defaults every "gets past stock/FX and into Order creation"
    // test relies on; individual tests override what they need.
    tx.fxRateSetting.findUnique.mockResolvedValue({
      id: SINGLETON_FX_RATE_ID,
      vesPerUsd: new Prisma.Decimal('200.0000'),
    });
    tx.order.create.mockResolvedValue({
      id: 'order-1',
      paymentRail: 'PAGO_MOVIL',
    });
    tx.$executeRaw.mockResolvedValue(1);
    tx.stockHold.create.mockResolvedValue({ id: 'hold-1' });
    tx.orderStatusHistory.create.mockResolvedValue({ id: 'history-1' });
    tx.cart.delete.mockResolvedValue({ id: 'cart-1' });
    prisma.order.update.mockResolvedValue({ id: 'order-1' });
    paypalClient.createOrder.mockResolvedValue({
      paypalOrderId: 'FAKE-PP-ORDER-1',
      approveUrl:
        'https://www.sandbox.paypal.com/checkoutnow?token=FAKE-PP-ORDER-1',
    });
  });

  describe('empty cart (FR-12/checkout precondition)', () => {
    it('rejects with ApiException(422, EMPTY_CART) without touching the DB when there is no cartId', async () => {
      await expect(
        service.checkout(null, buildPickupDto()),
      ).rejects.toMatchObject({
        status: 422,
        response: { errorCode: 'EMPTY_CART' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects with ApiException(422, EMPTY_CART) when the cartId matches no live Cart', async () => {
      tx.cart.findFirst.mockResolvedValue(null);

      await expect(
        service.checkout('stale-cart-id', buildPickupDto()),
      ).rejects.toMatchObject({
        status: 422,
        response: { errorCode: 'EMPTY_CART' },
      });
      expect(tx.order.create).not.toHaveBeenCalled();
    });

    it('rejects with ApiException(422, EMPTY_CART) when the Cart exists but has zero items', async () => {
      tx.cart.findFirst.mockResolvedValue({ id: 'cart-1', items: [] });

      await expect(
        service.checkout('cart-1', buildPickupDto()),
      ).rejects.toMatchObject({
        status: 422,
        response: { errorCode: 'EMPTY_CART' },
      });
      expect(tx.order.create).not.toHaveBeenCalled();
    });
  });

  describe('stock re-validation (FR-12)', () => {
    it('rejects with ApiException(409, INSUFFICIENT_STOCK) listing EVERY insufficient line when the pre-check fails, and never creates an Order', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [
          buildCartItem({
            productId: CHARIZARD_ID,
            quantity: 5,
            stock: 3,
            heldQty: 0,
          }),
          buildCartItem({
            productId: PIKACHU_ID,
            quantity: 10,
            stock: 4,
            heldQty: 2,
          }),
        ],
      });

      await expect(
        service.checkout('cart-1', buildPickupDto()),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          errorCode: 'INSUFFICIENT_STOCK',
          details: {
            items: [
              { productId: CHARIZARD_ID, requested: 5, available: 3 },
              { productId: PIKACHU_ID, requested: 10, available: 2 },
            ],
          },
        },
      });
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(tx.cart.delete).not.toHaveBeenCalled();
    });

    it('rejects with ApiException(409, INSUFFICIENT_STOCK) when the pre-check passes but the AD-6 guarded UPDATE affects 0 rows (a concurrent checkout raced this one), and never deletes the cart', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [buildCartItem({ quantity: 3, stock: 5, heldQty: 0 })],
      });
      tx.$executeRaw.mockResolvedValue(0); // guard lost the race
      tx.product.findUniqueOrThrow.mockResolvedValue({
        name: 'Charizard VMAX',
        stock: 5,
        heldQty: 5, // fully consumed by the winning concurrent checkout
      });

      await expect(
        service.checkout('cart-1', buildPickupDto()),
      ).rejects.toMatchObject({
        status: 409,
        response: {
          errorCode: 'INSUFFICIENT_STOCK',
          details: {
            items: [{ productId: CHARIZARD_ID, requested: 3, available: 0 }],
          },
        },
      });
      // The Order row was created earlier in the SAME transaction callback,
      // but since we threw, Prisma's interactive transaction rolls the
      // whole thing back — nothing here asserts on the DB commit itself
      // (that's the e2e concurrency test's job), only that the service
      // never proceeds to the steps that would follow a real success.
      expect(tx.stockHold.create).not.toHaveBeenCalled();
      expect(tx.orderStatusHistory.create).not.toHaveBeenCalled();
      expect(tx.cart.delete).not.toHaveBeenCalled();
    });
  });

  describe('successful checkout', () => {
    it('snapshots productName/unitPriceUsd/quantity/lineTotalUsd per line, totalUsd, and the FX rate/totalVes exactly once from the current FxRateSetting row', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [
          buildCartItem({
            productId: CHARIZARD_ID,
            quantity: 2,
            priceUsd: '89.99',
          }),
          buildCartItem({
            productId: PIKACHU_ID,
            quantity: 3,
            priceUsd: '14.99',
            productName: 'Pikachu Promo Card',
          }),
        ],
      });

      const result = await service.checkout('cart-1', buildPickupDto());

      // 2*89.99 + 3*14.99 = 179.98 + 44.97 = 224.95
      expect(result.totalUsd).toBe(224.95);
      expect(result.fxRateVesPerUsd).toBe(200);
      expect(result.totalVes).toBe(44990); // 224.95 * 200
      expect(result.status).toBe('pending_verification');
      expect(result.lines).toEqual([
        {
          productId: CHARIZARD_ID,
          productName: 'Charizard VMAX',
          unitPriceUsd: 89.99,
          quantity: 2,
          lineTotalUsd: 179.98,
        },
        {
          productId: PIKACHU_ID,
          productName: 'Pikachu Promo Card',
          unitPriceUsd: 14.99,
          quantity: 3,
          lineTotalUsd: 44.97,
        },
      ]);

      const orderCreateArg = tx.order.create.mock.calls[0][0] as {
        data: {
          totalUsd: Prisma.Decimal;
          fxRateVesPerUsd: Prisma.Decimal;
          totalVes: Prisma.Decimal;
        };
      };
      expect(orderCreateArg.data.totalUsd.toString()).toBe('224.95');
      expect(orderCreateArg.data.fxRateVesPerUsd.toString()).toBe('200');
      expect(orderCreateArg.data.totalVes.toString()).toBe('44990');
    });

    it('creates exactly one guarded StockHold UPDATE + StockHold row per cart line, and writes the []->pending_verification OrderStatusHistory row', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [
          buildCartItem({ productId: CHARIZARD_ID, quantity: 2 }),
          buildCartItem({ productId: PIKACHU_ID, quantity: 1 }),
        ],
      });

      await service.checkout('cart-1', buildPickupDto());

      expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
      expect(tx.stockHold.create).toHaveBeenCalledTimes(2);
      expect(tx.stockHold.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: 'order-1',
          productId: CHARIZARD_ID,
          quantity: 2,
        }) as unknown,
      });
      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: 'order-1',
          fromStatus: null,
          toStatus: 'PENDING_VERIFICATION',
          actorType: 'SYSTEM',
          adminUserId: null,
        },
      });
    });

    it('clears the cart (deletes the Cart row) on success', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [buildCartItem({})],
      });

      await service.checkout('cart-1', buildPickupDto());

      expect(tx.cart.delete).toHaveBeenCalledWith({ where: { id: 'cart-1' } });
    });

    it('returns a raw orderAccessToken whose SHA-256 hash matches accessTokenHash persisted on the Order, and never persists the raw value', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [buildCartItem({})],
      });

      const result = await service.checkout('cart-1', buildPickupDto());

      expect(result.orderAccessToken).toMatch(/^[0-9a-f]{64}$/);

      const orderCreateArg = tx.order.create.mock.calls[0][0] as {
        data: { accessTokenHash: string };
      };
      const expectedHash = createHash('sha256')
        .update(result.orderAccessToken)
        .digest('hex');
      expect(orderCreateArg.data.accessTokenHash).toBe(expectedHash);
      expect(orderCreateArg.data.accessTokenHash).not.toBe(
        result.orderAccessToken,
      );
    });

    it('sets fulfillmentType=PICKUP and nulls every address field (including country) for a pickup checkout', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [buildCartItem({})],
      });

      await service.checkout('cart-1', buildPickupDto());

      const orderCreateArg = tx.order.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(orderCreateArg.data).toMatchObject({
        fulfillmentType: 'PICKUP',
        addressLine1: null,
        addressLine2: null,
        city: null,
        state: null,
        country: null,
      });
    });

    it('sets fulfillmentType=DELIVERY, copies the address fields, and hardcodes country=Venezuela for a delivery checkout', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [buildCartItem({})],
      });

      await service.checkout(
        'cart-1',
        buildDeliveryDto({ addressLine2: 'Apto 4B' }),
      );

      const orderCreateArg = tx.order.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(orderCreateArg.data).toMatchObject({
        fulfillmentType: 'DELIVERY',
        addressLine1: 'Av. Francisco de Miranda',
        addressLine2: 'Apto 4B',
        city: 'Caracas',
        state: 'Distrito Capital',
        country: 'Venezuela',
      });
    });

    it('always persists status=PENDING_VERIFICATION and paymentRail=PAGO_MOVIL, never payment_processing', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [buildCartItem({})],
      });

      await service.checkout('cart-1', buildPickupDto());

      const orderCreateArg = tx.order.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(orderCreateArg.data.status).toBe('PENDING_VERIFICATION');
      expect(orderCreateArg.data.paymentRail).toBe('PAGO_MOVIL');
    });
  });

  describe('PayPal checkout (Story 4.3)', () => {
    beforeEach(() => {
      tx.order.create.mockResolvedValue({
        id: 'order-1',
        paymentRail: 'PAYPAL',
      });
    });

    it('creates the Order in PAYMENT_PROCESSING with paymentRail=PAYPAL, null FX/VES fields, and never creates a StockHold', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [buildCartItem({ quantity: 2, priceUsd: '89.99' })],
      });

      const result = await service.checkout('cart-1', buildPaypalPickupDto());

      const orderCreateArg = tx.order.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(orderCreateArg.data).toMatchObject({
        status: 'PAYMENT_PROCESSING',
        paymentRail: 'PAYPAL',
        fxRateVesPerUsd: null,
        totalVes: null,
      });
      // paypal never reads the FX rate at all.
      expect(tx.fxRateSetting.findUnique).not.toHaveBeenCalled();
      // paypal never holds stock — no guarded UPDATE, no StockHold row.
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.stockHold.create).not.toHaveBeenCalled();

      expect(result.status).toBe('payment_processing');
      expect(result.fxRateVesPerUsd).toBeNull();
      expect(result.totalVes).toBeNull();
      expect(result.paymentInstructions).toBeNull();
    });

    it('still clears the cart and writes the []->payment_processing OrderStatusHistory row, actorType=system', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [buildCartItem({})],
      });

      await service.checkout('cart-1', buildPaypalPickupDto());

      expect(tx.cart.delete).toHaveBeenCalledWith({ where: { id: 'cart-1' } });
      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: {
          orderId: 'order-1',
          fromStatus: null,
          toStatus: 'PAYMENT_PROCESSING',
          actorType: 'SYSTEM',
          adminUserId: null,
        },
      });
    });

    it('still re-validates stock per line (shared FR-12 pre-check) and rejects with 409 INSUFFICIENT_STOCK without ever calling PayPal', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [buildCartItem({ quantity: 5, stock: 3, heldQty: 0 })],
      });

      await expect(
        service.checkout('cart-1', buildPaypalPickupDto()),
      ).rejects.toMatchObject({
        status: 409,
        response: { errorCode: 'INSUFFICIENT_STOCK' },
      });
      expect(tx.order.create).not.toHaveBeenCalled();
      expect(paypalClient.createOrder).not.toHaveBeenCalled();
    });

    it('calls paypalClient.createOrder with the Order id + 2dp totalUsd string, persists the returned paypalOrderId, and returns the approveUrl', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [buildCartItem({ quantity: 2, priceUsd: '89.99' })],
      });

      const result = await service.checkout('cart-1', buildPaypalPickupDto());

      expect(paypalClient.createOrder).toHaveBeenCalledWith({
        orderId: 'order-1',
        totalUsd: '179.98',
      });
      expect(prisma.order.update).toHaveBeenCalledWith({
        where: { id: 'order-1' },
        data: { paypalOrderId: 'FAKE-PP-ORDER-1' },
      });
      expect(result.paypal).toEqual({
        paypalOrderId: 'FAKE-PP-ORDER-1',
        approveUrl:
          'https://www.sandbox.paypal.com/checkoutnow?token=FAKE-PP-ORDER-1',
      });
    });

    it('on paypalClient.createOrder failure: guardedly transitions the already-committed Order to PAYMENT_FAILED and rejects with a 502', async () => {
      tx.cart.findFirst.mockResolvedValue({
        id: 'cart-1',
        items: [buildCartItem({})],
      });
      paypalClient.createOrder.mockRejectedValue(new Error('PayPal is down'));

      await expect(
        service.checkout('cart-1', buildPaypalPickupDto()),
      ).rejects.toMatchObject({
        status: 502,
        response: { errorCode: 'PAYPAL_ORDER_CREATION_FAILED' },
      });

      // The guarded fail-over transition ran against the Order created in
      // the (already-committed) checkout transaction above — paypal never
      // calls $executeRaw during checkout itself (no StockHold guard), so
      // this one call is exclusively the PAYMENT_PROCESSING->PAYMENT_FAILED
      // guarded UPDATE.
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.orderStatusHistory.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          orderId: 'order-1',
          fromStatus: 'PAYMENT_PROCESSING',
          toStatus: 'PAYMENT_FAILED',
          actorType: 'SYSTEM',
        }) as unknown,
      });
      // Never persisted a paypalOrderId — the order/session was never
      // actually created on PayPal's side.
      expect(prisma.order.update).not.toHaveBeenCalled();
    });
  });
});
