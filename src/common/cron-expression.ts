import { CronTime } from 'cron';
import { safeSample } from './safe-sample.js';

/** A cron setting that cannot be used. The message always names the variable. */
export class CronConfigError extends Error {}

/**
 * Story 20.8 round 2: a cron expression read from the environment is validated BEFORE it reaches
 * `@Cron(...)`/`CronJob`: an invalid one (`61 99 * * *`) used to bring the start down with a bare `CronError`
 * that did not say which variable was wrong. Accepts 5 fields (minute..weekday) or 6 (with seconds), as the
 * scheduler does. Returns the trimmed expression.
 */
export function assertCronExpression(name: string, value: string): string {
  const expr = value.trim();
  try {
    if (!/^[0-9*/,\-?LW#A-Za-z ]{5,120}$/.test(expr)) throw new Error('shape');
    const fields = expr.split(/\s+/).length;
    if (fields < 5 || fields > 6) throw new Error('fields');
    new CronTime(expr, 'UTC');
    return expr;
  } catch {
    throw new CronConfigError(
      `${name} is not a valid cron expression (5 or 6 fields, e.g. "30 4 * * *"; got ${safeSample(name, expr)}).`,
    );
  }
}

/**
 * The value of cron variable `name` in `process.env` (the caller imports `env-at-import` first, so a `.env`
 * file counts), or `fallback` when it is unset/empty. Invalid: throws `CronConfigError` naming `name`.
 */
export function cronFromEnv(name: string, fallback: string): string {
  const raw = (process.env[name] ?? '').trim();
  return raw === '' ? fallback : assertCronExpression(name, raw);
}
