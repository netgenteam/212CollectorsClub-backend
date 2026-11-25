import { HttpStatus } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { ApiException } from '../../common/api-exception.js';
import { PACK_TIERS, type PackTier } from '../pack-tiers.js';
import { evaluateReadiness, type TierCounts } from './readiness.js';

/** Story 22.4 (AD-108): tier counts of several sets in ONE aggregated query (`GROUP BY setId, rarityTier`). */
export async function countCardsByTier(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  setIds: string[],
): Promise<Map<string, TierCounts>> {
  const out = new Map<string, TierCounts>(setIds.map((id) => [id, {}]));
  if (setIds.length === 0) return out;
  const rows = await db.$queryRaw<
    { setId: string; rarityTier: PackTier; n: number }[]
  >`SELECT "setId"::text AS "setId", "rarityTier"::text AS "rarityTier", count(*)::int AS "n"
    FROM "Simulator_Cards" WHERE "setId" = ANY(${setIds}::uuid[])
    GROUP BY "setId", "rarityTier"`;
  for (const r of rows)
    if (PACK_TIERS.includes(r.rarityTier))
      (out.get(r.setId) ?? {})[r.rarityTier] = r.n;
  return out;
}

/**
 * THE helper that protects "an active set is always openable" (A105/A108). Call it inside the
 * transaction of every write that can shrink a set (22.4 patch/activate, 22.5 card delete/move,
 * 22.7 import), AFTER the set row is locked `FOR UPDATE`. Recomputes the counts with `GROUP BY` in
 * the tx; an active set that is not ready throws 422 `SIMULATOR_SET_NOT_READY` (the caller's tx
 * rolls back). An inactive set is never checked.
 */
export async function assertReadyIfActive(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  setId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<
    { isActive: boolean; template: unknown }[]
  >`SELECT "isActive", "template" FROM "Simulator_Sets" WHERE "id" = ${setId}::uuid`;
  const row = rows[0];
  if (!row || !row.isActive) return;
  const counts = (await countCardsByTier(tx, [setId])).get(setId) ?? {};
  const r = evaluateReadiness(row.template, counts);
  if (r.ready) return;
  throw new ApiException(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'SIMULATOR_SET_NOT_READY',
    'The set does not have enough cards for its template.',
    { missing: r.missing, ...(r.reason ? { reason: r.reason } : {}) },
  );
}
