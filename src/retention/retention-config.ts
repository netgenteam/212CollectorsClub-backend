import {
  assertCronExpression,
  CronConfigError,
} from '../common/cron-expression.js';

/**
 * Story 20.8 (AD-101, FR-130, FR-131): the settings of the retention job. Read once at boot; a value
 * outside its range stops the start with a message that names the variable (the same discipline as
 * `TRUST_PROXY` and the usage log): a retention period is a promise made in the Privacy Policy, so a
 * typo must never become a silent default, and a period that is too short must never silently erase
 * evidence.
 *
 * The bounds that are NOT in the story's text and why:
 *  - `PURGE_SESSION_PII_DAYS` also has a MAXIMUM of 90: the published Privacy Policy says 90 days, so a
 *    longer period would make the text untrue.
 *  - `RETENTION_MAX_CLOCK_ADVANCE_HOURS` (see `retention-clock.ts`): the most a run may advance its
 *    notion of "now" past the previous run's.
 */
export interface RetentionConfig {
  /** Whether the daily cron AND the manual run are allowed to purge (see `isRetentionEnabled`). */
  enabled: boolean;
  /** `RETENTION_PURGE_CRON`, default `30 4 * * *` UTC; `off` disables the cron only. */
  cron: string;
  /** `RETENTION_BATCH_SIZE`: rows per statement (10..1000). */
  batchSize: number;
  /** `RETENTION_BATCH_PAUSE_MS`: pause between two batches (0..10000). */
  batchPauseMs: number;
  /** `RETENTION_MAX_RUN_MS`: after this the run stops, `truncated`, and the rest goes in the next one. */
  maxRunMs: number;
  /** `PURGE_SESSION_PII_DAYS`: IP and user agent of a session are nulled this long after its creation (30..90). */
  sessionPiiDays: number;
  /** `PURGE_CONTACT_MONTHS`: contact messages are deleted after this many months (3..60). */
  contactMonths: number;
  /** `PURGE_USAGE_LOG_DAYS`: owned by Story 20.7's `UsageLogConfig` (1..7: the Privacy Policy says 7); shown here for the admin view. */
  usageLogDays: number;
  /** `PURGE_EXPIRED_TOKENS_DAYS`: an expired verification / reset link is deleted this long after expiring (1..30). */
  expiredTokenDays: number;
  /** `PURGE_RETENTION_RUNS_DAYS`: finished rows of `Retention_Runs` itself are deleted after this (90..3650). */
  retentionRunsDays: number;
  /** `RETENTION_MAX_CLOCK_ADVANCE_HOURS`: the advance allowed when the elapsed time cannot be verified, see `retention-clock.ts` (24..720). */
  maxClockAdvanceHours: number;
  /** `RETENTION_CLOCK_RESYNC=true`: the first clamped run of the process adopts the database clock (the operator says the outage was real). */
  clockResync: boolean;
}

export class RetentionConfigError extends Error {}

export const RETENTION_DEFAULTS = {
  cron: '30 4 * * *',
  batchSize: 1_000,
  batchPauseMs: 100,
  maxRunMs: 600_000,
  sessionPiiDays: 90,
  contactMonths: 12,
  usageLogDays: 7,
  expiredTokenDays: 1,
  retentionRunsDays: 400,
  maxClockAdvanceHours: 72,
} as const;

/**
 * An expired session (customer or admin) and a revoked token are kept this long past their expiry, then
 * deleted. A CONSTANT, not a variable: the Privacy Policy promises exactly this ("la sesión vencida se
 * elimina 7 días después de vencer"), and the PRD (FR-131) fixes it.
 */
export const EXPIRED_SESSION_GRACE_DAYS = 7;

/**
 * Margin of safety applied to EVERY cut-off, on top of the period: a row is only touched when it is
 * older than its period PLUS this. Covers the skew between the application clock (which decides
 * `expiresAt > now` in the cart and checkout) and the database clock (which decides the purge), so a
 * cart the application still accepts is never deleted. Fixed on purpose: not a parameter anybody can
 * set to make the purge earlier.
 */
