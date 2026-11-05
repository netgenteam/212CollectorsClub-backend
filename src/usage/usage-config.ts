/**
 * Story 20.7 (AD-100): the settings of the usage log. Read once at boot; an invalid value stops the start
 * with a message that names the variable (the same discipline as `TRUST_PROXY`), never a silent default.
 */
export interface UsageLogConfig {
  /** `USAGE_LOG_ENABLED=false` mounts nothing: no middleware, no timers, no rows. */
  enabled: boolean;
  /** `USAGE_LOG_BUFFER_MAX`: rows kept in memory. Past it the OLDEST are discarded and counted. */
  bufferMax: number;
  /** `USAGE_LOG_FLUSH_MS`: how often what is pending is written. */
  flushMs: number;
  /** `USAGE_LOG_FLUSH_BATCH`: rows per INSERT, and the size that triggers an early flush. */
  flushBatch: number;
  /** `PURGE_USAGE_LOG_DAYS`: how long a row lives (FR-131: default 7, 1..7: the Privacy Policy promises 7). */
  purgeDays: number;
}

export class UsageLogConfigError extends Error {}

export const USAGE_LOG_DEFAULTS = {
  bufferMax: 10_000,
  flushMs: 1_000,
  flushBatch: 200,
  purgeDays: 7,
} as const;

/** A setting as text: a string or a number; anything else (an object from a custom config) is "not set". */
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
    throw new UsageLogConfigError(
      `${name} must be an integer between ${min} and ${max} (got ${JSON.stringify(s.slice(0, 40))}).`,
    );
  }
  return Number(s);
}

export function readUsageLogConfig(
  get: (key: string) => unknown,
): UsageLogConfig {
  const flag = text(get('USAGE_LOG_ENABLED')).toLowerCase();
  if (flag !== '' && flag !== 'true' && flag !== 'false') {
    throw new UsageLogConfigError(
      'USAGE_LOG_ENABLED must be "true" or "false".',
    );
  }
  const cfg: UsageLogConfig = {
    enabled: flag !== 'false',
    bufferMax: int(
      get,
      'USAGE_LOG_BUFFER_MAX',
      USAGE_LOG_DEFAULTS.bufferMax,
      100,
      1_000_000,
    ),
    flushMs: int(
      get,
      'USAGE_LOG_FLUSH_MS',
      USAGE_LOG_DEFAULTS.flushMs,
      50,
      60_000,
    ),
    flushBatch: int(
      get,
      'USAGE_LOG_FLUSH_BATCH',
      USAGE_LOG_DEFAULTS.flushBatch,
      1,
      5_000,
    ),
    purgeDays: int(
      get,
      'PURGE_USAGE_LOG_DAYS',
      USAGE_LOG_DEFAULTS.purgeDays,
      1,
      7,
    ),
  };
  if (cfg.flushBatch > cfg.bufferMax) {
    throw new UsageLogConfigError(
      'USAGE_LOG_FLUSH_BATCH cannot be larger than USAGE_LOG_BUFFER_MAX.',
    );
  }
  return cfg;
}
