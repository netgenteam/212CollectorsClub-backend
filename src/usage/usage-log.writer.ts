import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { UsageLogRow, UsageLogWriter } from './usage-log.types.js';

/** The database cuts the INSERT itself if it runs longer: no statement outlives the buffer's own timer. */
const STATEMENT_TIMEOUT = '4000ms';
const LOCK_TIMEOUT = '1000ms';

/**
 * Story 20.7: ONE `INSERT ... SELECT FROM unnest(...)` per batch (not `createMany`: it cannot carry the
 * `WHERE`, and it would send 200 x 10 bound parameters). Two things it does that `createMany` cannot:
 *
 *   - a row of a CUSTOMER whose account is already anonymized is not inserted (`NOT EXISTS ... anonymizedAt IS NOT NULL`):
 *     the in-memory buffer can hold a row that was queued before the anonymization committed, and this
 *     is what keeps it from coming back (the other half is `UsageLogErasure`, docs/deployment.md 19.5);
 *   - `statement_timeout` / `lock_timeout` through `set_config(..., true)`, transaction-local, so a
 *     stuck database never keeps a pooled connection for more than a few seconds.
 *
 * The statement is a literal (no string building) and every value is a bound parameter.
 */
@Injectable()
export class PrismaUsageLogWriter implements UsageLogWriter {
  constructor(private readonly prisma: PrismaService) {}

  async insert(rows: readonly UsageLogRow[]): Promise<void> {
    if (rows.length === 0) return;
    const ts = rows.map((r) => new Date(r.ts).toISOString());
    const method = rows.map((r) => r.method);
    const route = rows.map((r) => r.route);
    const status = rows.map((r) => r.status);
    const durationMs = rows.map((r) => r.durationMs);
    const actorType = rows.map((r) => r.actorType);
    const actorId = rows.map((r) => r.actorId);
    const ip = rows.map((r) => r.ip);
    const userAgent = rows.map((r) => r.userAgent);
    const requestId = rows.map((r) => r.requestId);
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true), set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`;
        await tx.$executeRaw`
          INSERT INTO "Usage_Logs"
            ("ts", "method", "route", "status", "durationMs", "actorType", "actorId", "ip", "userAgent", "requestId")
          SELECT t."ts", t."method", t."route", t."status", t."durationMs", t."actorType", t."actorId", t."ip",
                 t."userAgent", t."requestId"
            FROM unnest(
              ${ts}::timestamptz[], ${method}::text[], ${route}::text[], ${status}::smallint[],
              ${durationMs}::int[], ${actorType}::text[], ${actorId}::uuid[], ${ip}::inet[],
              ${userAgent}::text[], ${requestId}::uuid[]
            ) AS t("ts", "method", "route", "status", "durationMs", "actorType", "actorId", "ip", "userAgent", "requestId")
           WHERE t."actorType" <> 'CUSTOMER'
              OR t."actorId" IS NULL
              OR NOT EXISTS (
                   SELECT 1 FROM "Customers" c
                    WHERE c."id" = t."actorId" AND c."anonymizedAt" IS NOT NULL)`;
      },
      { maxWait: 2_000, timeout: 6_000 },
    );
  }
}
