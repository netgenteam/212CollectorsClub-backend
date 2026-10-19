/**
 * Story 14.3 (AD-45): the injectable seam every Stripe-touching piece of code
 * talks to (checkout in 14.4, webhook controller in 14.5) — never the `stripe`
 * SDK directly. `StripeHttpClient` wraps the real SDK; `FakeStripeClient` is
 * the deterministic in-memory double used when `STRIPE_SECRET_KEY` is unset.
 */
export const STRIPE_CLIENT = Symbol('STRIPE_CLIENT');

export interface StripeCheckoutLine {
  name: string;
  unitAmountCents: number;
  quantity: number;
}

export interface CreateStripeCheckoutSessionParams {
  orderId: string;
  lines: StripeCheckoutLine[];
  currency: 'usd';
  customerEmail?: string;
  successUrl: string;
  cancelUrl: string;
  expiresAt: Date;
}

export interface CreateStripeCheckoutSessionResult {
  sessionId: string;
  url: string;
}

/** Normalized webhook event: the controller never sees SDK types. */
export interface StripeWebhookEvent {
  id: string;
  type: string;
  sessionId: string | null;
  orderId: string | null;
  paymentStatus: string | null;
  amountTotalCents: number | null;
  currency: string | null;
  paymentIntentId: string | null;
}

/** Missing, malformed, wrong-secret or stale webhook signature. */
export class StripeSignatureError extends Error {
  constructor(message = 'Invalid Stripe webhook signature') {
    super(message);
    this.name = 'StripeSignatureError';
  }
}

export interface StripeClient {
  createCheckoutSession(
    params: CreateStripeCheckoutSessionParams,
  ): Promise<CreateStripeCheckoutSessionResult>;

  /** Throws `StripeSignatureError` if the signature is missing/invalid/stale. */
  parseWebhook(
    rawBody: Buffer,
    signature: string | undefined,
  ): StripeWebhookEvent;
}
