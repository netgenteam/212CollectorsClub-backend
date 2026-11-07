import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { productionConfigProblems } from '../production-config.js';

/**
 * Story 20.11: `node dist/common/cli/check-production-config.js --env-file <path> [--as-production]`, run by
 * `deploy/deploy.sh` BEFORE the migration and the restart, with the SAME rules the service applies at boot. The file
 * is read as data (dotenv). With `--as-production` the rules apply whatever NODE_ENV the file says (the production
 * deploy); without it they apply only when the file declares `NODE_ENV=production`. Prints variable names and
 * rules, never a value. Exit 0 valid, 1 invalid.
 */
const invoked =
  process.argv[1]?.endsWith('check-production-config.js') === true;
if (invoked) {
  const i = process.argv.indexOf('--env-file');
  const env: Record<string, string | undefined> =
    i >= 0 && process.argv[i + 1]
      ? parse(readFileSync(process.argv[i + 1], 'utf8'))
      : process.env;
  const force = process.argv.includes('--as-production');
  if (!force && env.NODE_ENV !== 'production') {
    console.log(
      '[check-production-config] NODE_ENV is not production in this file: the production rules are not applied',
    );
  } else {
    const problems = productionConfigProblems(env);
    for (const p of problems)
      console.error(`[check-production-config] INVALID: ${p}`);
    if (problems.length > 0) process.exitCode = 1;
    else console.log('[check-production-config] production configuration OK');
  }
}
