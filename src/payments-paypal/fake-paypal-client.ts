import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  CreatePaypalOrderParams,
  CreatePaypalOrderResult,
  PaypalCaptureStatus,
  PaypalClient,
  VerifyPaypalOrderResult,
} from './paypal-client.interface.js';

interface FakeOrderRecord {
  internalOrderId: string;
  totalUsd: string;
  /** `null` until the first `captureAndVerifyOrder` call "resolves" it
   * (simulating the buyer actually completing PayPal's hosted flow) —
   * mirrors the real world, where a just-created PayPal order isn't paid
   * yet. `setOutcome` can pre-script a specific resolution (e.g.
   * `'DECLINED'`) before that first call, to simulate PayPal reporting a
   * failure instead of the happy path. */
  resolvedStatus: PaypalCaptureStatus | null;
}

/**
 * Story 4.3: a deterministic, in-memory `PaypalClient` test double — no
 * network calls, no real PayPal account. This is what every test in this
 * codebase (unit + e2e) exercises, and what the running app falls back to
 * automatically whenever `PAYPAL_CLIENT_ID`/`PAYPAL_CLIENT_SECRET` aren't
 * configured (see `paypal-client.provider.ts`) — including in this dev
 * environment, which has no real PayPal Sandbox credentials at all.
 *
 * Registered as an ordinary Nest provider (not constructed ad hoc), so
 * `app.get(FakePaypalClient)` in an e2e test returns the exact same
 * singleton instance the running app's `CheckoutService`/
 * `PaypalPaymentsService` are actually using — letting a test script a
 * specific outcome (`setOutcome`) for an order it just drove through a
 * real HTTP checkout call, before hitting the webhook endpoint.
 *
 * **Capture semantics**, modeled after the real PayPal Orders v2 API:
 * `captureAndVerifyOrder` is idempotent per `paypalOrderId` — the first
 * call "resolves" a still-pending fake order to `COMPLETED` (the happy
 * path) unless `setOutcome` pre-scripted something else; every later call
 * for the SAME `paypalOrderId` returns that same already-resolved status
 * again, exactly like asking the real PayPal API "what is this order's
 * status right now" repeatedly would.
 */
@Injectable()
export class FakePaypalClient implements PaypalClient {
  private readonly logger = new Logger(FakePaypalClient.name);
  private readonly orders = new Map<string, FakeOrderRecord>();
  private sequence = 0;

  createOrder(
    params: CreatePaypalOrderParams,
  ): Promise<CreatePaypalOrderResult> {
    this.sequence += 1;
    const paypalOrderId = `FAKE-PP-ORDER-${this.sequence}-${randomBytes(4).toString('hex')}`;
    this.orders.set(paypalOrderId, {
      internalOrderId: params.orderId,
      totalUsd: params.totalUsd,
      resolvedStatus: null,
    });
    this.logger.log(
      `[FAKE] createOrder: paypalOrderId=${paypalOrderId} internalOrderId=${params.orderId} totalUsd=${params.totalUsd}`,
    );
    return Promise.resolve({
      paypalOrderId,
      // Structurally equivalent to a real PayPal Sandbox approve link —
      // never actually reachable, this is a mock. See this class's own
      // doc comment: nothing here talks to PayPal's real network.
      approveUrl: `https://www.sandbox.paypal.com/checkoutnow?token=${paypalOrderId}`,
    });
  }

  captureAndVerifyOrder(
    paypalOrderId: string,
  ): Promise<VerifyPaypalOrderResult> {
    const record = this.orders.get(paypalOrderId);
    if (!record) {
      // A real PayPal API would 404/422 on an unknown order id; this fake
      // throws instead — both are "this call cannot be satisfied", and the
      // one call site (PaypalPaymentsService) already only reaches this
      // fake for a `paypalOrderId` it just read off an Order row.
      throw new Error(
        `FakePaypalClient: unknown paypalOrderId "${paypalOrderId}" — createOrder was never called for it.`,
      );
    }

    if (record.resolvedStatus === null) {
      record.resolvedStatus = 'COMPLETED';
    }

    this.logger.log(
      `[FAKE] captureAndVerifyOrder: paypalOrderId=${paypalOrderId} -> ${record.resolvedStatus}`,
    );

    return Promise.resolve({
      paypalOrderId,
      status: record.resolvedStatus,
      internalOrderId: record.internalOrderId,
      capturedTotalUsd:
        record.resolvedStatus === 'COMPLETED' ? record.totalUsd : null,
    });
  }

  /**
   * Test/ops-only hook, not part of the `PaypalClient` interface: scripts
   * this fake to resolve `paypalOrderId` to a specific outcome (e.g.
   * `'DECLINED'`) the next time `captureAndVerifyOrder` is called for it —
   * simulates PayPal reporting a failed/declined payment. Must be called
   * AFTER `createOrder` (and before the order's status has already
   * resolved) for the given id, or it throws the same "unknown order"
   * error `captureAndVerifyOrder` would.
   */
  setOutcome(paypalOrderId: string, status: PaypalCaptureStatus): void {
    const record = this.orders.get(paypalOrderId);
    if (!record) {
      throw new Error(
        `FakePaypalClient.setOutcome: unknown paypalOrderId "${paypalOrderId}" — createOrder was never called for it.`,
      );
    }
    record.resolvedStatus = status;
  }

  /**
   * Test-only hook: registers a `paypalOrderId` -> internal `Order.id`
   * mapping directly, without going through `createOrder` — used by
   * webhook-focused e2e tests that build their Order fixture straight via
   * Prisma (mirroring the `ProofOfPaymentController` e2e suite's own
   * "skip the full checkout flow, fixture the Order directly" pattern)
   * instead of driving a real HTTP checkout first.
   */
  registerOrder(
    paypalOrderId: string,
    internalOrderId: string,
    totalUsd: string,
  ): void {
    this.orders.set(paypalOrderId, {
      internalOrderId,
      totalUsd,
      resolvedStatus: null,
    });
  }
}
