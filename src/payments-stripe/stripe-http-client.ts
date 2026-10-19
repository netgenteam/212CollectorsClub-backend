import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import {
  CreateStripeCheckoutSessionParams,
  CreateStripeCheckoutSessionResult,
  StripeClient,
  StripeWebhookEvent,
} from './stripe-client.interface.js';
import { verifyAndNormalizeWebhook } from './stripe-webhook-verification.js';

/**
 * `apiVersion` pinned explicitly to the one bundled with the installed SDK
 * (stripe@23.0.0) so a later SDK bump never silently changes API behavior.
 */
export const STRIPE_API_VERSION = '2026-09-30.endive';

/**
 * Story 14.3 (AD-45): real Stripe client. Not exercised against the network
 * by any test (no keys available); `parseWebhook` is local and is covered by
 * the shared signature unit tests.
 */
export class StripeHttpClient implements StripeClient {
  private readonly stripe: Stripe;
  private readonly webhookSecret: string;

  constructor(configService: ConfigService) {
    this.stripe = new Stripe(
      configService.getOrThrow<string>('STRIPE_SECRET_KEY'),
      { apiVersion: STRIPE_API_VERSION },
    );
    this.webhookSecret = configService.getOrThrow<string>(
      'STRIPE_WEBHOOK_SECRET',
    );
  }

  async createCheckoutSession(
    params: CreateStripeCheckoutSessionParams,
  ): Promise<CreateStripeCheckoutSessionResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'payment',
      client_reference_id: params.orderId,
      metadata: { orderId: params.orderId },
      payment_intent_data: { metadata: { orderId: params.orderId } },
      customer_email: params.customerEmail,
      success_url: params.successUrl,
      cancel_url: params.cancelUrl,
      expires_at: Math.floor(params.expiresAt.getTime() / 1000),
      line_items: params.lines.map((l) => ({
        quantity: l.quantity,
        price_data: {
          currency: params.currency,
          unit_amount: l.unitAmountCents,
          product_data: { name: l.name },
        },
      })),
    });
    if (!session.url) {
      throw new Error('Stripe returned a Checkout Session without a url');
    }
    return { sessionId: session.id, url: session.url };
  }

  parseWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): StripeWebhookEvent {
    return verifyAndNormalizeWebhook(rawBody, signature, this.webhookSecret);
  }
}
