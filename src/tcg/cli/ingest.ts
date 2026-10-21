import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { TcgCliModule } from './tcg-cli.module.js';
import { parseIngestArgs } from './ingest-args.js';
import { TcgIngestService } from '../tcg-ingest.service.js';

/** `pnpm tcg:ingest [--games ..] [--sets ..] [--max-requests N] [--dry-run]`. */
async function main(): Promise<number> {
  const overrides = parseIngestArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(TcgCliModule, {
    logger: ['log', 'warn', 'error'],
  });
  try {
    const service = app.get(TcgIngestService);
    const opts = service.resolveOptions(overrides);
    Logger.log(
      `games=${opts.games.join(',')} sets=${opts.sets?.join(',') ?? `<${opts.setLimit} most recent per game>`} ` +
        `maxRequests=${opts.maxRequests} reserve=${opts.reserve} dryRun=${opts.dryRun}`,
      'tcg:ingest',
    );
    const result = await service.run(overrides);

    if (result.alreadyRunning) {
      console.log('Another sync run is already running — nothing done.');
      return 0;
    }
    if (opts.dryRun) {
      console.log('DRY RUN — nothing was written. Plan:');
      for (const p of result.plan) {
        console.log(
          `  ${p.gameSlug} / ${p.setName} (${p.setId}) from page ${p.nextPage}` +
            (p.estimatedRequests !== null
              ? `, ~${p.estimatedRequests} request(s)`
              : ''),
        );
      }
      if (result.plan.length === 0) console.log('  (no pending sets)');
    }
    console.log(`Status: ${result.status}`);
    console.log(`Sets completed: ${result.setsCompleted}`);
    console.log(`Summary: ${JSON.stringify(result.summary)}`);
    console.log(
      `Requests remaining today (last known): ${result.remainingQuota ?? 'unknown (no request made)'}`,
    );
    if (result.summary.quotaExhausted) {
      console.log(
        'Quota/budget reached: progress saved, run again to continue.',
      );
    }
    if (result.errorSummary) console.error(`Error: ${result.errorSummary}`);
    return result.status === 'FAILED' ? 1 : 0;
  } finally {
    await app.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
