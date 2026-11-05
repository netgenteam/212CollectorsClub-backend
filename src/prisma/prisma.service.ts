import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { checkDatabaseClock } from './db-clock-check.js';
import { withUtcSession } from './db-session.js';

/** Closing the pool never waits longer than this for a database that does not answer. */
export const DISCONNECT_TIMEOUT_MS = 3_000;

/**
 * Thin wrapper around the generated Prisma client, exposed as an injectable
 * Nest provider so every module talks to Postgres through one connection
 * lifecycle. The connection string is read exclusively from `ConfigService`
 * (backed by `DATABASE_URL`), never hardcoded. Prisma 7 dropped its bundled
 * Rust query engine, so a driver adapter (`@prisma/adapter-pg`) is required
 * to actually reach Postgres — see AD-1.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(configService: ConfigService) {
    const adapter = new PrismaPg({
      // Story 20.8 round 2: session time zone UTC (see db-session.ts).
      connectionString: withUtcSession(
        configService.getOrThrow<string>('DATABASE_URL'),
      ),
    });
    super({ adapter });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.logger.log('Connected to PostgreSQL via Prisma');
    await checkDatabaseClock(this, this.logger);
  }

  /**
   * Story 20.7 round 2: `$disconnect` waits for the pool to hand back every connection; one that is stuck on
   * a database that does not answer never does (the process took 136 s to exit). Bounded: after
   * `DISCONNECT_TIMEOUT_MS` the close is given up and logged; the sockets die with the process
   * (`installShutdownDeadline` makes sure it exits).
   */
  async onModuleDestroy(): Promise<void> {
    let stop: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.$disconnect(),
        new Promise<void>((resolve) => {
          stop = setTimeout(() => {
            this.logger.error(
              `the connection pool did not close within ${DISCONNECT_TIMEOUT_MS} ms (the database is not answering); giving up on it`,
            );
            resolve();
          }, DISCONNECT_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(stop);
    }
  }
}
