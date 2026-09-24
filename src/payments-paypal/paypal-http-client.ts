import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiError,
  CheckoutPaymentIntent,
  Client as PaypalSdkClient,
  Environment as PaypalSdkEnvironment,
  Order as PaypalSdkOrder,
  OrdersController,
  OrderStatus as PaypalSdkOrderStatus,
} from '@paypal/paypal-server-sdk';
import {
  CreatePaypalOrderParams,
  CreatePaypalOrderResult,
  PaypalCaptureStatus,
  PaypalClient,
  VerifyPaypalOrderResult,
} from './paypal-client.interface.js';

/**
 * Story 4.3 (Stack table): the real `PaypalClient` implementation, backed
 * by `@paypal/paypal-server-sdk` — the current officially-recommended
 * PayPal Node SDK (`@paypal/checkout-server-sdk` is deprecated per its own
 * maintainers). Activated automatically by `paypal-client.provider.ts` once
 * `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` are configured.
 *
 * **IMPORTANT, read before trusting this against production**: this class
 * has never been executed against a real PayPal account — this development
 * environment has no PayPal Sandbox credentials at all (see the Story 4.3
 * Dev report for the full explanation). It compiles cleanly against the
 * real SDK's published types and follows the SDK's documented request/
 * response shapes, but its actual runtime behavior against PayPal's API —
 * in particular `isAlreadyCapturedOrderError` below, whose error-shape
 * detection is written from PayPal's *documented* error format, not
 * observed from a real response — is UNVERIFIED. Angel should smoke-test
 * every method here against a real Sandbox order before relying on it (see
 * the Dev report's "what to verify against real PayPal Sandbox" section).
 */
export class PaypalHttpClient implements PaypalClient {
  private readonly logger = new Logger(PaypalHttpClient.name);
  private readonly ordersController: OrdersController;

  constructor(configService: ConfigService) {
    const clientId = configService.getOrThrow<string>('PAYPAL_CLIENT_ID');
    const clientSecret = configService.getOrThrow<string>(
      'PAYPAL_CLIENT_SECRET',
    );
    // Defaults to Sandbox — production requires an explicit opt-in via
    // PAYPAL_ENVIRONMENT=production, never the other way around, so a
    // missing/misspelled env var can never accidentally start moving real
    // money.
    const environment =
      configService.get<string>('PAYPAL_ENVIRONMENT') === 'production'
        ? PaypalSdkEnvironment.Production
        : PaypalSdkEnvironment.Sandbox;

    const client = new PaypalSdkClient({
      environment,
      clientCredentialsAuthCredentials: {
        oAuthClientId: clientId,
        oAuthClientSecret: clientSecret,
      },
    });
    this.ordersController = new OrdersController(client);
  }

  async createOrder(
    params: CreatePaypalOrderParams,
  ): Promise<CreatePaypalOrderResult> {
    const { result } = await this.ordersController.createOrder({
      body: {
        intent: CheckoutPaymentIntent.Capture,
        purchaseUnits: [
          {
            customId: params.orderId,
            amount: {
              currencyCode: 'USD',
              value: params.totalUsd,
            },
          },
        ],
      },
    });

    const approveLink = result.links?.find((link) => link.rel === 'approve');
    if (!result.id || !approveLink) {
      throw new Error(
        `PayPal createOrder response missing id or an "approve" link (orderId=${params.orderId}): ${JSON.stringify(result)}`,
      );
    }

    return { paypalOrderId: result.id, approveUrl: approveLink.href };
  }

  async captureAndVerifyOrder(
    paypalOrderId: string,
  ): Promise<VerifyPaypalOrderResult> {
    try {
      const { result } = await this.ordersController.captureOrder({
        id: paypalOrderId,
      });
      return this.toVerificationResult(paypalOrderId, result);
    } catch (err) {
      if (this.isAlreadyCapturedOrderError(err)) {
        // Tolerates an integration where the buyer's browser (via PayPal's
        // JS SDK) already completed the capture client-side before this
        // server-side confirmation ran — falls back to an independent GET,
        // still never trusting anything the webhook/client claimed.
        this.logger.log(
          `PayPal order ${paypalOrderId} was already captured — falling back to getOrder for independent verification.`,
        );
        const { result } = await this.ordersController.getOrder({
          id: paypalOrderId,
        });
        return this.toVerificationResult(paypalOrderId, result);
      }

      this.logger.error(
        `PayPal captureOrder failed for ${paypalOrderId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return {
        paypalOrderId,
        status: 'FAILED',
        internalOrderId: null,
        capturedTotalUsd: null,
      };
    }
  }

  private toVerificationResult(
    paypalOrderId: string,
    order: PaypalSdkOrder,
  ): VerifyPaypalOrderResult {
    const purchaseUnit = order.purchaseUnits?.[0];
    const capture = purchaseUnit?.payments?.captures?.[0];
    return {
      paypalOrderId,
      status: this.mapStatus(order.status),
      internalOrderId: capture?.customId ?? purchaseUnit?.customId ?? null,
      capturedTotalUsd: capture?.amount?.value ?? null,
    };
  }

  /**
   * Maps the SDK's `Order.status` (CREATED/SAVED/APPROVED/VOIDED/
   * COMPLETED/PAYER_ACTION_REQUIRED — there is no explicit "DECLINED"
   * status at the Order level; a declined funding source normally
   * surfaces as a thrown `ApiError` from `captureOrder` instead, handled
   * in the catch block above) onto this codebase's own binary-ish
   * `PaypalCaptureStatus`. Only `COMPLETED` is ever treated as "paid" by
   * `PaypalPaymentsService` — every other value here resolves the Order to
   * `payment_failed`, per this story's Acceptance Criteria (no third
   * "still pending" outcome is modeled at the webhook-handling level).
   */
  private mapStatus(
    status: PaypalSdkOrderStatus | undefined,
  ): PaypalCaptureStatus {
    switch (status) {
      case PaypalSdkOrderStatus.Completed:
        return 'COMPLETED';
      case PaypalSdkOrderStatus.Voided:
        return 'VOIDED';
      default:
        return 'FAILED';
    }
  }

  private isAlreadyCapturedOrderError(err: unknown): boolean {
    if (!(err instanceof ApiError)) {
      return false;
    }
    const body = JSON.stringify(err.result ?? {});
    return err.statusCode === 422 && body.includes('ORDER_ALREADY_CAPTURED');
  }
}
