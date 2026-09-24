import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { basename, join } from 'node:path';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { OrderActorType, OrderStatus } from '../generated/prisma/enums.js';
import { ApiException } from '../common/api-exception.js';
import { executeGuardedUpdate } from '../common/guarded-update.js';
import {
  guardedOrderStatusTransition,
  OrderTransitionConflictError,
} from '../common/order-status-transition.js';
import type { AuthenticatedAdminUser } from '../common/admin-auth.guard.js';
import { UPLOADS_PRIVATE_ROOT } from './upload-paths.constants.js';
import { AdminPaymentDecisionResponseDto } from './dto/admin-payment-decision-response.dto.js';

function orderNotFoundException(orderId: string): ApiException {
  return new ApiException(
    HttpStatus.NOT_FOUND,
    'ORDER_NOT_FOUND',
    `No Order exists with id "${orderId}".`,
  );
}

function proofOfPaymentNotFoundException(orderId: string): ApiException {
  return new ApiException(
    HttpStatus.NOT_FOUND,
    'PROOF_OF_PAYMENT_NOT_FOUND',
    `Order ${orderId} has no ProofOfPayment uploaded yet.`,
  );
}

function proofOfPaymentFileMissingException(orderId: string): ApiException {
  return new ApiException(
    HttpStatus.NOT_FOUND,
    'PROOF_OF_PAYMENT_FILE_MISSING',
    `Order ${orderId} has a ProofOfPayment record, but its file is missing on disk.`,
  );
}

/**
 * Story 9.2 AC4 (AD-13): thrown INSIDE the confirm transaction when the
 * guarded combined stock+heldQty UPDATE (`WHERE stock >= qty AND held_qty
 * >= qty`, AD-13's exact confirm-path guard) affects 0 rows for some
 * StockHold — meaning stock (or the reservation itself) is no longer
 * sufficient at the moment the Admin actually confirms, even though the
 * Order itself was still `pending_verification` a moment ago (so
 * `guardedOrderStatusTransition`, which runs first, did not itself catch
 * this). Throwing here rolls back the WHOLE transaction — the `->paid`
 * transition, any earlier line's already-applied decrement, all of it —
 * per the AC's explicit "0 filas afectadas en cualquier línea -> aborta
 * TODO, nunca decremento parcial".
 *
 * **Deliberately NOT swallowed into a safe no-op**, unlike
 * `PaypalPaymentsService.StockDecrementConflictError` (Story 4.3) or the
 * stock-hold-expiry cron's `HeldQtyReleaseConflictError` (Story 5.2):
 * those two happen with no live HTTP caller to answer (a webhook that
 * already has the buyer's money, an unattended cron run), so they log loud
 * and return a safe 200/noop instead. This call site is a live,
 * interactive Admin request — the Dev brief for this story is explicit
 * that a stock conflict here must come back as a real, visible error the
 * Admin sees immediately (never a silent 200), so `translateDecisionError`
 * below turns this into a 409.
 */
class StockConfirmConflictError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly productId: string,
  ) {
    super(
      `Order ${orderId}: guarded stock+heldQty confirmation UPDATE for Product ${productId} affected 0 rows.`,
    );
    this.name = 'StockConfirmConflictError';
  }
}

/**
 * The reject-path counterpart to `StockConfirmConflictError` above: thrown
 * when the guarded heldQty-ONLY release UPDATE (`WHERE "heldQty" >= qty`,
 * deliberately no `stock` term — rejecting a payment never touches
 * `stock`, it only gives back the reservation) affects 0 rows. Same
 * treatment: rolls back the whole reject transaction (including the
 * `->payment_rejected` transition) and is translated to an explicit 409,
 * never a silent no-op.
 */
class StockHoldReleaseConflictError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly productId: string,
  ) {
    super(
      `Order ${orderId}: guarded heldQty-release UPDATE for Product ${productId} affected 0 rows.`,
    );
    this.name = 'StockHoldReleaseConflictError';
  }
}

export interface ProofOfPaymentFile {
  /** Absolute path on disk, already verified readable. */
  absolutePath: string;
  mimeType: string;
  /** Safe to hand straight to `Content-Disposition` — see
   * `getProofOfPaymentFile`'s own doc comment for why. */
  downloadFileName: string;
  /** The `ProofOfPayment.sizeBytes` DB column (recorded at upload time,
   * Story 4.2) — reused as-is for the `Content-Length` response header
   * rather than a second `fs.stat` call, since Nest's `StreamableFile`
   * does not infer it automatically from a plain `fs.ReadStream` (Node's
   * HTTP server falls back to chunked transfer-encoding with no
   * `Content-Length` at all unless one is set explicitly). */
  sizeBytes: number;
}

