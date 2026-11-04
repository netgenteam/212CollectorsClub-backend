import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditService } from '../../audit/audit.service.js';
import { CryptoModule } from '../../crypto/crypto.module.js';
import { PrismaModule } from '../../prisma/prisma.module.js';
import { IdDocMigrationService } from '../iddoc-migration.service.js';

/**
 * Story 20.3: minimal module of the `pnpm iddoc:*` CLIs (like `TcgCliModule`): config, Prisma,
 * the crypto module (which aborts the boot on a bad keyring) and the audit writer. No HTTP, no
 * controllers, no crons. It connects with `DATABASE_URL`, the application's limited role: the
 * scripts need nothing more than the service does (UPDATE on both tables, INSERT on
 * "Audit_Events"), so they never run as the database owner.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    CryptoModule,
  ],
  providers: [AuditService, IdDocMigrationService],
})
export class IddocCliModule {}
