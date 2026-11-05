import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { assertCronExpression } from '../../common/cron-expression.js';
import { readUsageLogConfig } from '../../usage/usage-config.js';
import { readRetentionConfig } from '../retention-config.js';

/**
 * Story 20.8 round 2: `node dist/retention/cli/check-config.js --env-file <path>`, run by `deploy/deploy.sh` BEFORE the
 * migrations and the restart, next to the keyring check. Every variable of the retention job (and of the usage log and
 * the cron expressions that are read at import) is validated with the SAME functions the service runs at boot, so an
 * optional variable written wrong stops the DEPLOY, not a restart that then crash-loops. Prints variable names and the
 * values in force, never a secret. Exit 0 valid, 1 invalid.
 */
export interface ConfigCheck {
  errors: string[];
  warnings: string[];
  summary: string[];
}

const CRON_VARS = [
  'FX_REFRESH_CRON',
  'VITRINA_RECOMPUTE_CRON',
  'AUDIT_VERIFY_CRON',
] as const;

export function checkRetentionConfig(
  env: Record<string, string | undefined>,
): ConfigCheck {
  const out: ConfigCheck = { errors: [], warnings: [], summary: [] };
  const get = (k: string): string | undefined => env[k];
  // The deploy target is a server: with NODE_ENV unset in the file the unit sets it to production.
  const nodeEnv = env.NODE_ENV ?? 'production';
  const attempt = (fn: () => void): void => {
    try {
      fn();
    } catch (err) {
      out.errors.push(err instanceof Error ? err.message : 'invalid value');
    }
  };
  attempt(() => {
    const c = readRetentionConfig(get, nodeEnv);
    out.summary.push(
      `retention: enabled=${c.enabled} cron=${c.cron} sessionPiiDays=${c.sessionPiiDays} contactMonths=${c.contactMonths} usageLogDays=${c.usageLogDays}`,
    );
    if (c.enabled && c.cron === 'off' && nodeEnv === 'production') {
      out.warnings.push(
        'RETENTION_PURGE_CRON=off in production: nothing purges on a schedule (the usage log included); only POST /admin/retention/run does',
      );
    }
    out.summary.push(
      `PURGE_CONTACT_MONTHS=${c.contactMonths}: [[PLAZO_CONSERVACION_CONTACTO]] of the privacy policy must say the same (${c.contactMonths} months)`,
    );
  });
  attempt(() => {
    readUsageLogConfig(get);
  });
  for (const name of CRON_VARS) {
    const v = (get(name) ?? '').trim();
    if (v !== '') attempt(() => assertCronExpression(name, v));
  }
  const legacy = (get('USAGE_LOG_PURGE_CRON') ?? '').trim();
  if (legacy !== '' && legacy.toLowerCase() !== 'off') {
    out.warnings.push(
      'USAGE_LOG_PURGE_CRON is ignored (removed): the usage log is purged by the retention job; delete the variable',
    );
  }
  return out;
}

const invoked = process.argv[1]?.endsWith('check-config.js') === true;
if (invoked) {
  const i = process.argv.indexOf('--env-file');
  const env: Record<string, string | undefined> =
    i >= 0 && process.argv[i + 1]
      ? parse(readFileSync(process.argv[i + 1], 'utf8'))
      : process.env;
  const r = checkRetentionConfig(env);
  for (const l of r.summary) console.log(`[check-config] ${l}`);
  for (const w of r.warnings) console.warn(`[check-config] WARNING: ${w}`);
  for (const e of r.errors) console.error(`[check-config] INVALID: ${e}`);
  if (r.errors.length > 0) process.exitCode = 1;
  else console.log('[check-config] retention configuration OK');
}
