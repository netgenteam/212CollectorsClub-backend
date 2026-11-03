import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Story 19.1 (NFR-19.2, AD-88): versions and the audit log are append-only.
 * No source file may call update/delete on them (the DB triggers are the
 * second line of defence, proven in the e2e).
 */
const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN =
  /legalDocumentVersion\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b|legalAuditLog\s*\.\s*(update|updateMany|upsert|delete|deleteMany)\b|(UPDATE|DELETE\s+FROM)\s+"Legal_(Document_Versions|Audit_Logs)"|TRUNCATE\s+(TABLE\s+)?"?Legal_/i;

const walk = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? e.name === 'generated'
        ? []
        : walk(join(dir, e.name))
      : e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')
        ? [join(dir, e.name)]
        : [],
  );

describe('legal sources never mutate versions or the audit log', () => {
  it('has no update/delete on legalDocumentVersion / legalAuditLog', () => {
    const offenders = walk(SRC).filter((f) =>
      FORBIDDEN.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('the guard regex does catch the forbidden calls', () => {
    for (const bad of [
      'this.prisma.legalDocumentVersion.update({})',
      'tx.legalDocumentVersion.deleteMany()',
      'prisma.legalAuditLog.delete(x)',
      'DELETE FROM "Legal_Audit_Logs"',
      'UPDATE "Legal_Document_Versions" SET',
      'TRUNCATE "Legal_Audit_Logs"',
    ]) {
      expect(FORBIDDEN.test(bad)).toBe(true);
    }
    expect(FORBIDDEN.test('prisma.legalDocumentVersion.create({})')).toBe(
      false,
    );
  });

  it('public sources never read Legal_Drafts', () => {
    for (const name of [
      'legal-public.controller.ts',
      'legal-documents.service.ts',
      'legal-markdown.service.ts',
    ]) {
      expect(readFileSync(join(SRC, 'legal', name), 'utf8')).not.toMatch(
        /Legal_Drafts|legalDraft\b/,
      );
    }
  });

  it('no e2e or test helper disables an immutability trigger (Story 19.9)', () => {
    const TESTS = resolve(SRC, '..', 'test');
    const walkTests = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? walkTests(join(dir, e.name))
          : e.name.endsWith('.ts')
            ? [join(dir, e.name)]
            : [],
      );
    const DISABLE =
      /DISABLE\s+(ALL\s+|USER\s+)?TRIGGER|session_replication_role/i;
    expect(DISABLE.test('ALTER TABLE "T" disable   trigger "x"')).toBe(true);
    expect(DISABLE.test("SET session_replication_role = 'replica'")).toBe(true);
    const offenders = walkTests(TESTS).filter((f) =>
      DISABLE.test(readFileSync(f, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
