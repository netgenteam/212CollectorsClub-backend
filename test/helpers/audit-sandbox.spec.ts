import { describe, expect, it } from 'vitest';
import {
  assertSandboxTable,
  mentionsAuditTable,
  parseSandboxName,
  sandboxName,
} from './audit-sandbox.js';

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

describe('the sandbox never falls through to public."Audit_Events"', () => {
  it('assertSandboxTable throws when the sandbox table does not exist', async () => {
    const query = (ok: boolean) => Promise.resolve({ rows: [{ ok }] }) as never;
    await expect(
      assertSandboxTable({ query: () => query(false) }, 'audit_t_x'),
    ).rejects.toThrow(/no "Audit_Events" table/);
    await expect(
      assertSandboxTable({ query: () => query(true) }, 'audit_t_x'),
    ).resolves.toBeUndefined();
  });

  it('asks about the table QUALIFIED with the sandbox schema (never the search_path)', async () => {
    const seen: unknown[][] = [];
    await assertSandboxTable(
      {
        query: ((_q: string, p: unknown[]) => {
          seen.push(p);
          return Promise.resolve({ rows: [{ ok: true }] });
        }) as never,
      },
      'audit_t_abc',
    );
    expect(seen).toEqual([['"audit_t_abc"."Audit_Events"']]);
  });

  it.each([
    ['SELECT * FROM "Audit_Events"', true],
    ['SELECT count(*) FROM Audit_Events', true],
    ['ALTER TABLE "Audit_Events" ADD CONSTRAINT x CHECK (false)', true],
    ['SELECT 1 FROM "Orders"', false],
    ['SELECT 1 FROM "Audit_Events_occurredAt_idx_x"', false],
  ])('mentionsAuditTable(%j) = %s', (sql, expected) => {
    expect(mentionsAuditTable(sql)).toBe(expected);
  });
});
