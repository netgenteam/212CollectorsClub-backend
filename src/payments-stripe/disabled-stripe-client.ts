import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import {
  CreateStripeCheckoutSessionResult,
  StripeClient,
  StripeSignatureError,
  StripeWebhookEvent,
} from './stripe-client.interface.js';

/**
 * Story 20.11: the Stripe rail switched off ON PURPOSE (`STRIPE_ENABLED=false`), the only way a production
 * service runs without Stripe (it never falls back to `FakeStripeClient`). No network, no secret:
 *  - checkout with `paymentRail=stripe` answers `503 STRIPE_DISABLED` (`CheckoutService` checks `disabled` before it
 *    creates anything; `createCheckoutSession` repeats it as defence in depth);
 *  - the webhook rejects EVERY request with the same `400 STRIPE_SIGNATURE_INVALID` an unsigned one gets (a body that
 *    nobody can sign must not be believed), whatever the header says.
 */
@Injectable()
export class DisabledStripeClient implements StripeClient {
  readonly disabled = true;

  createCheckoutSession(): Promise<CreateStripeCheckoutSessionResult> {
    return Promise.reject(
      new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'STRIPE_DISABLED',
        'Card payments (Stripe) are not available right now. Pay with pago movil instead.',
      ),
    );
  }

  parseWebhook(): StripeWebhookEvent {
    throw new StripeSignatureError(
      'The Stripe rail is disabled (STRIPE_ENABLED=false): no webhook is accepted',
    );
  }
}
