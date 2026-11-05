import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsageLogBuffer } from './usage-log.buffer.js';

/**
 * Story 20.7 x 20.6 (AD-98): a usage row is personal data (the IP and the customer id of whoever made
 * the request) for 7 days, so the anonymization of an account removes it, in three steps that together
 * leave no row behind even though the buffer is in memory and the write is asynchronous:
 *
 *   1. `deleteInTx`, inside the anonymization's transaction, under the Customers row lock: every row of
 *      the account already in the table.
 *   2. `afterCommit`, once the anonymization is committed: the buffer drops the account's pending rows
 *      and refuses its late ones (`dropActor`); the write in flight (which may hold rows queued before
 *      the commit) is awaited; then the table is swept ONCE more. From the commit on, `PrismaUsageLogWriter`
 *      itself refuses to insert a row of an anonymized customer (`NOT EXISTS ... anonymizedAt`), so
 *      nothing can come back after the sweep, not even from another instance's buffer.
 *   3. the 7-day purge removes whatever the above could not (the sweep failing is logged, not fatal).
 */
@Injectable()
export class UsageLogErasure {
  private readonly logger = new Logger(UsageLogErasure.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly buffer: UsageLogBuffer,
  ) {}

  /** Same transaction as the anonymization. Returns the rows deleted. */
  async deleteInTx(
    tx: Prisma.TransactionClient,
    customerId: string,
  ): Promise<number> {
    return tx.$executeRaw`DELETE FROM "Usage_Logs" WHERE "actorType" = 'CUSTOMER' AND "actorId" = ${customerId}::uuid`;
  }

  /** Rows of the account still waiting in memory or in a write in flight. Never throws. */
  async afterCommit(customerId: string): Promise<void> {
    try {
      this.buffer.dropActor(customerId);
      await this.buffer.settle(3_000);
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT set_config('statement_timeout', '5000ms', true), set_config('lock_timeout', '2000ms', true)`;
          await this.deleteInTx(tx, customerId);
        },
        { maxWait: 2_000, timeout: 8_000 },
      );
    } catch (err) {
      this.logger.error(
        `usage log: the final sweep for anonymized customer ${customerId} failed (the 7-day purge will remove what is left): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** `willDelete.usageLogs` of the admin preview: what the anonymization will remove from the table. */
  async countFor(customerId: string): Promise<number> {
    const r = await this.prisma.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*)::bigint AS n FROM "Usage_Logs" WHERE "actorType" = 'CUSTOMER' AND "actorId" = ${customerId}::uuid`;
    return Number(r[0]?.n ?? 0);
  }
}
