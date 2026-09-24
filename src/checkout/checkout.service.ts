import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashOrderAccessToken } from '../common/order-access-token.js';
import { Prisma } from '../generated/prisma/client.js';
import {
  FulfillmentType,
  OrderActorType,
  OrderStatus,
  PaymentRail,
} from '../generated/prisma/enums.js';
import { ApiException } from '../common/api-exception.js';
import { executeGuardedUpdate } from '../common/guarded-update.js';
import {
  guardedOrderStatusTransition,
  recordInitialOrderStatus,
} from '../common/order-status-transition.js';
import { PAYPAL_CLIENT } from '../payments-paypal/paypal-client.interface.js';
import type {
  CreatePaypalOrderResult,
  PaypalClient,
} from '../payments-paypal/paypal-client.interface.js';
import {
  CheckoutDto,
  CheckoutFulfillmentType,
  CheckoutPaymentRail,
} from './dto/checkout.dto.js';
import {
  CheckoutOrderLineResponseDto,
  CheckoutResponseDto,
  PagoMovilInstructionsDto,
  PaypalCheckoutSessionDto,
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
 * Story 4.3: the checkout itself always succeeds in creating the Order
 * (status `payment_processing`, committed in its own DB transaction —
 * see `checkout`'s own doc comment for why the PayPal API call below is
 * deliberately OUTSIDE that transaction) before this is ever thrown — this
 * is only reachable if the follow-up call to PayPal's own order-creation
 * API fails. 502, not 500: the failure is in an upstream dependency
 * (PayPal), not this server's own logic.
 */
function paypalOrderCreationFailedException(): ApiException {
  return new ApiException(
    HttpStatus.BAD_GATEWAY,
    'PAYPAL_ORDER_CREATION_FAILED',
    'Could not create a PayPal order for this checkout — the checkout was not completed. Please try again.',
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
 *
 * The hashing step itself lives in `common/order-access-token.ts`
 * (`hashOrderAccessToken`) as of Story 4.2, so every later buyer-facing
 * Order route gated by AD-17 (Proof-of-Payment upload, order lookup)
 * verifies a submitted token with the exact same algorithm instead of a
 * second implementation — this function only adds the "also generate a
 * fresh random raw token" half, which only checkout itself ever needs.
 */
function generateOrderAccessToken(): {
  rawToken: string;
  tokenHash: string;
} {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashOrderAccessToken(rawToken);
  return { rawToken, tokenHash };
}

/** What the DB transaction inside `checkout` hands back to the (non-
 * transactional) code that runs after it commits — enough for either
 * branch (`toResponseDto` directly for pago_movil, `finalizePaypalCheckout`
 * first for paypal) to build the final response. */
interface CheckoutTransactionResult {
  orderId: string;
  status: OrderStatus;
  paymentRail: PaymentRail;
  totalUsd: Prisma.Decimal;
  lines: Prisma.OrderLineCreateManyOrderInput[];
  /** Story 4.3 (AD-3): null for a paypal checkout. */
  fxRateVesPerUsd: Prisma.Decimal | null;
  /** Story 4.3 (AD-3): null for a paypal checkout. */
  totalVes: Prisma.Decimal | null;
  rawToken: string;
}

@Injectable()
export class CheckoutService {
  private readonly logger = new Logger(CheckoutService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYPAL_CLIENT) private readonly paypalClient: PaypalClient,
  ) {}

  /**
   * Story 4.1 (FR-12, FR-13, FR-15 creation portion; AD-3, AD-4, AD-6, AD-7,
   * AD-8, AD-16, AD-17) + Story 4.3 (FR-12 paypal branch; AD-3, AD-7,
   * AD-13). `cartId` is whatever `CheckoutController` read from the
   * (already signature-verified) AD-5 cart cookie, or `null` when there
   * was none / it didn't verify — treated identically to "the cart is
   * empty" (see `emptyCartException`), since there is nothing to check out
   * either way.
   *
   * Stock re-validation, the price/line snapshot, and the Order+OrderLine
   * creation are SHARED between both payment rails (this is the "shared
   * logic with Story 4.1" the Story 4.3 Acceptance Criteria call for) —
   * they diverge only in: whether an FX/VES snapshot is taken at all (AD-3:
   * pago_movil only), whether a per-line AD-6 StockHold is guardedly
   * created (pago_movil only — a paypal Order never holds stock, per AD-13
   * and this story's own design note), and which initial `OrderStatus`
   * `recordInitialOrderStatus` writes (`pending_verification` vs.
   * `payment_processing`).
   *
   * Everything through the shared-logic branch above runs in a single
   * Prisma transaction, same guarantee Story 4.1 already established: if
   * ANY line fails its stock re-validation or (pago_movil only) its AD-6
   * guarded hold-creation UPDATE, everything already done in this same
   * transaction callback rolls back in full.
   *
   * **Why the PayPal API call is deliberately OUTSIDE that transaction**
   * (see `finalizePaypalCheckout`): holding a DB transaction open across an
   * external HTTP round trip to PayPal would hold row locks/a pooled
   * connection for the duration of that network call — a well-known
   * anti-pattern this codebase has no other precedent for (Story 6.1's
   * MailerService is the closest prior external-call case, and it is
   * likewise called only after its own DB write already committed, for the
   * same reason). Instead: the Order commits as `payment_processing`
   * first, then PayPal's own order is created, then `Order.paypalOrderId`
   * is filled in with a plain follow-up update. See
   * `finalizePaypalCheckout`'s own doc comment for what happens if the
   * PayPal call itself fails.
   */
  async checkout(
    cartId: string | null,
    dto: CheckoutDto,
  ): Promise<CheckoutResponseDto> {
    if (!cartId) {
      throw this.emptyCartException();
    }

    const isDelivery = dto.fulfillmentType === CheckoutFulfillmentType.DELIVERY;
    const isPaypal = dto.paymentRail === CheckoutPaymentRail.PAYPAL;

    const result = await this.prisma.$transaction(
      async (tx): Promise<CheckoutTransactionResult> => {
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
        // report every failing line in one response); for pago_movil it is
        // deliberately NOT the actual concurrency guarantee (the guarded
        // UPDATE loop further below, AD-6, is). For paypal — which never
        // holds stock at all — this pre-check IS the only re-validation
        // checkout itself performs; the real, final guard for a paypal
        // Order is the AD-13 guarded decrement `PaypalPaymentsService` runs
        // at payment-confirmation time, not here.
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

        // --- AD-3: a paypal Order never snapshots an FX rate or a VES
        // total — only pago_movil does. `fxRate`/`totalVes` stay null.
        let fxRate: { vesPerUsd: Prisma.Decimal } | null = null;
        let totalVes: Prisma.Decimal | null = null;
        if (!isPaypal) {
          fxRate = await tx.fxRateSetting.findUnique({
            where: { id: SINGLETON_FX_RATE_ID },
          });
          if (!fxRate) {
            // Ops/seed error, not a buyer-facing 4xx: the seed is expected
            // to always have written this row (see fx-rate.constants.ts's
            // doc comment for the known gap this covers).
            throw new Error(
              `FxRateSetting row "${SINGLETON_FX_RATE_ID}" is missing — the store has no configured VES/USD rate. Run the seed.`,
            );
          }
          totalVes = totalUsd.times(fxRate.vesPerUsd).toDecimalPlaces(2);
        }

        // --- AD-17: raw token returned to the buyer exactly once below;
        // only its hash is ever written to the DB.
        const { rawToken, tokenHash } = generateOrderAccessToken();

        // --- AD-7: a pago_movil Order enters pending_verification
        // directly; a paypal Order enters the transient payment_processing
        // state instead (Story 4.3's own state, resolved later by
        // PaypalPaymentsService).
        const initialStatus = isPaypal
          ? OrderStatus.PAYMENT_PROCESSING
          : OrderStatus.PENDING_VERIFICATION;

        const order = await tx.order.create({
          data: {
            status: initialStatus,
            paymentRail: isPaypal ? PaymentRail.PAYPAL : PaymentRail.PAGO_MOVIL,
            fulfillmentType: isDelivery
              ? FulfillmentType.DELIVERY
              : FulfillmentType.PICKUP,
            recipientName: dto.recipientName,
            recipientPhone: dto.recipientPhone,
            // AD-8: address fields only populated for delivery; country is
            // hardcoded (never buyer input — see CheckoutDto's doc comment).
            // Orthogonal to paymentRail — applies identically to both.
            addressLine1: isDelivery ? (dto.addressLine1 ?? null) : null,
            addressLine2: isDelivery ? (dto.addressLine2 ?? null) : null,
            city: isDelivery ? (dto.city ?? null) : null,
            state: isDelivery ? (dto.state ?? null) : null,
            country: isDelivery ? 'Venezuela' : null,
            totalUsd,
            fxRateVesPerUsd: fxRate?.vesPerUsd ?? null,
            totalVes,
            accessTokenHash: tokenHash,
            lines: { createMany: { data: lineCreates } },
          },
        });

        // --- AD-6/AD-13: ONLY pago_movil guardedly reserves stock at
        // checkout time. A paypal Order never holds stock at all — see this
        // story's own design note; the real stock guard for it is the
        // AD-13 guarded decrement PaypalPaymentsService runs at
        // confirmation time, not here.
        if (!isPaypal) {
          // `Cart_Items` guarantees at most one row per Product (Story
          // 3.1's `@@unique([cartId, productId])`), so each Product here is
          // guarded exactly once. Zero affected rows on ANY line means that
          // Product's available stock (evaluated by Postgres itself, under
          // a real row lock, at the instant of this UPDATE — not this
          // function's earlier SELECT-based pre-check) no longer covers the
          // requested quantity; this is what actually makes two concurrent
          // checkouts racing the same Product's last units safe — the
          // second one's guarded UPDATE blocks on the first's row lock,
          // then re-evaluates the WHERE guard against the FIRST checkout's
          // already-committed heldQty increase, so the two can never both
          // succeed past physical stock (see Story 4.1's dedicated
          // concurrency test).
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
        }

        // --- AD-7: []->pending_verification (pago_movil) or
        // []->payment_processing (paypal), actorType=system.
        await recordInitialOrderStatus(tx, {
          orderId: order.id,
          toStatus: initialStatus,
          actorType: OrderActorType.SYSTEM,
        });

        // --- AD-5: a successful checkout clears the Cart. Deleting the Cart
        // row cascades to its CartItems via the existing `onDelete: Cascade`
        // FK (Story 3.1's schema) — no separate CartItem delete needed.
        // Applies to both rails: the Order snapshot already captured the
        // cart's contents, so there is nothing left for the buyer to edit
        // while they finish paying (whether that's off at PayPal, or by
        // Pago Móvil transfer).
        await tx.cart.delete({ where: { id: cart.id } });

        return {
          orderId: order.id,
          status: initialStatus,
          paymentRail: order.paymentRail,
          totalUsd,
          lines: lineCreates,
          fxRateVesPerUsd: fxRate?.vesPerUsd ?? null,
          totalVes,
          rawToken,
        };
      },
    );

    if (isPaypal) {
      return this.finalizePaypalCheckout(result);
    }
    return this.toResponseDto(result, null);
  }

  /**
   * Story 4.3: runs strictly AFTER the checkout transaction above has
   * already committed (the Order exists, `payment_processing`, no
   * StockHold) — see `checkout`'s own doc comment for why this external
   * call is deliberately not inside that transaction.
   *
   * On success: asks the injected `PaypalClient` to create PayPal's own
   * order/session, persists the returned `paypalOrderId` onto the already-
   * committed Order (a plain update — no status guard needed, nothing else
   * can be racing this specific field on a freshly-created Order only this
   * request knows the id of yet), and returns the full response including
   * the `approveUrl` the frontend redirects the buyer to.
   *
   * On failure: the Order already exists in `payment_processing` with no
   * `paypalOrderId` — payment can never proceed for it (there is no PayPal
   * order to confirm against). Rather than leaving it silently stuck until
   * Story 5.2's 30-minute timeout cron eventually catches it, this
   * guardedly (AD-16) fails it immediately, best-effort: a failure of THIS
   * best-effort transition is logged and swallowed, never masking the
   * original PayPal error the caller actually needs to see (as a 502).
   */
  private async finalizePaypalCheckout(
    result: CheckoutTransactionResult,
  ): Promise<CheckoutResponseDto> {
    let session: CreatePaypalOrderResult;
    try {
      session = await this.paypalClient.createOrder({
        orderId: result.orderId,
        totalUsd: result.totalUsd.toFixed(2),
      });
    } catch (err) {
      this.logger.error(
        `PayPal order creation failed for Order ${result.orderId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.prisma
        .$transaction((tx) =>
          guardedOrderStatusTransition(tx, {
            orderId: result.orderId,
            fromStatus: OrderStatus.PAYMENT_PROCESSING,
            toStatus: OrderStatus.PAYMENT_FAILED,
            actorType: OrderActorType.SYSTEM,
          }),
        )
        .catch((transitionErr: unknown) => {
          this.logger.error(
            `Also failed to auto-fail Order ${result.orderId} after the PayPal order-creation error above: ${transitionErr instanceof Error ? transitionErr.message : String(transitionErr)}`,
          );
        });
      throw paypalOrderCreationFailedException();
    }

    await this.prisma.order.update({
      where: { id: result.orderId },
      data: { paypalOrderId: session.paypalOrderId },
    });

    return this.toResponseDto(result, session);
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

  /** Story 4.3: `paypalSession` is `null` for a pago_movil checkout (which
   * gets `paymentInstructions` instead — exactly one of the two is ever
   * non-null on the resulting DTO, per `CheckoutResponseDto`'s own doc
   * comment). */
  private toResponseDto(
    result: CheckoutTransactionResult,
    paypalSession: CreatePaypalOrderResult | null,
  ): CheckoutResponseDto {
    const lineDtos: CheckoutOrderLineResponseDto[] = result.lines.map(
      (line) => ({
        productId: line.productId,
        productName: line.productName,
        unitPriceUsd: Number(line.unitPriceUsd),
        quantity: line.quantity,
        lineTotalUsd: Number(line.lineTotalUsd),
      }),
    );

    const isPaypal = result.paymentRail === PaymentRail.PAYPAL;

    const paymentInstructions: PagoMovilInstructionsDto | null = isPaypal
      ? null
      : {
          ...PAGO_MOVIL_PLACEHOLDER_ACCOUNT,
          reference: result.orderId,
        };

    const paypal: PaypalCheckoutSessionDto | null = paypalSession
      ? {
          paypalOrderId: paypalSession.paypalOrderId,
          approveUrl: paypalSession.approveUrl,
        }
      : null;

    return {
      orderId: result.orderId,
      status: result.status.toLowerCase(),
      totalUsd: Number(result.totalUsd),
      fxRateVesPerUsd:
        result.fxRateVesPerUsd !== null ? Number(result.fxRateVesPerUsd) : null,
      totalVes: result.totalVes !== null ? Number(result.totalVes) : null,
      lines: lineDtos,
      paymentInstructions,
      paypal,
      orderAccessToken: result.rawToken,
    };
  }
}
