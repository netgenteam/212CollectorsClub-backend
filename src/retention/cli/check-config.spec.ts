import { checkRetentionConfig } from './check-config.js';

describe('deploy-time check of the retention configuration (Story 20.8 round 2)', () => {
  it('a clean environment is valid and says what is in force', () => {
    const r = checkRetentionConfig({ NODE_ENV: 'production' });
    expect(r.errors).toEqual([]);
    expect(r.summary.join('\n')).toMatch(/contactMonths=12/);
    expect(r.summary.join('\n')).toMatch(/PLAZO_CONSERVACION_CONTACTO/);
  });

  it.each([
    ['PURGE_USAGE_LOG_DAYS', '30'],
    ['PURGE_SESSION_PII_DAYS', '10'],
    ['RETENTION_BATCH_SIZE', '5000'],
    ['RETENTION_PURGE_CRON', '61 99 * * *'],
    ['FX_REFRESH_CRON', 'every day'],
    ['VITRINA_RECOMPUTE_CRON', '99 * * * *'],
    ['AUDIT_VERIFY_CRON', '1 2 3'],
    ['RETENTION_PURGE_ENABLED', 'maybe'],
    ['USAGE_LOG_ENABLED', 'maybe'],
  ])('%s=%s fails the deploy, naming the variable', (name, value) => {
    const r = checkRetentionConfig({ NODE_ENV: 'production', [name]: value });
    expect(r.errors.length).toBeGreaterThan(0);
    expect(r.errors.join('\n')).toContain(name);
  });

  it('every wrong variable is reported, not only the first', () => {
    const r = checkRetentionConfig({
      PURGE_USAGE_LOG_DAYS: '30',
      RETENTION_PURGE_CRON: 'x',
    });
    expect(r.errors.length).toBeGreaterThanOrEqual(2);
  });

  it('RETENTION_PURGE_CRON=off in production warns (nothing purges on a schedule); the removed USAGE_LOG_PURGE_CRON warns too', () => {
    const r = checkRetentionConfig({
      NODE_ENV: 'production',
      RETENTION_PURGE_CRON: 'off',
      USAGE_LOG_PURGE_CRON: '0 5 * * *',
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/RETENTION_PURGE_CRON=off/);
    expect(r.warnings.join('\n')).toMatch(/USAGE_LOG_PURGE_CRON is ignored/);
  });

  it('with the job disabled (RETENTION_PURGE_ENABLED=false) the off cron is not worth a warning', () => {
    const r = checkRetentionConfig({
      NODE_ENV: 'production',
      RETENTION_PURGE_ENABLED: 'false',
      RETENTION_PURGE_CRON: 'off',
    });
    expect(r.warnings).toEqual([]);
  });
});
