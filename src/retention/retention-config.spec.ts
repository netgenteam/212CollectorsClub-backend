import {
  RETENTION_DEFAULTS,
  RetentionConfigError,
  isRetentionEnabled,
  legacyClockWarnings,
  readRetentionConfig,
} from './retention-config.js';

const env = (o: Record<string, string>) => (k: string) => o[k];

describe('retention config (Story 20.8 AC5)', () => {
  it('has the documented defaults', () => {
    const c = readRetentionConfig(env({}), 'production');
    expect(c).toEqual({
      enabled: true,
      cron: '30 4 * * *',
      batchSize: 1000,
      batchPauseMs: 100,
      maxRunMs: 600_000,
      sessionPiiDays: 90,
      contactMonths: 12,
      usageLogDays: 7,
      expiredTokenDays: 1,
      retentionRunsDays: 400,
    });
    expect(RETENTION_DEFAULTS.sessionPiiDays).toBe(90);
  });

  it.each([
    ['PURGE_SESSION_PII_DAYS', '29'],
    ['PURGE_SESSION_PII_DAYS', '91'], // the policy text promises 90: a longer period would make it untrue
    ['PURGE_SESSION_PII_DAYS', 'abc'],
    ['PURGE_CONTACT_MONTHS', '2'],
    ['PURGE_CONTACT_MONTHS', '0'],
    ['PURGE_USAGE_LOG_DAYS', '0'],
    ['PURGE_USAGE_LOG_DAYS', '8'], // the Privacy Policy promises 7 days
    ['PURGE_USAGE_LOG_DAYS', '30'],
    ['PURGE_EXPIRED_TOKENS_DAYS', '0'],
    ['PURGE_RETENTION_RUNS_DAYS', '89'],
    ['RETENTION_BATCH_SIZE', '1001'],
    ['RETENTION_BATCH_SIZE', '5'],
    ['RETENTION_BATCH_PAUSE_MS', '-1'],
    ['RETENTION_MAX_RUN_MS', '999'],
    ['RETENTION_PURGE_CRON', 'not a cron'],
    ['RETENTION_PURGE_CRON', '61 99 * * *'], // well-formed but impossible: used to stop the start with a bare CronError
    ['RETENTION_PURGE_CRON', '* * * *'],
    ['RETENTION_PURGE_ENABLED', 'yes'],
  ])('%s=%s stops the start, naming the variable', (name, value) => {
    expect(() => readRetentionConfig(env({ [name]: value }))).toThrow(
      RetentionConfigError,
    );
    expect(() => readRetentionConfig(env({ [name]: value }))).toThrow(
      new RegExp(name),
    );
  });

  it('accepts the bounds', () => {
    const c = readRetentionConfig(
      env({
        PURGE_SESSION_PII_DAYS: '30',
        PURGE_CONTACT_MONTHS: '3',
        PURGE_USAGE_LOG_DAYS: '7',
        RETENTION_BATCH_SIZE: '10',
        RETENTION_PURGE_CRON: '0 5 * * *',
      }),
      'production',
    );
    expect(c.sessionPiiDays).toBe(30);
    expect(c.contactMonths).toBe(3);
    expect(c.usageLogDays).toBe(7);
    expect(c.batchSize).toBe(10);
    expect(c.cron).toBe('0 5 * * *');
  });

  it('the cron can be "off"', () => {
    expect(readRetentionConfig(env({ RETENTION_PURGE_CRON: 'OFF' })).cron).toBe(
      'off',
    );
  });

  it('RETENTION_CLOCK_RESYNC and RETENTION_MAX_CLOCK_ADVANCE_HOURS were removed: any value (even garbage or out of range) is ignored by the reader and only detected to be warned about', () => {
    const base = readRetentionConfig(env({}));
    for (const o of [] as Record<string, string>[]) void o;
    for (const o of <Record<string, string>[]>[
      { RETENTION_CLOCK_RESYNC: 'garbage' },
      { RETENTION_MAX_CLOCK_ADVANCE_HOURS: '1' },
    ]) {
      const c = readRetentionConfig(env(o));
      expect(c).toEqual(base);
      expect(c).not.toHaveProperty('maxClockAdvanceHours');
    }
    expect(
      legacyClockWarnings(env({ RETENTION_CLOCK_RESYNC: 'false' })),
    ).toHaveLength(1);
    expect(
      legacyClockWarnings(
        env({
          RETENTION_CLOCK_RESYNC: 'true',
          RETENTION_MAX_CLOCK_ADVANCE_HOURS: '72',
        }),
      ),
    ).toHaveLength(2);
    expect(legacyClockWarnings(env({}))).toEqual([]);
  });

  it('the message about an invalid value quotes it, except for a variable whose name looks sensitive', () => {
    expect(() =>
      readRetentionConfig(env({ RETENTION_BATCH_SIZE: '5000' })),
    ).toThrow(/got "5000"/);
  });

  describe('where the job is allowed to run', () => {
    it('only in production by default: development, test and an unset NODE_ENV never purge', () => {
      expect(isRetentionEnabled(env({}), 'production')).toBe(true);
      expect(isRetentionEnabled(env({}), 'development')).toBe(false);
      expect(isRetentionEnabled(env({}), 'test')).toBe(false);
      expect(isRetentionEnabled(env({}), undefined)).toBe(false);
    });
    it('RETENTION_PURGE_ENABLED=true asks for it; =false switches it off even in production', () => {
      expect(
        isRetentionEnabled(
          env({ RETENTION_PURGE_ENABLED: 'true' }),
          'development',
        ),
      ).toBe(true);
      expect(
        isRetentionEnabled(
          env({ RETENTION_PURGE_ENABLED: 'false' }),
          'production',
        ),
      ).toBe(false);
    });
  });
});
