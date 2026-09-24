/**
 * Story 4.3: the injectable seam every PayPal-touching piece of code in
 * this codebase (`CheckoutService`'s PayPal branch, `PaypalPaymentsService`'s
 * webhook handler) talks to — never the `@paypal/paypal-server-sdk` package
 * directly. Two implementations satisfy it:
 *
 * - `PaypalHttpClient` (`paypal-http-client.ts`): wraps the real SDK
 *   (`OrdersController`), used automatically once real `PAYPAL_CLIENT_ID`/
 *   `PAYPAL_CLIENT_SECRET` are configured (see `paypal-client.provider.ts`).
 *   **Not exercised by any test in this codebase** — there is no PayPal
 *   Sandbox credential available in this environment (see the Story 4.3 Dev
 *   report). It compiles against the real SDK's types and is ready to run,
 *   but its actual HTTP behavior against PayPal has never been verified
 *   here.
 * - `FakePaypalClient` (`fake-paypal-client.ts`): a deterministic in-memory
 *   test double that implements the exact same contract. This is what
 *   EVERY test in this codebase (unit + e2e) exercises, and what the app
 *   falls back to automatically in this dev environment (no real
 *   credentials configured) — see `paypal-client.provider.ts`.
 *
 * The story's own Acceptance Criteria ("never trust a client-supplied paid
 * flag — verify independently against PayPal") is satisfied by *always*
 * calling `captureAndVerifyOrder` and acting only on ITS return value,
 * never on anything the webhook request body itself claims — this is true
 * regardless of which implementation is wired in, which is the whole point
 * of the interface.
 */

/** What `CheckoutService`'s PayPal branch needs to hand `createOrder`. */
export interface CreatePaypalOrderParams {
  /** This system's own `Order.id` (already committed to Postgres, status
   * `payment_processing`, before this call is made — see CheckoutService's
   * own doc comment for why the DB transaction and this external call are
   * deliberately NOT the same transaction). Passed to PayPal as the
   * purchase unit's `custom_id`, so a real PayPal order also carries a
   * traceable pointer back to this system, independent of the
   * `Order.paypalOrderId` column this system stores locally. */
  orderId: string;
  /** AD-3: PayPal orders are USD-only. Decimal string, always 2dp, e.g.
   * "179.98" — never a JS `number` (float precision). */
  totalUsd: string;
}

export interface CreatePaypalOrderResult {
  /** PayPal's own order id (`Order.id` in the SDK's response) — persisted
   * onto this system's `Order.paypalOrderId` right after this call
   * returns. */
  paypalOrderId: string;
  /** The URL the frontend must redirect the buyer to in order to approve
   * the payment on PayPal's own hosted flow (the SDK response's `rel:
   * approve` HATEOAS link). */
  approveUrl: string;
}

/**
 * The ground-truth outcome of asking PayPal "what is the real status of
 * this order, right now" — never inferred from a webhook payload's own
 * claimed status. `COMPLETED` is the only status this codebase treats as
 * "paid" (see `PaypalPaymentsService`); every other value is treated as
 * "not paid" (`payment_failed`).
 */
export type PaypalCaptureStatus =
  'COMPLETED' | 'DECLINED' | 'VOIDED' | 'FAILED';

export interface VerifyPaypalOrderResult {
  paypalOrderId: string;
  status: PaypalCaptureStatus;
  /** PayPal's own echo of the `custom_id` this system set at `createOrder`
   * time (this system's `Order.id`) — `null` when PayPal's response didn't
   * carry one back (e.g. a hard failure before a purchase unit could be
   * read). `PaypalPaymentsService` cross-checks this against the Order it
   * already resolved via `paypalOrderId`, as defense-in-depth against ever
   * mutating the wrong Order. */
  internalOrderId: string | null;
  /** The amount PayPal reports as captured, decimal string, when
   * available — informational only in this story (no reconciliation
   * against `Order.totalUsd` is implemented here); a natural hook for a
   * future amount-mismatch fraud check. */
  capturedTotalUsd: string | null;
}

export interface PaypalClient {
  createOrder(
    params: CreatePaypalOrderParams,
  ): Promise<CreatePaypalOrderResult>;

  /**
   * Independently verifies — and, if not already captured, captures —
   * payment for a PayPal order by calling PayPal's own API. This is the
   * ONLY source of truth `PaypalPaymentsService` ever acts on to decide
   * paid vs. failed; a webhook request's own body is never trusted for
   * that decision, only used to learn WHICH `paypalOrderId` to ask about.
   */
  captureAndVerifyOrder(
    paypalOrderId: string,
  ): Promise<VerifyPaypalOrderResult>;
}

/** DI token — `PaypalClient` is an interface (erased at runtime), so
 * Nest needs a concrete token to bind a provider to. */
export const PAYPAL_CLIENT = Symbol('PAYPAL_CLIENT');