/**
 * Story 9.2 (FR-16, FR-25, NFR-5, NFR-6; AD-7, AD-11, AD-12, AD-13, AD-16).
 * The Admin-facing mutation/serving side of the Pago Móvil review flow —
 * `AdminOrdersService` (Story 9.1) stays a read-only list; this is its
 * sibling for the three actions an Admin actually takes on one specific
 * Order: view the uploaded proof, confirm, or reject.
 *
 * **Reuses, never reinvents**: every status change goes through
 * `guardedOrderStatusTransition` (Story 4.1's helper, `common/
 * order-status-transition.ts`) — this is its 4th/5th real UPDATE-on-an-
 * existing-row consumer, after `PaypalPaymentsService` (4.3) and
 * `StockHoldExpiryCronService` (5.2). Every stock/heldQty mutation goes
 * through `executeGuardedUpdate` (the same generic AD-16 primitive both of
 * those already use). Both guarded transitions here write `actorType =
 * ADMIN` with `adminUserId` set — the first real writer of that
 * combination in this codebase (every prior writer used SYSTEM,
 * PAYPAL_WEBHOOK, or CRON).
 *
 * **Closing the Story 5.2 StockHold gap**: QA flagged, back in Story 5.2,
 * that the expiry cron deliberately never touches an Order that has
 * already left `pending_verification` by any other path — so if THIS
 * story didn't explicitly release/consume the active `StockHold` here,
 * `heldQty` would stay inflated forever the moment an Admin resolves an
 * Order before the cron ever sees it. Both `confirmPayment` and
 * `rejectPayment` below re-select every still-active (`releasedAt: null`)
 * `StockHold` for the Order INSIDE the same transaction as the guarded
 * status transition — mirroring `StockHoldExpiryCronService.expireOneOrder`
 * exactly (candidate list re-read inside the transaction, after the guard
 * already succeeded, never trusted from an earlier un-transactional read)
 * — and always marks each one `releasedAt` in that same transaction. A
 * confirmed Order's hold is *consumed* (converted into a real `stock`
 * decrement, AD-13's combined guard); a rejected Order's hold is *released*
 * (only `heldQty` gives the reservation back — `stock` is never touched,
 * the product becomes available again exactly as if the hold never
 * existed).
 *
 * **AC4 — a duplicate confirm/reject is an explicit conflict, never a
 * silent no-op**: this is the one place this story's behavior deliberately
 * diverges from Story 4.3's PayPal webhook and Story 5.2's cron, both of
 * which swallow `OrderTransitionConflictError` into a safe, silent 200/
 * noop (no live caller to usefully tell there, see those services' own
 * doc comments). Here there IS a live Admin HTTP request waiting on an
 * answer, so `translateDecisionError` below turns that same conflict into
 * a real 409 `ORDER_NOT_PENDING_VERIFICATION` — a double-click, or a race
 * against the expiry cron, is never mistaken for success.
 */
