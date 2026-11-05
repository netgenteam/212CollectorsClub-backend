import { safeSample } from '../../common/safe-sample.js';
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
    // the only warning is the one about the disabled job itself, not about the cron
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/RETENTION_PURGE_ENABLED=false/);
    expect(r.warnings.join('\n')).not.toMatch(/CRON=off/);
  });

  it('RETENTION_PURGE_ENABLED=false in production warns: the usage log is then never purged', () => {
    const r = checkRetentionConfig({
      NODE_ENV: 'production',
      RETENTION_PURGE_ENABLED: 'false',
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(
      /RETENTION_PURGE_ENABLED=false in production.*usage log/,
    );
    // outside production it is just a development setting
    expect(
      checkRetentionConfig({
        NODE_ENV: 'development',
        RETENTION_PURGE_ENABLED: 'false',
      }).warnings,
    ).toEqual([]);
  });

  it('the removed RETENTION_CLOCK_RESYNC warns instead of being honoured', () => {
    const r = checkRetentionConfig({
      NODE_ENV: 'production',
      RETENTION_CLOCK_RESYNC: 'true',
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(
      /RETENTION_CLOCK_RESYNC is no longer used/,
    );
  });

  it('an invalid PURGE_USAGE_LOG_DAYS is reported ONCE (two readers validate it)', () => {
    const r = checkRetentionConfig({
      NODE_ENV: 'production',
      PURGE_USAGE_LOG_DAYS: '30',
    });
    expect(
      r.errors.filter((e) => e.includes('PURGE_USAGE_LOG_DAYS')),
    ).toHaveLength(1);
  });

  it('never prints the value of a sensitive variable, valid or not, in any of the three channels', () => {
    const secret = 'S3cr3t-Sentinel-Value-9f8e7d6c';
    const sensitive = {
      DATABASE_URL: `postgresql://u:${secret}@h/db`,
      MIGRATE_DATABASE_URL: `postgresql://o:${secret}@h/db`,
      COOKIE_SECRET: secret,
      ADMIN_AUTH_SECRET: secret,
      CUSTOMER_AUTH_SECRET: secret,
      SMTP_PASS: secret,
      STRIPE_SECRET_KEY: secret,
      STRIPE_WEBHOOK_SECRET: secret,
      IDDOC_ENC_KEYS: `1:${secret}`,
      IDDOC_BLIND_KEY: secret,
      TCGAPI_KEY: secret,
      ADMIN_SEED_PASSWORD: secret,
    };
    const r = checkRetentionConfig({
      NODE_ENV: 'production',
      ...sensitive,
      RETENTION_PURGE_CRON: '61 99 * * *',
      PURGE_USAGE_LOG_DAYS: '30',
      RETENTION_CLOCK_RESYNC: 'true',
      USAGE_LOG_PURGE_CRON: '0 5 * * *',
      FX_REFRESH_CRON: 'every day',
    });
    const everything = [...r.errors, ...r.warnings, ...r.summary].join('\n');
    expect(r.errors.length).toBeGreaterThan(0);
    expect(everything).not.toContain(secret);
  });

  it('a variable with a sensitive name whose value is invalid is hidden in the message', () => {
    expect(safeSample('SOME_SECRET', 'abc')).toBe('"[hidden]"');
    expect(safeSample('X_API_KEY', 'abc')).toBe('"[hidden]"');
    expect(safeSample('DATABASE_URL', 'postgres://u:p@h/d')).toBe('"[hidden]"');
    expect(safeSample('RETENTION_BATCH_SIZE', '5000')).toBe('"5000"');
    expect(safeSample('RETENTION_BATCH_SIZE', 'x'.repeat(100))).toBe(
      JSON.stringify('x'.repeat(40)),
    );
  });
});
