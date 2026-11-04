import { describe, expect, it } from 'vitest';
import { parseSandboxName, sandboxName } from './audit-sandbox.js';

describe('sandbox schema names: only ours are ever dropped by the global setup', () => {
  it('parses what sandboxName() makes', () => {
    const before = Math.floor(Date.now() / 1000);
    const p = parseSandboxName(sandboxName());
    expect(p).not.toBeNull();
    expect(p!.createdAtSeconds).toBeGreaterThanOrEqual(before - 1);
    expect(p!.run).toBe('norun');
  });

  it.each([
    'audit_t_foo',
    'audit_t_foo_bar_baz',
    'audit_t_',
    'audit_t_tbydbp_norun',
    'audit_t_tbydbp_norun_zzzzzzzz', // not hex
    'audit_t_tbydbp_norun_0123456789', // too long
    'audit_t_000000_norun_0123abcd', // 1970
    'audit_t_zzzzzzzz_norun_0123abcd', // year 2100+
    'audit_t_TBYDBP_norun_0123abcd',
    'xaudit_t_tbydbp_norun_0123abcd',
    'audit_t_tbydbp_norun_0123abcd_extra',
    'public',
  ])('rejects the foreign name %s', (name) => {
    expect(parseSandboxName(name)).toBeNull();
  });
});
