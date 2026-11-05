import { describe, expect, it } from 'vitest';
import {
  UsageLogConfigError,
  readUsageLogConfig,
  USAGE_LOG_DEFAULTS,
} from './usage-config.js';

const cfg = (env: Record<string, string>) => readUsageLogConfig((k) => env[k]);

describe('readUsageLogConfig', () => {
  it('defaults are the ones of the story', () => {
    expect(cfg({})).toEqual({
      enabled: true,
      bufferMax: 10_000,
      flushMs: 1_000,
      flushBatch: 200,
      purgeDays: 7,
    });
    expect(USAGE_LOG_DEFAULTS.bufferMax).toBe(10_000);
  });

  it('reads the variables', () => {
    expect(
      cfg({
        USAGE_LOG_ENABLED: 'false',
        USAGE_LOG_BUFFER_MAX: '500',
        USAGE_LOG_FLUSH_MS: '250',
        USAGE_LOG_FLUSH_BATCH: '50',
        PURGE_USAGE_LOG_DAYS: '3',
      }),
    ).toEqual({
      enabled: false,
      bufferMax: 500,
      flushMs: 250,
      flushBatch: 50,
      purgeDays: 3,
    });
  });

  it.each([
    ['USAGE_LOG_BUFFER_MAX', '5'],
    ['USAGE_LOG_BUFFER_MAX', 'abc'],
    ['USAGE_LOG_BUFFER_MAX', '10e3'],
    ['USAGE_LOG_FLUSH_MS', '0'],
    ['USAGE_LOG_FLUSH_BATCH', '-1'],
    ['USAGE_LOG_FLUSH_BATCH', '99999'],
    ['PURGE_USAGE_LOG_DAYS', '0'],
    ['PURGE_USAGE_LOG_DAYS', '8'],
    ['PURGE_USAGE_LOG_DAYS', '30'],
    ['USAGE_LOG_ENABLED', 'maybe'],
  ])('%s=%s stops the start naming the variable', (name, value) => {
    expect(() => cfg({ [name]: value })).toThrow(UsageLogConfigError);
    expect(() => cfg({ [name]: value })).toThrow(new RegExp(name));
  });

  it('a batch larger than the buffer is refused', () => {
    expect(() =>
      cfg({ USAGE_LOG_BUFFER_MAX: '100', USAGE_LOG_FLUSH_BATCH: '200' }),
    ).toThrow(/cannot be larger/);
  });
});
