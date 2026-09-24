import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  FulfillmentType,
  OrderActorType,
  OrderStatus,
  PaymentRail,
} from '../generated/prisma/enums.js';
import { ApiException } from '../common/api-exception.js';
import { executeGuardedUpdate } from '../common/guarded-update.js';
import { recordInitialOrderStatus } from '../common/order-status-transition.js';
import { CheckoutDto, CheckoutFulfillmentType } from './dto/checkout.dto.js';
import {
  CheckoutOrderLineResponseDto,
  CheckoutResponseDto,
  PagoMovilInstructionsDto,
} from './dto/checkout-response.dto.js';
import { SINGLETON_FX_RATE_ID } from './fx-rate.constants.js';
import { PAGO_MOVIL_PLACEHOLDER_ACCOUNT } from './pago-movil-instructions.constant.js';

/** Story 4.1 (AD-6): 24h soft-reservation window for a Pago Móvil StockHold. */
const STOCK_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

interface StockLineIssue {
  productId: string;
  productName: string;
  requested: number;
  available: number;
}

function insufficientStockException(items: StockLineIssue[]): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    'INSUFFICIENT_STOCK',
    'One or more cart lines no longer have enough stock available.',
    { items },
  );
}

/**
 * Story 4.1 (AD-17): generates the one-time opaque `orderAccessToken`
 * (`rawToken`, returned to the buyer exactly once) plus its SHA-256
 * `tokenHash` (the only thing ever persisted, on `Order.accessTokenHash`).
 *
 * **Why SHA-256 and not bcrypt/argon2** (this system already uses Argon2id
 * elsewhere, per AD-11, for AdminUser passwords): those slow, salted KDFs
 * exist specifically to make brute-forcing a *small, human-chosen* keyspace
 * (a memorable password) expensive. `rawToken` is not that — it's 256 bits
 * of output straight from Node's CSPRNG (`crypto.randomBytes(32)`), so
 * there is no small keyspace to brute-force in the first place; a fast
 * hash is not a weakness here the way it would be for a real password.
 * What AD-17 actually asks for is the *shape* "only a hash is persisted,
 * the raw value never touches the DB" (so a DB dump alone can't be replayed
 * as a valid token) — a single cryptographic hash already provides that,
 * and is the same class of primitive this codebase already trusts
 * elsewhere (HMAC-SHA256 signs the AD-5 cart cookie).
 */
function generateOrderAccessToken(): {
  rawToken: string;
  tokenHash: string;
} {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  return { rawToken, tokenHash };
}

