import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');
const SRC = resolve(ROOT, 'src');

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === 'generated' || e.name === 'node_modules') return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith('.ts') ? [p] : [];
  });

/** A Prisma write on the model, or a raw INSERT/UPDATE/DELETE/TRUNCATE on the table. */
export const FORBIDDEN =
  /auditEvent\s*\.\s*(create|createMany|update|updateMany|delete|deleteMany|upsert)\b|(INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(\s+TABLE)?)\s+"?Audit_Events"?/i;

describe('Audit_Events has ONE writer (Story 20.1, AD-99)', () => {
  it('the pattern catches what it must', () => {
    for (const bad of [
      'prisma.auditEvent.create({})',
      'tx.auditEvent .upsert(x)',
      'INSERT INTO "Audit_Events" (seq)',
      'delete from "Audit_Events"',
      'UPDATE "Audit_Events" SET',
      'TRUNCATE "Audit_Events"',
    ]) {
      expect(FORBIDDEN.test(bad)).toBe(true);
    }
    expect(FORBIDDEN.test('SELECT * FROM "Audit_Events"')).toBe(false);
    expect(FORBIDDEN.test('auditEvent.findMany()')).toBe(false);
  });

  it('no file outside AuditService writes it (spec files excluded: they assert the opposite)', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith('.spec.ts'))
      .filter(
        (f) =>
          relative(SRC, f).split(sep).join('/') !== 'audit/audit.service.ts',
      )
      .filter((f) => FORBIDDEN.test(readFileSync(f, 'utf8')));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });

  it('AuditService does contain the only INSERT', () => {
    expect(
      FORBIDDEN.test(
        readFileSync(join(SRC, 'audit', 'audit.service.ts'), 'utf8'),
      ),
    ).toBe(true);
  });

  it('the controller exposes no route that changes or deletes events', () => {
    const src = readFileSync(
      join(SRC, 'audit', 'audit-admin.controller.ts'),
      'utf8',
    );
    expect(src).not.toMatch(/@(Put|Patch|Delete)\s*\(/);
    expect(src.match(/@Post\s*\(/g)).toEqual(['@Post(']); // only `verify`
    expect(src).toMatch(/@Post\('verify'\)/);
  });

  it('the Prisma model is read-only by usage: no Prisma write call on it anywhere in src or test', () => {
    const offenders = [...walk(SRC), ...walk(join(ROOT, 'test'))]
      .filter((f) => !f.endsWith('audit-static.spec.ts'))
      .filter((f) =>
        /auditEvent\s*\.\s*(create|createMany|update|updateMany|delete|deleteMany|upsert)\b/.test(
          readFileSync(f, 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
