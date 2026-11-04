import { parseReencryptArgs } from '../iddoc-args.js';
import { printMetrics, runCli, fail } from './run-cli.js';

/** `pnpm iddoc:reencrypt --to <N> [--dry-run]`: key rotation (docs/deployment.md, rotation). */
let args;
try {
  args = parseReencryptArgs(process.argv.slice(2));
} catch (err) {
  process.exitCode = fail(err);
}

if (args) {
  const a = args;
  void runCli(async (svc) => {
    const m = await svc.reencrypt(a.to, {
      dryRun: a.dryRun,
      batchSize: a.batchSize,
      pauseMs: a.pauseMs,
    });
    printMetrics(m);
    return m.outcome === 'ok' && m.errors === 0 ? 0 : 1;
  });
}
