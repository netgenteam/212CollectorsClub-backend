import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  CreateStripeCheckoutSessionParams,
  CreateStripeCheckoutSessionResult,
  StripeClient,
  StripeWebhookEvent,
} from './stripe-client.interface.js';
import { verifyAndNormalizeWebhook } from './stripe-webhook-verification.js';

export const FAKE_STRIPE_WEBHOOK_SECRET = 'whsec_fake_test_secret';

/**
 * Story 14.3 (AD-45): deterministic in-memory `StripeClient`, no network.
 * `createCheckoutSession` fabricates a session; `parseWebhook` verifies the
 * signature for real (local `constructEvent`) so invalid-signature behavior
 * is identical to `StripeHttpClient`. Registered as its own provider so e2e
 * tests can `app.get(FakeStripeClient)`.
 */
@Injectable()
export class FakeStripeClient implements StripeClient {
  private readonly logger = new Logger(FakeStripeClient.name);
  private readonly webhookSecret: string;
  readonly createdSessions: Array<
    CreateStripeCheckoutSessionParams & { sessionId: string }
  > = [];

  constructor(configService: ConfigService) {
    this.webhookSecret =
      configService.get<string>('STRIPE_WEBHOOK_SECRET') ||
      FAKE_STRIPE_WEBHOOK_SECRET;
  }

  createCheckoutSession(
    params: CreateStripeCheckoutSessionParams,
  ): Promise<CreateStripeCheckoutSessionResult> {
    const id = randomUUID();
    const sessionId = `cs_test_fake_${id}`;
    this.createdSessions.push({ ...params, sessionId });
    this.logger.log(
      `[FAKE] createCheckoutSession: sessionId=${sessionId} orderId=${params.orderId}`,
    );
    return Promise.resolve({
      sessionId,
      url: `https://stripe.fake/checkout/${id}`,
    });
  }

  parseWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): StripeWebhookEvent {
    return verifyAndNormalizeWebhook(rawBody, signature, this.webhookSecret);
  }
}
