import { Prisma } from '../generated/prisma/client.js';
import { executeGuardedUpdate } from './guarded-update.js';

/**
 * Story 14.5b (AD-50): thrown when the guarded heldQty-only release UPDATE
 * (`WHERE "heldQty" >= qty`) affects 0 rows, i.e. heldQty was manually
 * reduced below the hold. The caller's transaction (including the Order
 * transition) rolls back as a whole.
 */
export class HeldQtyReleaseError extends Error {
  constructor(
    public readonly orderId: string,
    public readonly productId: string,
    public readonly holdId: string,
  ) {
    super(
      `Order ${orderId}: guarded heldQty release for Product ${productId} (hold ${holdId}) affected 0 rows.`,
    );
    this.name = 'HeldQtyReleaseError';
  }
}

/**
 * AD-50: releases every still-active StockHold of an Order (heldQty only,
 * `stock` untouched). Must run in the SAME transaction as, and strictly
 * after, the guarded Order transition that this caller WON: the transition
 * winner is the single owner of the release, so the loser never gets here.
 * Same statements as the Pago Móvil expiry/reject paths (5.2 / 9.2).
 */
export async function releaseOrderHolds(
  tx: Prisma.TransactionClient,
  orderId: string,
  now: Date = new Date(),
): Promise<number> {
  const holds = await tx.stockHold.findMany({
    where: { orderId, releasedAt: null },
  });
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
      throw new HeldQtyReleaseError(orderId, hold.productId, hold.id);
    }
    await tx.stockHold.update({
      where: { id: hold.id },
      data: { releasedAt: now },
    });
  }
  return holds.length;
}
