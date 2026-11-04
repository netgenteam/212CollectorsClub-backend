import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { hashOrderAccessToken } from '../common/order-access-token.js';
import { Prisma } from '../generated/prisma/client.js';
import type { FxRateSource } from '../generated/prisma/client.js';
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
import { releaseOrderHolds } from '../common/order-stock-holds.js';
import { invalidCustomerTokenException } from '../common/customer-auth.guard.js';
import type { AuthenticatedCustomer } from '../common/customer-auth.guard.js';
import { AuditService } from '../audit/audit.service.js';
import {
  orderStatusChangedEvent,
  SYSTEM_ACTOR,
} from '../audit/audit-events.js';
import { STRIPE_CLIENT } from '../payments-stripe/stripe-client.interface.js';
import type {
  CreateStripeCheckoutSessionResult,
  StripeClient,
} from '../payments-stripe/stripe-client.interface.js';
import { DEFAULT_FRONTEND_URL } from '../auth-core/customer-mail.js';
import { CheckoutDto, CheckoutPaymentRail } from './dto/checkout.dto.js';
import {
  CheckoutOrderLineResponseDto,
  CheckoutResponseDto,
  PagoMovilInstructionsDto,
  StripeCheckoutSessionDto,
} from './dto/checkout-response.dto.js';
import { ShippingValidationService } from '../shipping/shipping-validation.service.js';
import {
  assertCheckoutShippingPreconditions,
  cleanCheckoutRecipient,
  isNewShippingFormat,
  prepareCheckoutIdDoc,
  resolveCheckoutShipping,
  type OrderShippingData,
} from './checkout-shipping.js';
import {
  buyerIdInvalid,
  buyerIdRequired,
  isBuyerIdRequired,
  resolveBuyerId,
  type CheckoutShippingFormat,
  type ResolvedBuyerId,
} from './buyer-id.js';
import {
  assertExpectedCustomer,
  customerAnonymizedAtExists,
  lockCustomerForCheckout,
} from './checkout-account-lock.js';
import type { BuyerIdType } from '../generated/prisma/enums.js';
import type { PreparedIdDoc } from '../crypto/id-doc-crypto.service.js';
import { IdDocCryptoService } from '../crypto/id-doc-crypto.service.js';
import { FxRateService } from '../fx/fx-rate.service.js';
import { ConsentService } from '../legal/consent.service.js';
import { ConsentContext } from '../generated/prisma/enums.js';
import { PAGO_MOVIL_PLACEHOLDER_ACCOUNT } from './pago-movil-instructions.constant.js';

/** Story 4.1 (AD-6): 24h soft-reservation window for a Pago Móvil StockHold. */
const STOCK_HOLD_TTL_MS = 24 * 60 * 60 * 1000;
/** Story 14.5b (AD-50): Stripe hold = 60 min timeout cron + 5 min margin.
 * Informative/defensive only: the stock-hold-expiry cron never sees
 * PAYMENT_PROCESSING Orders. */
const STRIPE_STOCK_HOLD_TTL_MS = 65 * 60 * 1000;

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

/** Story 12.6 (FR-43, AD-28): account checkout requires a verified email. */
function emailNotVerifiedException(): ApiException {
  return new ApiException(
    HttpStatus.CONFLICT,
    'EMAIL_NOT_VERIFIED',
    'Verify your email address before checking out with your account.',
  );
}

/** Story 14.4 (AD-46): Stripe's minimum `expires_at` is 30 min from now. */
const STRIPE_SESSION_TTL_MS = 30 * 60 * 1000;
/** Stripe limits `product_data.name` to 250 chars. */
const STRIPE_LINE_NAME_MAX = 250;

/** Story 14.4 (AD-46): 502, upstream (Stripe) failed; the Order is already
 * moved to payment_failed by the time this is thrown. */