@Injectable()
export class CheckoutService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Story 4.1 (FR-12, FR-13, FR-15 creation portion; AD-3, AD-4, AD-6, AD-7,
   * AD-8, AD-16, AD-17). `cartId` is whatever `CheckoutController` read from
   * the (already signature-verified) AD-5 cart cookie, or `null` when there
   * was none / it didn't verify — treated identically to "the cart is
   * empty" (see `emptyCartException`), since there is nothing to check out
   * either way.
   *
   * Everything from the Cart lookup through the StockHold guards runs in a
   * single Prisma transaction: if ANY line fails its stock re-validation
   * (the up-front pre-check) or its AD-6 guarded hold-creation UPDATE (the
   * real concurrency guarantee), the Order/OrderLines/StockHolds/Cart-
   * deletion already performed earlier in this same callback are rolled
   * back in full — the checkout either completes entirely or leaves no
   * trace, never a partially-created Order.
   */
  async checkout(
    cartId: string | null,
    dto: CheckoutDto,
  ): Promise<CheckoutResponseDto> {
    if (!cartId) {
      throw this.emptyCartException();
    }

    const isDelivery = dto.fulfillmentType === CheckoutFulfillmentType.DELIVERY;

    const result = await this.prisma.$transaction(async (tx) => {
      const cart = await tx.cart.findFirst({
        where: { id: cartId, expiresAt: { gt: new Date() } },
        include: {
          items: {
            include: {
              product: {
                select: {
                  id: true,
                  name: true,
                  priceUsd: true,
                  stock: true,
                  heldQty: true,
                },
              },
            },
            orderBy: { createdAt: 'asc' },
          },
        },
      });

      if (!cart || cart.items.length === 0) {
        throw this.emptyCartException();
      }

      // --- FR-12: re-validate stock for EVERY line, right now — never the
      // add-time check. This SELECT-based pre-check is informative (it can
      // report every failing line in one response); it is deliberately NOT
      // the actual concurrency guarantee. The guarded UPDATE loop further
      // below (AD-6) is what makes this race-safe against a concurrent
      // checkout — see that loop's own comment.
      const stockIssues: StockLineIssue[] = [];
      for (const item of cart.items) {
        const available = Math.max(
          item.product.stock - item.product.heldQty,
          0,
        );
        if (item.quantity > available) {
          stockIssues.push({
            productId: item.productId,
            productName: item.product.name,
            requested: item.quantity,
            available,
          });
        }
      }
      if (stockIssues.length > 0) {
        throw insufficientStockException(stockIssues);
      }

      // --- AD-3: money is Decimal throughout, never float. Each line's
      // total is rounded to 2dp individually (Decimal addition of already-
      // rounded values introduces no further precision loss, unlike
      // float — so summing needs no second rounding pass).
      let totalUsd = new Prisma.Decimal(0);
      const lineCreates: Prisma.OrderLineCreateManyOrderInput[] = [];
      for (const item of cart.items) {
        const unitPriceUsd = item.product.priceUsd;
        const lineTotalUsd = unitPriceUsd
          .times(item.quantity)
          .toDecimalPlaces(2);
        totalUsd = totalUsd.plus(lineTotalUsd);
        lineCreates.push({
          productId: item.productId,
          productName: item.product.name,
          unitPriceUsd,
          quantity: item.quantity,
          lineTotalUsd,
        });
      }

      // --- AD-3/AD-4: read the single admin-maintained rate and snapshot
      // it + the computed VES total ONCE, here, never recomputed later.
      const fxRate = await tx.fxRateSetting.findUnique({
        where: { id: SINGLETON_FX_RATE_ID },
      });
      if (!fxRate) {
        // Ops/seed error, not a buyer-facing 4xx: the seed is expected to
        // always have written this row (see fx-rate.constants.ts's doc
        // comment for the known gap this covers).
        throw new Error(
          `FxRateSetting row "${SINGLETON_FX_RATE_ID}" is missing — the store has no configured VES/USD rate. Run the seed.`,
        );
      }
      const totalVes = totalUsd.times(fxRate.vesPerUsd).toDecimalPlaces(2);

      // --- AD-17: raw token returned to the buyer exactly once below;
      // only its hash is ever written to the DB.
      const { rawToken, tokenHash } = generateOrderAccessToken();

      const order = await tx.order.create({
        data: {
          status: OrderStatus.PENDING_VERIFICATION,
          paymentRail: PaymentRail.PAGO_MOVIL,
          fulfillmentType: isDelivery
            ? FulfillmentType.DELIVERY
            : FulfillmentType.PICKUP,
          recipientName: dto.recipientName,
          recipientPhone: dto.recipientPhone,
          // AD-8: address fields only populated for delivery; country is
          // hardcoded (never buyer input — see CheckoutDto's doc comment).
          addressLine1: isDelivery ? (dto.addressLine1 ?? null) : null,
          addressLine2: isDelivery ? (dto.addressLine2 ?? null) : null,
          city: isDelivery ? (dto.city ?? null) : null,
          state: isDelivery ? (dto.state ?? null) : null,
          country: isDelivery ? 'Venezuela' : null,
          totalUsd,
          fxRateVesPerUsd: fxRate.vesPerUsd,
          totalVes,
          accessTokenHash: tokenHash,
          lines: { createMany: { data: lineCreates } },
        },
      });

      // --- AD-6: guarded atomic hold creation, per line. `Cart_Items`
      // guarantees at most one row per Product (Story 3.1's
      // `@@unique([cartId, productId])`), so each Product here is guarded
      // exactly once. Zero affected rows on ANY line means that Product's
      // available stock (evaluated by Postgres itself, under a real row
      // lock, at the instant of this UPDATE — not this function's earlier
      // SELECT-based pre-check) no longer covers the requested quantity;
      // this is what actually makes two concurrent checkouts racing the
      // same Product's last units safe — the second one's guarded UPDATE
      // blocks on the first's row lock, then re-evaluates the WHERE guard
      // against the FIRST checkout's already-committed heldQty increase,
      // so the two can never both succeed past physical stock (see this
      // story's dedicated concurrency test).
      for (const item of cart.items) {
        const affected = await executeGuardedUpdate(
          tx,
          Prisma.sql`
            UPDATE "Products"
            SET "heldQty" = "heldQty" + ${item.quantity}
            WHERE id = ${item.productId}::uuid
              AND stock - "heldQty" >= ${item.quantity}
          `,
        );

        if (affected === 0) {
          const product = await tx.product.findUniqueOrThrow({
            where: { id: item.productId },
            select: { name: true, stock: true, heldQty: true },
          });
          const available = Math.max(product.stock - product.heldQty, 0);
          throw insufficientStockException([
            {
              productId: item.productId,
              productName: product.name,
              requested: item.quantity,
              available,
            },
          ]);
        }

        await tx.stockHold.create({
          data: {
            orderId: order.id,
            productId: item.productId,
            quantity: item.quantity,
            expiresAt: new Date(Date.now() + STOCK_HOLD_TTL_MS),
          },
        });
      }

      // --- AD-7: []->pending_verification, actorType=system. Pago Móvil
      // never passes through payment_processing (PayPal-only, Story 4.3).
      await recordInitialOrderStatus(tx, {
        orderId: order.id,
        toStatus: OrderStatus.PENDING_VERIFICATION,
        actorType: OrderActorType.SYSTEM,
      });

      // --- AD-5: a successful checkout clears the Cart. Deleting the Cart
      // row cascades to its CartItems via the existing `onDelete: Cascade`
      // FK (Story 3.1's schema) — no separate CartItem delete needed.
      await tx.cart.delete({ where: { id: cart.id } });

      return {
        orderId: order.id,
        totalUsd,
        lines: lineCreates,
        fxRateVesPerUsd: fxRate.vesPerUsd,
        totalVes,
        rawToken,
      };
    });

    return this.toResponseDto(result);
  }

  private emptyCartException(): ApiException {
    // 422, not 400/409: the request body itself is syntactically valid (a
    // well-formed CheckoutDto), and this is not a conflict with another
    // actor's concurrent change either (this codebase's existing use of
    // 409, e.g. INSUFFICIENT_STOCK) — it's that the operation is
    // semantically impossible to carry out given the current state of a
    // referenced resource (an empty/nonexistent cart has nothing to check
    // out). 422 Unprocessable Entity is the closest standard REST fit.
    return new ApiException(
      HttpStatus.UNPROCESSABLE_ENTITY,
      'EMPTY_CART',
      'Your cart is empty — there is nothing to check out.',
    );
  }

  private toResponseDto(result: {
    orderId: string;
    totalUsd: Prisma.Decimal;
    lines: Prisma.OrderLineCreateManyOrderInput[];
    fxRateVesPerUsd: Prisma.Decimal;
    totalVes: Prisma.Decimal;
    rawToken: string;
  }): CheckoutResponseDto {
    const lineDtos: CheckoutOrderLineResponseDto[] = result.lines.map(
      (line) => ({
        productId: line.productId,
        productName: line.productName,
        unitPriceUsd: Number(line.unitPriceUsd),
        quantity: line.quantity,
        lineTotalUsd: Number(line.lineTotalUsd),
      }),
    );

    const paymentInstructions: PagoMovilInstructionsDto = {
      ...PAGO_MOVIL_PLACEHOLDER_ACCOUNT,
      reference: result.orderId,
    };

    return {
      orderId: result.orderId,
      status: OrderStatus.PENDING_VERIFICATION.toLowerCase(),
      totalUsd: Number(result.totalUsd),
      fxRateVesPerUsd: Number(result.fxRateVesPerUsd),
      totalVes: Number(result.totalVes),
      lines: lineDtos,
      paymentInstructions,
      orderAccessToken: result.rawToken,
    };
  }
}
