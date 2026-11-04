import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRecordMisuse } from '../../test/helpers/find-record-misuse.js';

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

describe('record() must be the last thing a transaction does (Story 20.1, safe use)', () => {
  const bad = `
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id }, data: {} });
      await this.audit.record(tx, ev);
      await this.stripe.refund(id);
    });`;
  const badBranch = `
    const run = async (tx: Tx) => {
      if (x) {
        await this.audit.record(tx, ev);
      }
      await this.mailer.send(m);
    };`;
  const badThen = `
    this.prisma.$transaction((tx) => {
      return this.audit.record(tx, ev).then(() => slow());
    });`;
  const good = `
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({ where: { id }, data: {} });
      await this.audit.record(tx, a);
      await this.audit.record(tx, b);
      return 1;
    });
    await this.stripe.after(); // outside the transaction: fine`;
  const goodTransaction = `
    await this.audit.transaction(async (tx, audit) => {
      await this.stripe.refund(id);
      audit.add(ev);
    });`;

  it('the detector catches work after record() and lets the right shapes pass', () => {
    expect(findRecordMisuse(bad)).toHaveLength(1);
    expect(findRecordMisuse(badBranch)).toHaveLength(1);
    expect(findRecordMisuse(badThen)).toHaveLength(1);
    expect(findRecordMisuse(good)).toEqual([]);
    expect(findRecordMisuse(goodTransaction)).toEqual([]);
  });

  // The shapes the first (regex) version missed. Each wraps `body` in a callback.
  const wrap = (body: string, extra = '') => `
    class S {
      ${extra}
      async run() {
        await this.prisma.$transaction(async (tx) => {
          ${body}
        });
      }
    }`;

  it.each([
    [
      'await in a helper that records',
      wrap(
        `await this.emit(tx, ev);
         await this.stripe.refund(id);`,
        `async emit(tx, ev) { await this.audit.record(tx, ev); }`,
      ),
    ],
    [
      'Promise.all next to record',
      wrap(
        `await Promise.all([this.audit.record(tx, ev), this.stripe.refund(id)]);`,
      ),
    ],
    [
      'alias of record',
      wrap(
        `const rec = this.audit.record.bind(this.audit);
         await rec(tx, ev);
         await this.mailer.send(m);`,
      ),
    ],
    [
      'destructured record',
      wrap(
        `const { record } = this.audit;
         await record(tx, ev);
         await this.mailer.send(m);`,
      ),
    ],
    [
      'destructured and renamed record',
      wrap(
        `const { record: rec } = this.audit;
         await rec(tx, ev);
         await slow();`,
      ),
    ],
    [
      "element access this.audit['record']",
      wrap(
        `await this.audit['record'](tx, ev);
         await this.stripe.refund(id);`,
      ),
    ],
    [
      'the transaction handed to another function',
      wrap(
        `await this.audit.record(tx, ev);
         await this.helper(tx);`,
      ),
    ],
    [
      'the transaction used without await',
      wrap(
        `await this.audit.record(tx, ev);
         void tx.order.findMany();`,
      ),
    ],
    [
      'await in finally',
      wrap(
        `try { await this.audit.record(tx, ev); } finally { await this.cleanup(); }`,
      ),
    ],
    [
      'await earlier in the same loop (the next iteration runs after record)',
      wrap(
        `for (const ev of evs) { await this.stripe.call(ev); await this.audit.record(tx, ev); }`,
      ),
    ],
    [
      'await after the if that contains record',
      wrap(
        `if (x) { await this.audit.record(tx, ev); }
         await this.mailer.send(m);`,
      ),
    ],
    [
      'for await',
      wrap(
        `await this.audit.record(tx, ev);
         for await (const x of stream()) { use(x); }`,
      ),
    ],
  ])('catches: %s', (_what, src) => {
    expect(findRecordMisuse(src).length).toBeGreaterThan(0);
  });

  it.each([
    [
      'an await in the OTHER branch of the if',
      wrap(
        `if (ok) { await this.audit.record(tx, ev); } else { await this.mailer.send(m); }`,
      ),
    ],
    [
      'an await in the catch of the try that holds record (the transaction is dead)',
      wrap(
        `try { await this.audit.record(tx, ev); } catch (e) { await this.log(e); throw e; }`,
      ),
    ],
    [
      'an await after an early return',
      wrap(
        `if (x) { await this.audit.record(tx, ev); return 1; }
         await this.other(tx);`,
      ),
    ],
    [
      'the word await in a comment or a string',
      wrap(
        `await this.audit.record(tx, ev);
         // await this.stripe.refund(id)
         const s = 'await this.mailer.send(m); .then(x)';
         return s.length;`,
      ),
    ],
    [
      'two records in a row, with the same transaction',
      wrap(
        `await this.audit.record(tx, a);
         await this.audit.record(tx, b);`,
      ),
    ],
    [
      'Promise.all of records only',
      wrap(
        `await Promise.all([this.audit.record(tx, a), this.audit.record(tx, b)]);`,
      ),
    ],
    [
      'work BEFORE record and a plain return after',
      wrap(
        `await this.stripe.refund(id);
         await tx.order.update({ where: { id }, data: {} });
         await this.audit.record(tx, ev);
         return { ok: true };`,
      ),
    ],
    [
      'an await inside a nested callback that is not run inline',
      wrap(
        `await this.audit.record(tx, ev);
         setImmediate(async () => { await later(); });`,
      ),
    ],
    [
      'a helper that records, used as the last thing',
      wrap(
        `await tx.order.update({ where: { id }, data: {} });
         await this.emit(tx, ev);`,
        `async emit(tx, ev) { await this.audit.record(tx, ev); }`,
      ),
    ],
  ])('accepts: %s', (_what, src) => {
    expect(findRecordMisuse(src)).toEqual([]);
  });

  it('no call site in src has work after record()', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith('.spec.ts'))
      // Only code that uses THE chain (`AuditService`); `LegalAuditService.record` is another table with no chain lock.
      .filter((f) => /audit\/audit\.service\.js'/.test(readFileSync(f, 'utf8')))
      .flatMap((f) =>
        findRecordMisuse(readFileSync(f, 'utf8')).map(
          (m) => `${relative(ROOT, f)} ${m}`,
        ),
      );
    expect(offenders).toEqual([]);
  });
});

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