function stripeSessionCreationFailedException(): ApiException {
  return new ApiException(
    HttpStatus.BAD_GATEWAY,
    'STRIPE_SESSION_CREATION_FAILED',
    'Could not create a Stripe checkout session for this order — the checkout was not completed. Please try again.',
  );
}

/**
 * Story 14.4: Decimal(10,2) USD -> integer cents without floats
 * (Decimal -> fixed 2dp string -> digits).
 */
export function usdToCents(amount: Prisma.Decimal): number {
  const fixed = amount.toFixed(2); // e.g. "89.99"
  const negative = fixed.startsWith('-');
  const digits = fixed.replace('-', '').replace('.', '');
  const cents = parseInt(digits, 10);
  return negative ? -cents : cents;
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
 * branch (`toResponseDto` directly for pago_movil, `finalizeStripeCheckout`
 * first for stripe) to build the final response. */
interface CheckoutTransactionResult {
  orderId: string;
  status: OrderStatus;
  paymentRail: PaymentRail;
  totalUsd: Prisma.Decimal;
  lines: Prisma.OrderLineCreateManyOrderInput[];
  /** Story 4.3 (AD-3): null for a stripe checkout. */
  fxRateVesPerUsd: Prisma.Decimal | null;
  /** Story 18.3: source of the snapshotted rate; null for stripe. */
  fxRateSource: FxRateSource | null;
  /** Story 4.3 (AD-3): null for a stripe checkout. */
  totalVes: Prisma.Decimal | null;
  rawToken: string;
  /** Story 14.4: account email (logged-in checkouts only) to prefill Stripe. */
  customerEmail?: string;
}

@Injectable()
export class CheckoutService implements OnModuleInit {
  private readonly logger = new Logger(CheckoutService.name);

  /** Story 20.4: a production process that does not enforce the buyer ID says so at boot (once). */
  onModuleInit(): void {
    if (process.env.NODE_ENV === 'production' && !isBuyerIdRequired()) {
      this.logger.warn(
        'CHECKOUT_REQUIRE_BUYER_ID is not "true": checkouts WITHOUT a buyer fiscal ID are accepted (docs/deployment.md 16.2). Turn it on together with the storefront of Story 20.9.',
      );
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STRIPE_CLIENT) private readonly stripeClient: StripeClient,
    private readonly config: ConfigService,
    private readonly shipping: ShippingValidationService,
    private readonly fxRates: FxRateService,
    private readonly consent: ConsentService,
    private readonly idDocCrypto: IdDocCryptoService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Story 4.1 (FR-12, FR-13, FR-15 creation portion; AD-3, AD-4, AD-6, AD-7,
   * AD-8, AD-16, AD-17) + Story 14.4 (stripe branch; AD-46, AD-50). `cartId` is whatever `CheckoutController` read from the
   * (already signature-verified) AD-5 cart cookie, or `null` when there
   * was none / it didn't verify — treated identically to "the cart is
   * empty" (see `emptyCartException`), since there is nothing to check out
   * either way.
   *
   * Stock re-validation, the price/line snapshot, the per-line AD-6
   * StockHold and the Order+OrderLine creation are SHARED between both
   * payment rails; they diverge only in: whether an FX/VES snapshot is
   * taken (AD-3: pago_movil only), the StockHold TTL, and which initial
   * `OrderStatus` is written (`pending_verification` vs.
   * `payment_processing`).
   *
   * Everything through the shared-logic branch runs in a single Prisma
   * transaction: if ANY line fails its stock re-validation or its AD-6
   * guarded hold-creation UPDATE, everything done in this transaction rolls
   * back in full.
   *
   * The Stripe API call is deliberately OUTSIDE that transaction (see
   * `finalizeStripeCheckout`): holding a DB transaction open across an
   * external HTTP round trip would hold row locks/a pooled connection for
   * the duration of that network call.
   */
  async checkout(
    cartId: string | null,
    dto: CheckoutDto,
    customer: Pick<AuthenticatedCustomer, 'id'> | null = null,
  ): Promise<CheckoutResponseDto> {
    // Story 20.4: the storefront's idea of "who am I" must match the session of THIS request
    // (race between GET /auth/me and this POST). 409, nothing created, no DB touched.
    assertExpectedCustomer(dto.expectedCustomerId, customer?.id ?? null);

    // Story 17.4 (AD-74): DB-free shipping gates, before touching cart/stock.
    assertCheckoutShippingPreconditions(dto, customer !== null);

    // Story 20.4 (AC1, AD-97): the buyer fiscal ID is resolved FIRST, pure and with no DB, so a
    // missing/invalid one is a 400 with no Order and no StockHold. Mandatory only when
    // CHECKOUT_REQUIRE_BUYER_ID=true (docs/deployment.md 16.2); always validated when sent.
    const shippingFormat: CheckoutShippingFormat =
      dto.customerAddressId !== undefined
        ? 'saved'
        : isNewShippingFormat(dto)
          ? 'agency'
          : 'flat';
    const buyer = resolveBuyerId(
      dto,
      {
        format: shippingFormat,
        recipientIdDoc: cleanCheckoutRecipient(dto).dto.recipientIdDoc ?? null,
      },
      { required: isBuyerIdRequired() },
    );
    // Encrypted here too (a few microseconds, cannot throw inside the transaction).
    const preparedBuyer: PreparedIdDoc | null =
      buyer.kind === 'explicit'
        ? this.idDocCrypto.protect(buyer.canonical)
        : null;

    // Story 12.6 (AD-31): with a session the cart is the ACCOUNT's cart
    // (the anonymous cookie is ignored); without one nothing changes.
    let accountEmail: string | undefined;
    if (customer) {
      // Read from the DB, not from the session snapshot: no stale "verified".
      const account = await this.prisma.customer.findUnique({
        where: { id: customer.id },
        select: { emailVerified: true, email: true },
      });
      if (!account) {
        throw invalidCustomerTokenException();
      }
      if (!account.emailVerified) {
        throw emailNotVerifiedException();
      }
      accountEmail = account.email;
    } else if (!cartId) {
      throw this.emptyCartException();
    }

    // Story 14.4 (AD-46): stripe has no VES snapshot and enters
    // payment_processing; pago_movil snapshots FX and enters
    // pending_verification.
    const isStripe = dto.paymentRail === CheckoutPaymentRail.STRIPE;

    // Story 20.3 (AD-96/97): the cedula is normalized and encrypted HERE, before the
    // transaction opens (synchronous, no I/O, a few microseconds).
    const preparedIdDoc = prepareCheckoutIdDoc(dto, this.idDocCrypto);

    // Story 20.4 (AC4): decided before the transaction so the FOR SHARE below is its FIRST statement.
    const lockAnonymized = customer
      ? await customerAnonymizedAtExists(this.prisma)
      : false;

    // Story 20.5 (AD-99): `CONSENT_RECORDED` is collected by `recordConsents` and flushed by
    // `audit.transaction` AFTER the callback: the chain-head lock is taken after the Products
    // rows (guarded UPDATEs), the Cart row and every other business lock, held only for the
    // INSERT and the COMMIT. Stripe is called after this transaction, never inside it.
    const result = await this.audit.transaction(
      async (tx, audit): Promise<CheckoutTransactionResult> => {
        // Story 20.4 (AC4): FIRST statement with a session (hook for 20.6, see checkout-account-lock.ts).
        if (customer && lockAnonymized) {
          await lockCustomerForCheckout(tx, customer.id);
        }

        // Story 19.4 (AD-92, FR-114): FIRST statement of the transaction,
        // before the cart is read, a StockHold is reserved or the Order is
        // created. Plain SELECTs (no lock held). Guests and accounts, both
        // rails, and the flat legacy format alike: every path to an Order
        // goes through this transaction.
        const accepted = await this.consent.assertAccepted(tx, {
          terms: dto.acceptedTermsVersion,
          shipping: dto.acceptedShippingVersion,
          returns: dto.acceptedReturnsVersion,
        });

        // Story 17.4: shipping (and saved-address snapshot) resolved inside
        // the checkout transaction.
        const shippingData = await resolveCheckoutShipping(
          tx,
          this.shipping,
          dto,
          customer?.id ?? null,
          { crypto: this.idDocCrypto, prepared: preparedIdDoc },
        );

        // Story 20.4 (AC3): what the order keeps as buyer ID. Inside the transaction only because
        // `buyerSameAsRecipient` with a saved address copies the cipher of the saved address.
        const buyerData = this.buyerOrderData(
          buyer,
          preparedBuyer,
          shippingData,
        );

        const cart = await tx.cart.findFirst({
          where: customer
            ? { customerId: customer.id }
            : {
                id: cartId as string,
                customerId: null,
                expiresAt: { gt: new Date() },
              },
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
        // UPDATE loop further below, AD-6, is).
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

        // --- AD-3: a stripe Order never snapshots an FX rate or a VES
        // total — only pago_movil does. `fxRate`/`totalVes` stay null.
        let fxRate: {
          vesPerUsd: Prisma.Decimal;
          source: FxRateSource;
        } | null = null;
        let totalVes: Prisma.Decimal | null = null;
        if (!isStripe) {
          // Story 18.3 (AD-80): one SELECT in this tx => coherent
          // (rate, source); 503 FX_RATE_UNAVAILABLE; never any network.
          fxRate = await this.fxRates.getForCheckout(tx);
          totalVes = totalUsd.times(fxRate.vesPerUsd).toDecimalPlaces(2);
        }

        // --- AD-17: raw token returned to the buyer exactly once below;
        // only its hash is ever written to the DB.
        const { rawToken, tokenHash } = generateOrderAccessToken();

        // --- AD-7: a pago_movil Order enters pending_verification
        // directly; a stripe Order enters the transient payment_processing
        // state instead (resolved later by the Stripe webhook / timeout cron).
        const initialStatus = isStripe
          ? OrderStatus.PAYMENT_PROCESSING
          : OrderStatus.PENDING_VERIFICATION;

        const order = await tx.order.create({
          data: {
            status: initialStatus,
            paymentRail: isStripe ? PaymentRail.STRIPE : PaymentRail.PAGO_MOVIL,
            fulfillmentType: FulfillmentType.DELIVERY,
            ...shippingData,
            ...buyerData,
            totalUsd,
            fxRateVesPerUsd: fxRate?.vesPerUsd ?? null,
            fxRateSource: fxRate?.source ?? null,
            totalVes,
            accessTokenHash: tokenHash,
            customerId: customer?.id ?? null,
            // Story 19.4: NULL for a document with no version in force (then
            // nothing was accepted, and no ConsentRecord exists for it).
            termsVersion: accepted.versions.terms?.versionNumber ?? null,
            shippingVersion: accepted.versions.shipping?.versionNumber ?? null,
            returnsVersion: accepted.versions.returns?.versionNumber ?? null,
            termsAcceptedAt: Object.keys(accepted.versions).length
              ? accepted.now
              : null,
            lines: { createMany: { data: lineCreates } },
          },
        });

        // Story 19.4: same transaction as the Order, so a later failure
        // (stock, empty cart) leaves no ConsentRecord behind.
        await this.consent.recordConsents(tx, {
          context: ConsentContext.CHECKOUT,
          orderId: order.id,
          customerId: customer?.id ?? null,
          accepted,
          keys: ['terms', 'shipping', 'returns'],
          audit,
        });

        // --- AD-6 / AD-50: both rails guardedly reserve stock at checkout.
        {
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
                expiresAt: new Date(
                  Date.now() +
                    (isStripe ? STRIPE_STOCK_HOLD_TTL_MS : STOCK_HOLD_TTL_MS),
                ),
              },
            });
          }
        }

        // --- AD-7: []->pending_verification (pago_movil) or
        // []->payment_processing (stripe), actorType=system.
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
        // while they finish paying (whether that's off at Stripe, or by
        // Pago Móvil transfer).
        // Of two concurrent checkouts of the SAME cart only one removes the
        // row; the other rolls back as an empty cart (P2025) instead of a 500.
        try {
          await tx.cart.delete({ where: { id: cart.id } });
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === 'P2025'
          ) {
            throw this.emptyCartException();
          }
          throw err;
        }

        return {
          orderId: order.id,
          status: initialStatus,
          paymentRail: order.paymentRail,
          totalUsd,
          lines: lineCreates,
          fxRateVesPerUsd: fxRate?.vesPerUsd ?? null,
          fxRateSource: fxRate?.source ?? null,
          totalVes,
          rawToken,
          customerEmail: accountEmail,
        };
      },
    );

    if (isStripe) {
      return this.finalizeStripeCheckout(result);
    }
    return this.toResponseDto(result, null);
  }

  /**
   * Story 20.4 (AC3, A87): the buyer columns of the order. Never the clear value.
   * - explicit: the cipher/blind prepared before the transaction.
   * - same-as-recipient: the recipient's `Enc/Blind` are COPIED (no re-encryption). The type
   *   letter comes from the body (agency format) or, for a saved address, from the stored
   *   cipher itself (`typeOfStored`, decrypts only inside `src/crypto/` and returns just the
   *   letter, after checking the blind index). Recipient cedulas are V/E by rule; anything else
   *   (a legacy row) is rejected.
   * Throws 400 BUYER_ID_REQUIRED / BUYER_ID_INVALID (details.field/reason); inside the
   * transaction, but before any stock is touched, so nothing is created.
   */
  private buyerOrderData(
    buyer: ResolvedBuyerId,
    prepared: PreparedIdDoc | null,
    shippingData: OrderShippingData,
  ): {
    buyerIdType: BuyerIdType | null;
    buyerIdDocEnc: string | null;
    buyerIdDocBlind: string | null;
    buyerLegalName: string | null;
  } {
    const none = {
      buyerIdType: null,
      buyerIdDocEnc: null,
      buyerIdDocBlind: null,
      buyerLegalName: null,
    };
    if (buyer.kind === 'none') return none;
    if (buyer.kind === 'explicit') {
      return {
        buyerIdType: buyer.type,
        buyerIdDocEnc: prepared?.enc ?? null,
        buyerIdDocBlind: prepared?.blind ?? null,
        buyerLegalName: buyer.legalName,
      };
    }
    const enc = shippingData.recipientIdDocEnc;
    const blind = shippingData.recipientIdDocBlind;
    if (!enc || !blind) {
      throw buyerIdRequired('buyerSameAsRecipient', 'RECIPIENT_ID_MISSING');
    }
    const type =
      buyer.fromBody?.type ?? this.idDocCrypto.typeOfStored(enc, blind);
    if (type !== 'V' && type !== 'E') {
      throw buyerIdInvalid('buyerSameAsRecipient', 'RECIPIENT_ID_NOT_VE');
    }
    return {
      buyerIdType: type,
      buyerIdDocEnc: enc,
      buyerIdDocBlind: blind,
      buyerLegalName: null,
    };
  }

  /**
   * Story 14.4 (AD-46): runs strictly AFTER the
   * checkout transaction committed. The amount comes only from the persisted
   * OrderLine snapshot (integer cents); nothing client-supplied is read. On
   * Stripe failure the Order is guardedly moved payment_processing ->
   * payment_failed and its holds are released in the same transaction (AD-50) and a 502
   * STRIPE_SESSION_CREATION_FAILED is thrown. Only the webhook (14.5) pays.
   */
  private async finalizeStripeCheckout(
    result: CheckoutTransactionResult,
  ): Promise<CheckoutResponseDto> {
    const frontendUrl = this.config
      .get<string>('FRONTEND_URL', DEFAULT_FRONTEND_URL)
      .replace(/\/+$/, '');
    const orderQuery = `orderId=${encodeURIComponent(result.orderId)}`;

    let session: CreateStripeCheckoutSessionResult;
    try {
      session = await this.stripeClient.createCheckoutSession({
        orderId: result.orderId,
        lines: result.lines.map((line) => ({
          name: line.productName.slice(0, STRIPE_LINE_NAME_MAX),
          // lineCreates always holds the product's Decimal(10,2) price.
          unitAmountCents: usdToCents(line.unitPriceUsd as Prisma.Decimal),
          quantity: line.quantity,
        })),
        currency: 'usd',
        customerEmail: result.customerEmail,
        successUrl: `${frontendUrl}/checkout/success?${orderQuery}`,
        cancelUrl: `${frontendUrl}/checkout/cancel?${orderQuery}`,
        expiresAt: new Date(Date.now() + STRIPE_SESSION_TTL_MS),
      });
    } catch (err) {
      this.logger.error(
        `Stripe session creation failed for Order ${result.orderId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.audit
        .transaction(async (tx, audit) => {
          await guardedOrderStatusTransition(tx, {
            orderId: result.orderId,
            fromStatus: OrderStatus.PAYMENT_PROCESSING,
            toStatus: OrderStatus.PAYMENT_FAILED,
            actorType: OrderActorType.SYSTEM,
          });
          // AD-50: same transaction as the transition (winner owns release).
          await releaseOrderHolds(tx, result.orderId);
          audit.add(
            orderStatusChangedEvent({
              actor: SYSTEM_ACTOR,
              orderId: result.orderId,
              from: OrderStatus.PAYMENT_PROCESSING,
              to: OrderStatus.PAYMENT_FAILED,
              reason: 'STRIPE_SESSION_CREATION_FAILED',
            }),
          );
        })
        .catch((transitionErr: unknown) => {
          this.logger.error(
            `Also failed to auto-fail Order ${result.orderId} after the Stripe session-creation error above: ${transitionErr instanceof Error ? transitionErr.message : String(transitionErr)}`,
          );
        });
      throw stripeSessionCreationFailedException();
    }

    await this.prisma.order.update({
      where: { id: result.orderId },
      data: { stripeCheckoutSessionId: session.sessionId },
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

  /** `stripeSession` is `null` for a pago_movil checkout (which gets
   * `paymentInstructions` instead — exactly one of the two is ever non-null
   * on the resulting DTO, per `CheckoutResponseDto`'s own doc comment). */
  private toResponseDto(
    result: CheckoutTransactionResult,
    stripeSession: CreateStripeCheckoutSessionResult | null,
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

    const hasInstructions = result.paymentRail === PaymentRail.PAGO_MOVIL;

    const paymentInstructions: PagoMovilInstructionsDto | null =
      !hasInstructions
        ? null
        : {
            ...PAGO_MOVIL_PLACEHOLDER_ACCOUNT,
            reference: result.orderId,
          };

    const stripe: StripeCheckoutSessionDto | null = stripeSession
      ? { sessionId: stripeSession.sessionId, url: stripeSession.url }
      : null;

    return {
      orderId: result.orderId,
      status: result.status.toLowerCase(),
      totalUsd: Number(result.totalUsd),
      fxRateVesPerUsd:
        result.fxRateVesPerUsd !== null ? Number(result.fxRateVesPerUsd) : null,
      fxRateSource: result.fxRateSource,
      totalVes: result.totalVes !== null ? Number(result.totalVes) : null,
      lines: lineDtos,
      paymentInstructions,
      stripe,
      orderAccessToken: result.rawToken,
    };
  }
}