export const SAFETY_MARGIN_MS = 60 * 60_000;

const text = (v: unknown): string =>
  typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';

function int(
  get: (key: string) => unknown,
  name: string,
  def: number,
  min: number,
  max: number,
): number {
  const s = text(get(name));
  if (s === '') return def;
  if (!/^\d{1,9}$/.test(s) || Number(s) < min || Number(s) > max) {
    throw new RetentionConfigError(
      `${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(s.slice(0, 40))}).`,
    );
  }
  return Number(s);
}

function bool(get: (key: string) => unknown, name: string): boolean {
  const v = text(get(name)).toLowerCase();
  if (v !== '' && v !== 'true' && v !== 'false') {
    throw new RetentionConfigError(`${name} must be "true" or "false".`);
  }
  return v === 'true';
}

/**
 * `RETENTION_PURGE_CRON`: empty = the default, `off` = no schedule, otherwise a valid expression of 5 or 6
 * fields (validated with the scheduler's own parser; the error names the variable).
 */
function cronOf(raw: string): string {
  if (raw === '') return RETENTION_DEFAULTS.cron;
  if (raw.toLowerCase() === 'off') return 'off';
  try {
    return assertCronExpression('RETENTION_PURGE_CRON', raw);
  } catch (err) {
    if (err instanceof CronConfigError) {
      throw new RetentionConfigError(err.message);
    }
    throw err;
  }
}

/**
 * Is the purge allowed to run in this process?
 *
 * DEFAULT: only when `NODE_ENV=production`. A development server shares its database with the
 * developer's test data, and a purge there would erase it: it must be asked for explicitly with
 * `RETENTION_PURGE_ENABLED=true`. `RETENTION_PURGE_ENABLED=false` switches it off even in production
 * (an incident). The manual `POST /admin/retention/run` follows the same flag.
 */
export function isRetentionEnabled(
  get: (key: string) => unknown,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): boolean {
  const flag = text(get('RETENTION_PURGE_ENABLED')).toLowerCase();
  if (flag !== '' && flag !== 'true' && flag !== 'false') {
    throw new RetentionConfigError(
      'RETENTION_PURGE_ENABLED must be "true" or "false".',
    );
  }
  if (flag === 'true') return true;
  if (flag === 'false') return false;
  return nodeEnv === 'production';
}

export function readRetentionConfig(
  get: (key: string) => unknown,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): RetentionConfig {
  const d = RETENTION_DEFAULTS;
  return {
    enabled: isRetentionEnabled(get, nodeEnv),
    cron: cronOf(text(get('RETENTION_PURGE_CRON'))),
    batchSize: int(get, 'RETENTION_BATCH_SIZE', d.batchSize, 10, 1_000),
    batchPauseMs: int(
      get,
      'RETENTION_BATCH_PAUSE_MS',
      d.batchPauseMs,
      0,
      10_000,
    ),
    maxRunMs: int(get, 'RETENTION_MAX_RUN_MS', d.maxRunMs, 10_000, 3_600_000),
    sessionPiiDays: int(
      get,
      'PURGE_SESSION_PII_DAYS',
      d.sessionPiiDays,
      30,
      90,
    ),
    contactMonths: int(get, 'PURGE_CONTACT_MONTHS', d.contactMonths, 3, 60),
    usageLogDays: int(get, 'PURGE_USAGE_LOG_DAYS', d.usageLogDays, 1, 7),
    expiredTokenDays: int(
      get,
      'PURGE_EXPIRED_TOKENS_DAYS',
      d.expiredTokenDays,
      1,
      30,
    ),
    retentionRunsDays: int(
      get,
      'PURGE_RETENTION_RUNS_DAYS',
      d.retentionRunsDays,
      90,
      3_650,
    ),
    maxClockAdvanceHours: int(
      get,
      'RETENTION_MAX_CLOCK_ADVANCE_HOURS',
      d.maxClockAdvanceHours,
      24,
      720,
    ),
    clockResync: bool(get, 'RETENTION_CLOCK_RESYNC'),
  };
}
