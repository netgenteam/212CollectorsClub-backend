import Stripe from 'stripe';
import {
  StripeSignatureError,
  StripeWebhookEvent,
} from './stripe-client.interface.js';

/**
 * Story 14.3 (AD-45): the only place besides `StripeHttpClient` that touches
 * the SDK. Local (no network) signature verification + normalization, shared
 * by the real and fake clients so signature behavior is identical.
 */
export function verifyAndNormalizeWebhook(
  rawBody: Buffer | undefined,
  signature: string | undefined,
  secret: string,
): StripeWebhookEvent {
  if (!rawBody || rawBody.length === 0 || !signature) {
    throw new StripeSignatureError();
  }

  let event: Stripe.Event;
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, secret);
  } catch {
    throw new StripeSignatureError();
  }

  const obj = event.data.object as unknown as Record<string, unknown>;
  const isSession =
    typeof obj.object === 'string' && obj.object === 'checkout.session';
  const metadata = (obj.metadata ?? {}) as Record<string, string | undefined>;
  const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
  const paymentIntent = obj.payment_intent;

  return {
    id: event.id,
    type: event.type,
    sessionId: isSession ? str(obj.id) : null,
    orderId: str(obj.client_reference_id) ?? metadata.orderId ?? null,
    paymentStatus: str(obj.payment_status),
    amountTotalCents:
      typeof obj.amount_total === 'number' ? obj.amount_total : null,
    currency: str(obj.currency),
    paymentIntentId:
      str(paymentIntent) ??
      (paymentIntent && typeof paymentIntent === 'object'
        ? str((paymentIntent as { id?: unknown }).id)
        : null),
  };
}
