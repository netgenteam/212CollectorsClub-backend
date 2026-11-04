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

/**
 * `AuditService.record(tx, ev)` holds the chain-head lock until the transaction
 * commits, so after it NOTHING slow may run in the same callback (Stripe, mail,
 * HTTP, sleep, more queries). Heuristic, on source text: for every `.record(tx, ...)`
 * statement, the rest of the ENCLOSING FUNCTION (the nearest arrow/function body)
 * must contain no `await` (another `.record(` is fine: it is the same lock) and no
 * `.then(`. Returns one message per offending call. Prefer `AuditService.transaction`,
 * which flushes by construction after the callback.
 */
export function findRecordMisuse(src: string): string[] {
  const out: string[] = [];
  const re = /\.record\(\s*\w+\s*,/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    // end of the statement: matching ')' of the call
    let i = m.index + m[0].length - 1;
    let depth = 1;
    for (; i < src.length && depth > 0; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')') depth -= 1;
    }
    const stmtEnd = i;
    // enclosing function: walk back to the nearest unmatched `{` that opens a function body
    let open = -1;
    let back = 0;
    for (let j = m.index; j >= 0; j -= 1) {
      if (src[j] === '}') back += 1;
      else if (src[j] === '{') {
        if (back > 0) {
          back -= 1;
          continue;
        }
        const pre = src.slice(0, j).trimEnd();
        if (pre.endsWith('=>')) {
          open = j;
          break;
        }
        if (pre.endsWith(')')) {
          let k = pre.length - 1;
          let d = 0;
          for (; k >= 0; k -= 1) {
            if (pre[k] === ')') d += 1;
            else if (pre[k] === '(') {
              d -= 1;
              if (d === 0) break;
            }
          }
          const head = /([A-Za-z_$][\w$]*)\s*$/.exec(pre.slice(0, k).trimEnd());
          if (!head || !/^(if|for|while|switch|catch|with)$/.test(head[1])) {
            open = j;
            break;
          }
        }
      }
    }
    if (open < 0) continue;
    let end = open + 1;
    for (let d = 1; end < src.length && d > 0; end += 1) {
      if (src[end] === '{') d += 1;
      else if (src[end] === '}') d -= 1;
    }
    const tail = src.slice(stmtEnd, end);
    if (
      /\bawait\b(?!\s+[\w.]*\brecord\s*\()/.test(tail) ||
      /\.then\(/.test(tail)
    ) {
      const line = src.slice(0, m.index).split('\n').length;
      out.push(
        `line ${line}: work after record(); the chain lock is held until commit`,
      );
    }
  }
  return out;
}

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
