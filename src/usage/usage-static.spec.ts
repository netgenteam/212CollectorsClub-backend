import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Story 20.7: "Usage_Logs is MUTABLE on purpose and separate from Audit_Events; the limited role gets only what
 * it needs". These scans keep that true: nothing but the usage module touches the table, nobody ever
 * UPDATEs a row (the application role has no UPDATE on it), the usage module never touches the immutable
 * log, and the migration follows the project's rules.
 */
const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'generated' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|sql|mjs)$/.test(name)) out.push(full);
  }
  return out;
}
const read = (f: string) => readFileSync(f, 'utf8');
const stripComments = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*(\/\/|--).*$/gm, '');

const sources = walk(SRC)
  .filter((f) => !f.endsWith('.spec.ts'))
  .map((f) => ({ rel: relative(ROOT, f), text: stripComments(read(f)) }));

describe('Usage_Logs stays where it belongs (Story 20.7)', () => {
  it('only the usage module and the anonymization of an account (through UsageLogErasure) touch the table', () => {
    const touching = sources
      .filter((f) => /Usage_Logs/.test(f.text))
      .map((f) => f.rel)
      .sort();
    expect(touching).toEqual(
      [
        'src/usage/usage-erasure.service.ts',
        'src/usage/usage-log.writer.ts',
        'src/usage/usage-purge.service.ts',
        'src/usage/usage-read.service.ts',
      ].sort(),
    );
  });

  it('nobody UPDATEs a usage row (the application role has no UPDATE on the table), in src or in scripts', () => {
    const files = [
      ...sources,
      ...walk(join(ROOT, 'scripts')).map((f) => ({
        rel: relative(ROOT, f),
        text: stripComments(read(f)),
      })),
    ];
    for (const f of files) {
      // a REVOKE of those very privileges is the point, not a use of them
      const text = f.text.replace(/REVOKE[^;]*;/gi, '');
      expect(text, f.rel).not.toMatch(/UPDATE\s+"?Usage_Logs"?/i);
      expect(text, f.rel).not.toMatch(/TRUNCATE[^;`]*Usage_Logs/i);
    }
    // the Prisma delegate is never used for it either (it would be an UPDATE or a createMany around the writer)
    for (const f of sources) {
      expect(f.text, f.rel).not.toMatch(
        /\.usageLog\.(update|updateMany|upsert|create|createMany)\(/,
      );
    }
  });

  it('the usage module never writes or reads the immutable audit log', () => {
    for (const f of sources.filter((x) => x.rel.startsWith('src/usage/'))) {
      expect(f.text, f.rel).not.toMatch(/Audit_Events/);
      expect(f.text, f.rel).not.toMatch(/AuditService|\.audit\b/);
    }
  });

  it('the middleware never reads a body, a query, a parameter, Authorization or Cookie; the URL only decides an exclusion', () => {
    for (const rel of [
      'src/usage/usage-log.middleware.ts',
      'src/usage/route-normalize.ts',
    ]) {
      const text = sources.find((f) => f.rel === rel)!.text;
      expect(text, rel).not.toMatch(
        /\.body\b|rawBody|\.query\b|\.params\b|authorization|cookie|\.url\b/i,
      );
    }
    const mw = sources.find(
      (f) => f.rel === 'src/usage/usage-log.middleware.ts',
    )!.text;
    // `originalUrl` appears once, as the argument that decides the exclusion, and never reaches a column
    expect(mw.match(/originalUrl/g)).toHaveLength(1);
    expect(mw).toMatch(/isExcludedRequest\(req, req\.originalUrl/);
    expect(mw).not.toMatch(/route:\s*req\./);
  });

  it('db-roles.sql takes UPDATE and TRUNCATE on the table back from the application role', () => {
    const sql = read(join(ROOT, 'scripts', 'db-roles.sql'));
    expect(sql).toMatch(
      /REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON public\."Usage_Logs" FROM/,
    );
  });

  describe('the migration', () => {
    const dir = readdirSync(join(ROOT, 'prisma', 'migrations')).find((d) =>
      d.endsWith('_add_usage_logs_retention'),
    )!;
    const sql = read(join(ROOT, 'prisma', 'migrations', dir, 'migration.sql'));
    const code = stripComments(sql);

    it('is new (later than every migration the project had), starts with BEGIN; and ends with COMMIT;', () => {
      const all = readdirSync(join(ROOT, 'prisma', 'migrations'))
        .filter((d) => /^\d{14}_/.test(d))
        .sort();
      expect(all[all.length - 1]).toBe(dir);
      expect(sql.split('\n')[0]).toBe('BEGIN;');
      expect(sql.trimEnd().endsWith('COMMIT;')).toBe(true);
    });

    it('declares no lock_timeout (deploy.sh bounds it) and creates only new objects', () => {
      expect(code).not.toMatch(/lock_timeout/i);
      expect(code).not.toMatch(
        /ALTER TABLE|DROP (TABLE|INDEX|COLUMN|TRIGGER|FUNCTION)|DELETE FROM|UPDATE "\w+" SET|TRUNCATE (TABLE )?"/i,
      );
      expect(code.match(/CREATE TABLE "(\w+)"/g)).toEqual([
        'CREATE TABLE "Usage_Logs"',
        'CREATE TABLE "Retention_Runs"',
      ]);
    });

    it('has the columns and the six indexes of the story, and takes UPDATE away from the existing app roles', () => {
      for (const c of [
        '"id"         BIGSERIAL',
        '"ts"         TIMESTAMPTZ(3)',
        '"route"      VARCHAR(200)',
        '"status"     SMALLINT',
        '"durationMs" INTEGER',
        '"actorId"    UUID',
        '"ip"         INET',
        '"userAgent"  VARCHAR(200)',
        '"requestId"  UUID',
      ]) {
        expect(code).toContain(c);
      }
      for (const i of [
        'ON "Usage_Logs" ("ts")',
        'ON "Usage_Logs" ("actorId", "ts")',
        'ON "Usage_Logs" ("route" varchar_pattern_ops, "ts")',
        'ON "Usage_Logs" ("status", "ts")',
        'ON "Usage_Logs" ("ip", "ts")',
        'ON "Usage_Logs" ("requestId")',
      ]) {
        expect(code).toContain(i);
      }
      expect(code).toMatch(
        /REVOKE UPDATE, TRUNCATE, REFERENCES, TRIGGER ON "Usage_Logs"/,
      );
      expect(code).toContain('CREATE TABLE "Retention_Runs"');
    });
  });
});
