import { NestFactory } from '@nestjs/core';
import { RedactingLogger } from '../../common/redacting-logger.js';
import { redactString } from '../../common/redact.js';
import { IdDocConfigError } from '../../crypto/id-doc-keyring.js';
import { IddocUsageError } from '../iddoc-args.js';
import {
  IdDocMigrationError,
  IdDocMigrationService,
} from '../iddoc-migration.service.js';
import { IddocCliModule } from './iddoc-cli.module.js';

/** Exit codes: 0 ok, 1 the work found a problem, 2 usage, 3 key/config problem (nothing was written). */
export async function runCli(
  work: (svc: IdDocMigrationService) => Promise<number>,
): Promise<void> {
  try {
    const app = await NestFactory.createApplicationContext(IddocCliModule, {
      logger: new RedactingLogger({ logLevels: ['log', 'warn', 'error'] }),
    });
    try {
      process.exitCode = await work(app.get(IdDocMigrationService));
    } finally {
      await app.close();
    }
  } catch (err) {
    process.exitCode = fail(err);
  }
}

export function fail(err: unknown): number {
  if (err instanceof IddocUsageError) {
    console.error(`[iddoc] usage: ${err.message}`);
    return 2;
  }
  if (err instanceof IdDocConfigError) {
    // Names variables and versions, never a key value.
    console.error(`[iddoc] ${redactString(err.message)}`);
    return 3;
  }
  if (err instanceof IdDocMigrationError) {
    console.error(`[iddoc] ${err.code}: ${redactString(err.message)}`);
    const metrics = (err as IdDocMigrationError & { metrics?: unknown })
      .metrics;
    if (metrics) console.log(redactString(JSON.stringify(metrics)));
    return err.code === 'KEY_PREFLIGHT_FAILED' ? 3 : 1;
  }
  console.error(
    `[iddoc] failed: ${redactString(err instanceof Error ? `${err.name}: ${err.message}` : String(err))}`,
  );
  return 1;
}

/** One line of JSON on stdout (the metrics), after the same redaction as the logs. */
export function printMetrics(m: unknown): void {
  console.log(redactString(JSON.stringify(m)));
}
