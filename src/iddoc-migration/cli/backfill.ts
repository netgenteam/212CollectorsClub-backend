import { parseBackfillArgs } from '../iddoc-args.js';
import { printMetrics, runCli, fail } from './run-cli.js';

/**
 * `pnpm iddoc:backfill`            encrypt every plain cedula (idempotent, resumable)
 * `pnpm iddoc:backfill --verify`   decrypt ALL rows and compare (read-only; exit 1 on any difference)
 * `pnpm iddoc:backfill --check`    exit 1 if any plain value is left without a ciphertext (deploy healthcheck)
 * `pnpm iddoc:backfill --scrub`    OPTIONAL, address book only, after a full verify in the same run
 */
let args;
try {
  args = parseBackfillArgs(process.argv.slice(2));
} catch (err) {
  process.exitCode = fail(err);
}

if (args) {
  const a = args;
  void runCli(async (svc) => {
    const opts = { batchSize: a.batchSize, pauseMs: a.pauseMs };
    if (a.mode === 'check') {
      const r = await svc.check();
      console.log(JSON.stringify({ mode: 'check', ...r }));
      if (!r.ok) {
        console.error(
          '[iddoc] CHECK FAILED: plain ID documents without a ciphertext, or malformed ciphertext, remain. Run `pnpm iddoc:backfill` again.',
        );
        return 1;
      }
      return 0;
    }
    const m =
      a.mode === 'verify'
        ? await svc.runVerify(opts)
        : a.mode === 'scrub'
          ? await svc.scrub(opts)
          : await svc.backfill(opts);
    printMetrics(m);
    return m.outcome === 'ok' && m.errors === 0 ? 0 : 1;
  });
}