@Injectable()
export class AdminOrderPaymentService {
  private readonly logger = new Logger(AdminOrderPaymentService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Story 9.2 AC1 (AD-12, NFR-5). Resolves the Order's most recent
   * `ProofOfPayment` row to an absolute on-disk path this controller can
   * stream back — this is the ONLY place in the codebase that ever reads a
   * `uploads/private/` file for the purpose of serving it out over HTTP,
   * and it does so exclusively behind `AdminAuthGuard` (never a static-
   * mounted path — `upload-paths.constants.ts` confirms nothing in this
   * codebase ever calls `useStaticAssets`/`ServeStaticModule` against
   * `UPLOADS_PRIVATE_ROOT`, and this story adds no such registration
   * either).
   *
   * **`downloadFileName`**: `basename(filePath)` — the exact server-
   * generated `randomUUID()+extension` name `proof-of-payment-multer.
   * config.ts` chose at upload time (Story 4.2), never the buyer's
   * original filename (which was never stored anywhere, by that story's
   * own path-traversal design). The controller forces
   * `Content-Disposition: attachment` around this filename regardless of
   * MIME type — closing the exact gap Story 4.2's QA flagged: the upload's
   * `fileFilter` only checks the client-declared `Content-Type`, not the
   * file's real magic bytes, so a `.pdf`-typed upload could in principle
   * carry embedded JS. Forcing a download (never an inline render in an
   * Admin's browser tab) means that content is never executed/interpreted
   * by anything, regardless of what it actually contains.
   *
   * **404, not 500, on a missing order/proof/file** — three distinct,
   * distinguishable cases: no such Order at all (`ORDER_NOT_FOUND`), a
   * real Order with nothing uploaded yet (`PROOF_OF_PAYMENT_NOT_FOUND`,
   * same "reasonable 404" the story brief asks for), and the pathological
   * case of a DB row whose file was somehow removed from disk out-of-band
   * (`PROOF_OF_PAYMENT_FILE_MISSING`, logged loudly — should never happen
   * in normal operation, since nothing in this codebase ever deletes a
   * ProofOfPayment file after it's written).
   */
  async getProofOfPaymentFile(orderId: string): Promise<ProofOfPaymentFile> {
    await this.assertOrderExists(orderId);

    const latest = await this.prisma.proofOfPayment.findFirst({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
    });
    if (!latest) {
      throw proofOfPaymentNotFoundException(orderId);
    }

    const absolutePath = join(UPLOADS_PRIVATE_ROOT, latest.filePath);
    try {
      await access(absolutePath, fsConstants.R_OK);
    } catch {
      this.logger.error(
        `ProofOfPayment ${latest.id} (Order ${orderId}) has a DB row but its file is unreadable/missing at ${absolutePath}.`,
      );
      throw proofOfPaymentFileMissingException(orderId);
    }

    return {
      absolutePath,
      mimeType: latest.mimeType,
      downloadFileName: basename(latest.filePath),
      sizeBytes: latest.sizeBytes,
    };
  }

  /**
   * Story 9.2 AC2 (AD-7, AD-13, AD-16). One transaction:
   * 1. `guardedOrderStatusTransition` `pending_verification->paid` — 0 rows
   *    affected (Order already left that status) throws
   *    `OrderTransitionConflictError`, caught below and turned into AC4's
   *    explicit 409, before anything else in this method runs.
   * 2. Every still-active `StockHold` for this Order (re-selected inside
   *    this same transaction, per this class's own doc comment) is
   *    converted via AD-13's EXACT guarded UPDATE — `stock = stock - qty,
   *    "heldQty" = "heldQty" - qty WHERE stock >= qty AND "heldQty" >=
   *    qty` — and then marked `releasedAt`. Zero affected rows on ANY
   *    line throws `StockConfirmConflictError`, rolling back everything
   *    already done in this transaction (including step 1's transition):
   *    never a partial decrement, per the AC.
   */
  async confirmPayment(
    orderId: string,
    admin: AuthenticatedAdminUser,
  ): Promise<AdminPaymentDecisionResponseDto> {
    await this.assertOrderExists(orderId);

    try {
      await this.prisma.$transaction(async (tx) => {
        await guardedOrderStatusTransition(tx, {
          orderId,
          fromStatus: OrderStatus.PENDING_VERIFICATION,
          toStatus: OrderStatus.PAID,
          actorType: OrderActorType.ADMIN,
          adminUserId: admin.id,
        });

        const holds = await tx.stockHold.findMany({
          where: { orderId, releasedAt: null },
        });
        const now = new Date();

        for (const hold of holds) {
          const affected = await executeGuardedUpdate(
            tx,
            Prisma.sql`
              UPDATE "Products"
              SET stock = stock - ${hold.quantity},
                  "heldQty" = "heldQty" - ${hold.quantity}
              WHERE id = ${hold.productId}::uuid
                AND stock >= ${hold.quantity}
                AND "heldQty" >= ${hold.quantity}
            `,
          );
          if (affected === 0) {
            throw new StockConfirmConflictError(orderId, hold.productId);
          }
          await tx.stockHold.update({
            where: { id: hold.id },
            data: { releasedAt: now },
          });
        }
      });
    } catch (err) {
      await this.translateDecisionError(err, orderId);
    }

    this.logger.log(
      `Order ${orderId} confirmed PAID by admin ${admin.id} — stock decremented and every active StockHold released atomically in the same transaction.`,
    );
    return this.toDecisionDto(orderId);
  }

  /**
   * Story 9.2 AC3 (AD-7, AD-16). Same shape as `confirmPayment`, with two
   * differences per the AC: the target status is the TERMINAL
   * `payment_rejected` (AD-7: no outgoing transition from it — a buyer
   * whose payment is rejected must place a new order, never silently
   * revert to pending), and the guarded per-hold UPDATE never touches
   * `stock` — only `"heldQty" = "heldQty" - qty WHERE "heldQty" >= qty`,
   * giving back the reservation so the Product becomes available again,
   * with `stock` itself left exactly as it was (nothing was ever actually
   * sold).
   */
  async rejectPayment(
    orderId: string,
    admin: AuthenticatedAdminUser,
  ): Promise<AdminPaymentDecisionResponseDto> {
    await this.assertOrderExists(orderId);

    try {
      await this.prisma.$transaction(async (tx) => {
        await guardedOrderStatusTransition(tx, {
          orderId,
          fromStatus: OrderStatus.PENDING_VERIFICATION,
          toStatus: OrderStatus.PAYMENT_REJECTED,
          actorType: OrderActorType.ADMIN,
          adminUserId: admin.id,
        });

        const holds = await tx.stockHold.findMany({
          where: { orderId, releasedAt: null },
        });
        const now = new Date();

        for (const hold of holds) {
          const affected = await executeGuardedUpdate(
            tx,
            Prisma.sql`
              UPDATE "Products"
              SET "heldQty" = "heldQty" - ${hold.quantity}
              WHERE id = ${hold.productId}::uuid
                AND "heldQty" >= ${hold.quantity}
            `,
          );
          if (affected === 0) {
            throw new StockHoldReleaseConflictError(orderId, hold.productId);
          }
          await tx.stockHold.update({
            where: { id: hold.id },
            data: { releasedAt: now },
          });
        }
      });
    } catch (err) {
      await this.translateDecisionError(err, orderId);
    }

    this.logger.log(
      `Order ${orderId} rejected (payment_rejected) by admin ${admin.id} — every active StockHold released, "stock" left untouched.`,
    );
    return this.toDecisionDto(orderId);
  }

  private async assertOrderExists(orderId: string): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true },
    });
    if (!order) {
      throw orderNotFoundException(orderId);
    }
  }

  /**
   * Translates the 3 typed conflicts this class's own guarded transactions
   * can throw into this API's usual `ApiException` shape — always a 409,
   * always with a stable `errorCode`, always distinguishable from each
   * other. Anything else (a genuinely unexpected error) is rethrown
   * unchanged, exactly as every other guarded-transaction call site in
   * this codebase already does (see `PaypalPaymentsService.
   * applyPaidTransition`'s own `catch` block for the same final
   * `throw err;` pattern).
   *
   * AC4's "estado actual de la Order" detail: for the duplicate-
   * confirm/reject case specifically, this re-reads the Order's NOW-
   * current status (outside the failed transaction, which already rolled
   * back) so the 409 body can tell the Admin what it actually is —
   * strictly a courtesy for the Admin UI, never required for correctness
   * (the guarded UPDATE itself is what actually prevented the double
   * action).
   */
  private async translateDecisionError(
    err: unknown,
    orderId: string,
  ): Promise<never> {
    if (err instanceof OrderTransitionConflictError) {
      const current = await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { status: true },
      });
      throw new ApiException(
        HttpStatus.CONFLICT,
        'ORDER_NOT_PENDING_VERIFICATION',
        `Order ${orderId} is no longer pending_verification (already confirmed, rejected, or expired) — this action cannot be applied again.`,
        { currentStatus: current ? current.status.toLowerCase() : 'unknown' },
      );
    }
    if (err instanceof StockConfirmConflictError) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'INSUFFICIENT_STOCK',
        `Product ${err.productId} no longer has enough stock/held quantity to confirm Order ${orderId} — the Order was NOT confirmed and remains pending_verification.`,
        { productId: err.productId },
      );
    }
    if (err instanceof StockHoldReleaseConflictError) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'STOCK_HOLD_RELEASE_CONFLICT',
        `Failed to release the stock hold for Product ${err.productId} on Order ${orderId} — the rejection was aborted and the Order remains pending_verification.`,
        { productId: err.productId },
      );
    }
    throw err;
  }

  private async toDecisionDto(
    orderId: string,
  ): Promise<AdminPaymentDecisionResponseDto> {
    // Re-read post-commit rather than trust a locally-built Date: this is
    // what makes `updatedAt` agree exactly with the `Order.updatedAt` the
    // guarded transition itself just set (`now()`, server-side) and with
    // the OrderStatusHistory row it wrote alongside it.
    const order = await this.prisma.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { status: true, updatedAt: true },
    });
    return {
      orderId,
      status: order.status.toLowerCase(),
      updatedAt: order.updatedAt.toISOString(),
    };
  }
}
