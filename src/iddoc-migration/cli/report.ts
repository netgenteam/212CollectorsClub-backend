import { printMetrics, runCli } from './run-cli.js';

/** `pnpm iddoc:report`: row counts per key version (when `v1` shows 0 rows, version 1 may be retired). */
void runCli(async (svc) => {
  printMetrics({ mode: 'report', rows: await svc.report() });
  return 0;
});
