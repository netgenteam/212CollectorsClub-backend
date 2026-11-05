import {
  assertCronExpression,
  CronConfigError,
  cronFromEnv,
} from './cron-expression.js';

describe('cron expressions read from the environment (Story 20.8 round 2)', () => {
  it.each([
    '30 4 * * *',
    '0 15 4 * * *',
    '*/30 * * * *',
    '0 5 * * 0',
    '  0 * * * *  ',
  ])('accepts %j', (v) => {
    expect(assertCronExpression('X_CRON', v)).toBe(v.trim());
  });

  it.each([
    '61 99 * * *',
    'not a cron',
    '* * * *',
    '* * * * * * *',
    '',
    '$(reboot) * * * *',
    '99 * * * *',
  ])('rejects %j naming the variable', (v) => {
    expect(() => assertCronExpression('FX_REFRESH_CRON', v)).toThrow(
      CronConfigError,
    );
    expect(() => assertCronExpression('FX_REFRESH_CRON', v)).toThrow(
      /FX_REFRESH_CRON/,
    );
  });

  it('cronFromEnv: unset or empty is the fallback, a bad value names its variable', () => {
    const k = 'D208_TEST_CRON';
    delete process.env[k];
    expect(cronFromEnv(k, '0 * * * *')).toBe('0 * * * *');
    process.env[k] = '  ';
    expect(cronFromEnv(k, '0 * * * *')).toBe('0 * * * *');
    process.env[k] = '15 2 * * *';
    expect(cronFromEnv(k, '0 * * * *')).toBe('15 2 * * *');
    process.env[k] = '61 99 * * *';
    expect(() => cronFromEnv(k, '0 * * * *')).toThrow(/D208_TEST_CRON/);
    delete process.env[k];
  });
});
