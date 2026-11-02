import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './../src/prisma/prisma.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  createSandboxDocument,
  insertSandboxAudit,
  insertSandboxVersion,
  purgeSandbox,
  realLegalFingerprint,
} from './helpers/legal-sandbox.js';

/**
 * Story 19.1 (AC1-3, NFR-19.2): immutability enforced by the DATABASE, proven
 * through the app's own connection (PrismaService / driver adapter, the same
 * role the API uses).
 *
 * The six real documents have no committed versions/audit rows and real
 * evidence must never be written, so every attempt against a REAL document
 * runs inside ONE interactive transaction that is ALWAYS rolled back (a
 * sentinel throw), with a SAVEPOINT around each statement expected to fail.
 * Nothing real is ever committed, and the fingerprint of the real rows is
 * compared before/after.
 */
const TAG = randomUUID().slice(0, 8);
const ROLLBACK = new Error('rollback-sentinel');
const REAL = [
  'terminos',
  'privacidad',
  'cookies',
  'envios',
  'devoluciones',
  'aviso-legal',
];

describe('Legal immutability triggers & seed (e2e, Story 19.1)', () => {
  let prisma: PrismaService;
  let fingerprint: string;

  const sql = (q: string, p: unknown[] = []) =>
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule],
    }).compile();
    prisma = mod.get(PrismaService);
    await mod.init();
    await purgeSandbox(sql);
    fingerprint = await realLegalFingerprint(sql);
  });

  afterAll(async () => {
    await purgeSandbox(sql, TAG);
    expect(await realLegalFingerprint(sql)).toBe(fingerprint);
    await prisma.$disconnect();
  });

  /** SQLSTATE of the error a Prisma raw call threw (via the driver adapter). */
  const sqlstate = (e: unknown): string => {
    const err = e as {
      code?: string;
      meta?: { driverAdapterError?: { cause?: { code?: string } } };
      message?: string;
    };
    return (
      err.meta?.driverAdapterError?.cause?.code ??
      /\b(23000|23[0-9]{3}|P2010)\b/.exec(err.message ?? '')?.[1] ??
      String(err.code)
    );
  };

  it('the migration seeds the six real documents and the empty singleton', async () => {
    const docs = await sql(
      `SELECT "slug","kind"::text AS kind,"requiresAcceptance","isSandbox" FROM "Legal_Documents" WHERE NOT "isSandbox" ORDER BY "slug"`,
    );
    expect(docs.map((d) => d.slug)).toEqual([...REAL].sort());
    expect(docs.every((d) => d.isSandbox === false)).toBe(true);
    const need = Object.fromEntries(
      docs.map((d) => [d.slug as string, d.requiresAcceptance]),
    );
    expect(need).toEqual({
      terminos: true,
      privacidad: true,
      envios: true,
      devoluciones: true,
      cookies: false,
      'aviso-legal': false,
    });
    const id = await sql(
      `SELECT * FROM "Seller_Identity_Settings" WHERE "id" = 'default'`,
    );
    expect(id).toHaveLength(1);
  });

  it('re-running the migration seed statements is idempotent (same ids, no new rows)', async () => {
    const dir = readdirSync('prisma/migrations').find((d) =>
      d.endsWith('_add_legal_documents'),
    )!;
    const full = readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8');
    const seed = full.slice(full.indexOf('-- ─── Seed rows'));
    const before = await sql(
      `SELECT "id","slug" FROM "Legal_Documents" WHERE NOT "isSandbox" ORDER BY "slug"`,
    );
    const statements = seed
      .replace(/^\s*--.*$/gm, '')
      .split(';')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('INSERT'));
    expect(statements).toHaveLength(2);
    for (const s of statements) await prisma.$executeRawUnsafe(s);
    const after = await sql(
      `SELECT "id","slug" FROM "Legal_Documents" WHERE NOT "isSandbox" ORDER BY "slug"`,
    );
    expect(after).toEqual(before);
    expect(await realLegalFingerprint(sql)).toBe(fingerprint);
  });

  it('CHECK: slug outside the six is only valid for sandbox documents named e2e-*', async () => {
    for (const bad of [
      `INSERT INTO "Legal_Documents" ("id","slug","title","kind","requiresAcceptance","isSandbox") VALUES (gen_random_uuid(),'otro','x','TERMS',true,false)`,
      `INSERT INTO "Legal_Documents" ("id","slug","title","kind","requiresAcceptance","isSandbox") VALUES (gen_random_uuid(),'otro','x','TERMS',true,true)`,
      `INSERT INTO "Legal_Documents" ("id","slug","title","kind","requiresAcceptance","isSandbox") VALUES (gen_random_uuid(),'e2e-x','x','TERMS',true,false)`,
    ]) {
      await expect(prisma.$executeRawUnsafe(bad)).rejects.toThrow();
    }
    const n = await sql(`SELECT count(*)::int AS n FROM "Legal_Documents"`);
    expect(n[0].n).toBe(REAL.length + 0);
  });

  it('real document: UPDATE, DELETE and TRUNCATE of versions/audit rows fail with integrity_constraint_violation (rolled back)', async () => {
    const results: Record<string, string> = {};
    await prisma
      .$transaction(
        async (tx) => {
          const real = (
            await tx.$queryRawUnsafe<{ id: string }[]>(
              `SELECT "id" FROM "Legal_Documents" WHERE "slug" = 'terminos' AND NOT "isSandbox"`,
            )
          )[0].id;
          // Evidence rows exist ONLY inside this transaction.
          await tx.$executeRawUnsafe(
            `INSERT INTO "Legal_Document_Versions" ("id","documentId","versionNumber","bodyMd","changeSummary","isSubstantial","effectiveFrom")
             VALUES (gen_random_uuid(), $1::uuid, 1, 'cuerpo', 'resumen de prueba', false, now())`,
            real,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO "Legal_Audit_Logs" ("id","documentId","action") VALUES (gen_random_uuid(), $1::uuid, 'PUBLISHED')`,
            real,
          );
          await tx.$executeRawUnsafe(
            `INSERT INTO "Legal_Audit_Logs" ("id","documentId","action") VALUES (gen_random_uuid(), NULL, 'IDENTITY_UPDATED')`,
          );
          const attempts: [string, string][] = [
            [
              'version UPDATE',
              `UPDATE "Legal_Document_Versions" SET "bodyMd" = 'alterado' WHERE "documentId" = '${real}'`,
            ],
            [
              'version DELETE',
              `DELETE FROM "Legal_Document_Versions" WHERE "documentId" = '${real}'`,
            ],
            ['version TRUNCATE', `TRUNCATE "Legal_Document_Versions"`],
            [
              'version TRUNCATE CASCADE',
              `TRUNCATE "Legal_Document_Versions" CASCADE`,
            ],
            [
              'audit UPDATE',
              `UPDATE "Legal_Audit_Logs" SET "meta" = '{"x":1}' WHERE "documentId" = '${real}'`,
            ],
            [
              'audit DELETE',
              `DELETE FROM "Legal_Audit_Logs" WHERE "documentId" = '${real}'`,
            ],
            [
              'audit (no document) UPDATE',
              `UPDATE "Legal_Audit_Logs" SET "adminEmail" = 'x' WHERE "documentId" IS NULL`,
            ],
            [
              'audit (no document) DELETE',
              `DELETE FROM "Legal_Audit_Logs" WHERE "documentId" IS NULL`,
            ],
            ['audit TRUNCATE', `TRUNCATE "Legal_Audit_Logs"`],
            ['document TRUNCATE CASCADE', `TRUNCATE "Legal_Documents" CASCADE`],
            [
              'document DELETE',
              `DELETE FROM "Legal_Documents" WHERE "id" = '${real}'`,
            ],
            [
              'document rename slug',
              `UPDATE "Legal_Documents" SET "slug" = 'e2e-renamed' WHERE "id" = '${real}'`,
            ],
            [
              'make real document sandbox',
              `UPDATE "Legal_Documents" SET "isSandbox" = true WHERE "id" = '${real}'`,
            ],
            [
              'make real document sandbox + slug',
              `UPDATE "Legal_Documents" SET "isSandbox" = true, "slug" = 'e2e-x' WHERE "id" = '${real}'`,
            ],
            [
              'real document kind change (D2)',
              `UPDATE "Legal_Documents" SET "kind" = 'PRIVACY' WHERE "id" = '${real}'`,
            ],
            [
              'real document requiresAcceptance change (D2)',
              `UPDATE "Legal_Documents" SET "requiresAcceptance" = false WHERE "id" = '${real}'`,
            ],
            [
              'real document id change (D2)',
              `UPDATE "Legal_Documents" SET "id" = gen_random_uuid() WHERE "id" = '${real}'`,
            ],
          ];
          for (const [name, stmt] of attempts) {
            await tx.$executeRawUnsafe('SAVEPOINT attempt');
            try {
              await tx.$executeRawUnsafe(stmt);
              results[name] = 'SUCCEEDED';
            } catch (e) {
              results[name] = sqlstate(e);
            }
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT attempt');
          }
          // After all failed attempts the rows are intact (inside the tx).
          const v = await tx.$queryRawUnsafe<{ bodyMd: string }[]>(
            `SELECT "bodyMd" FROM "Legal_Document_Versions" WHERE "documentId" = $1::uuid`,
            real,
          );
          expect(v).toEqual([{ bodyMd: 'cuerpo' }]);
          const d = await tx.$queryRawUnsafe<
            { isSandbox: boolean; slug: string }[]
          >(
            `SELECT "isSandbox","slug" FROM "Legal_Documents" WHERE "id" = $1::uuid`,
            real,
          );
          expect(d).toEqual([{ isSandbox: false, slug: 'terminos' }]);
          throw ROLLBACK;
        },
        { timeout: 30_000 },
      )
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });
    for (const [name, code] of Object.entries(results)) {
      // 23000 = integrity_constraint_violation (what the triggers raise).
      expect([name, code]).toEqual([name, '23000']);
    }
    expect(Object.keys(results)).toHaveLength(17);
    // Nothing leaked out of the rolled-back transaction.
    expect(await realLegalFingerprint(sql)).toBe(fingerprint);
    const n = await sql(
      `SELECT (SELECT count(*)::int FROM "Legal_Document_Versions" v JOIN "Legal_Documents" d ON d."id"=v."documentId" WHERE NOT d."isSandbox") AS v,
              (SELECT count(*)::int FROM "Legal_Audit_Logs" a WHERE a."documentId" IS NULL OR a."documentId" IN (SELECT "id" FROM "Legal_Documents" WHERE NOT "isSandbox")) AS a`,
    );
    expect(n[0]).toEqual({ v: 0, a: 0 });
  });

  it('sandbox document: rows can be updated and deleted (cleanup works), TRUNCATE still fails', async () => {
    const doc = await createSandboxDocument(sql, `${TAG}-trg`);
    await insertSandboxVersion(sql, doc.id, 1);
    await insertSandboxVersion(sql, doc.id, 2);
    await insertSandboxAudit(sql, doc.id);
    await prisma.$executeRawUnsafe(
      `UPDATE "Legal_Document_Versions" SET "bodyMd" = 'cambiado' WHERE "documentId" = $1::uuid AND "versionNumber" = 1`,
      doc.id,
    );
    await prisma.$executeRawUnsafe(
      `UPDATE "Legal_Audit_Logs" SET "meta" = '{"a":1}' WHERE "documentId" = $1::uuid`,
      doc.id,
    );
    const body = await sql(
      `SELECT "bodyMd" FROM "Legal_Document_Versions" WHERE "documentId" = $1::uuid AND "versionNumber" = 1`,
      [doc.id],
    );
    expect(body[0].bodyMd).toBe('cambiado');
    let code = '';
    await prisma
      .$executeRawUnsafe(`TRUNCATE "Legal_Audit_Logs"`)
      .catch((e: unknown) => {
        code = sqlstate(e);
      });
    expect(code).toBe('23000');
    // The sandbox may not be turned into a real document nor renamed either.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "Legal_Documents" SET "isSandbox" = false WHERE "id" = $1::uuid`,
        doc.id,
      ),
    ).rejects.toThrow();
    await purgeSandbox(sql, TAG);
    const left = await sql(
      `SELECT count(*)::int AS n FROM "Legal_Documents" WHERE "slug" LIKE $1`,
      [`e2e-${TAG}%`],
    );
    expect(left[0].n).toBe(0);
  });

  it('D2: a sandbox row cannot be re-parented / renumbered onto a real document (version and audit)', async () => {
    const doc = await createSandboxDocument(sql, `${TAG}-evade`);
    await insertSandboxVersion(sql, doc.id, 1);
    await insertSandboxAudit(sql, doc.id);
    const real = (
      await sql(`SELECT "id" FROM "Legal_Documents" WHERE "slug" = 'terminos'`)
    )[0].id as string;
    const results: Record<string, string> = {};
    // Rolled back even if (a regression) the evasion succeeded: never commit it.
    await prisma
      .$transaction(
        async (tx) => {
          const attempts: [string, string, unknown[]][] = [
            [
              'reparent + renumber version',
              `UPDATE "Legal_Document_Versions" SET "documentId" = $1::uuid, "versionNumber" = 7 WHERE "documentId" = $2::uuid`,
              [real, doc.id],
            ],
            [
              'reparent version only',
              `UPDATE "Legal_Document_Versions" SET "documentId" = $1::uuid WHERE "documentId" = $2::uuid`,
              [real, doc.id],
            ],
            [
              'renumber sandbox version',
              `UPDATE "Legal_Document_Versions" SET "versionNumber" = 7 WHERE "documentId" = $1::uuid`,
              [doc.id],
            ],
            [
              'change version id',
              `UPDATE "Legal_Document_Versions" SET "id" = gen_random_uuid() WHERE "documentId" = $1::uuid`,
              [doc.id],
            ],
            [
              'reparent audit',
              `UPDATE "Legal_Audit_Logs" SET "documentId" = $1::uuid WHERE "documentId" = $2::uuid`,
              [real, doc.id],
            ],
            [
              'reparent audit to no document',
              `UPDATE "Legal_Audit_Logs" SET "documentId" = NULL WHERE "documentId" = $1::uuid`,
              [doc.id],
            ],
            [
              'change audit id',
              `UPDATE "Legal_Audit_Logs" SET "id" = gen_random_uuid() WHERE "documentId" = $1::uuid`,
              [doc.id],
            ],
            [
              'change sandbox document id',
              `UPDATE "Legal_Documents" SET "id" = gen_random_uuid() WHERE "id" = $1::uuid`,
              [doc.id],
            ],
          ];
          for (const [name, stmt, params] of attempts) {
            await tx.$executeRawUnsafe('SAVEPOINT attempt');
            try {
              await tx.$executeRawUnsafe(stmt, ...params);
              results[name] = 'SUCCEEDED';
            } catch (e) {
              results[name] = sqlstate(e);
            }
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT attempt');
          }
          // Edits that keep the identity are still fine in the sandbox.
          await tx.$executeRawUnsafe(
            `UPDATE "Legal_Document_Versions" SET "bodyMd" = 'x', "changeSummary" = 'y' WHERE "documentId" = $1::uuid`,
            doc.id,
          );
          throw ROLLBACK;
        },
        { timeout: 30_000 },
      )
      .catch((e: unknown) => {
        if (e !== ROLLBACK) throw e;
      });
    for (const [name, code] of Object.entries(results)) {
      expect([name, code]).toEqual([name, '23000']);
    }
    expect(Object.keys(results)).toHaveLength(8);
    // Committed state: the real document has no forged rows, the sandbox keeps its own.
    const forged = await sql(
      `SELECT count(*)::int AS n FROM "Legal_Document_Versions" WHERE "documentId" = $1::uuid`,
      [real],
    );
    expect(forged[0].n).toBe(0);
    expect(await realLegalFingerprint(sql)).toBe(fingerprint);
    // Cleanup of the sandbox still works with the app connection.
    await purgeSandbox(sql, TAG);
    const left = await sql(
      `SELECT (SELECT count(*)::int FROM "Legal_Documents" WHERE "slug" LIKE $1) AS d,
              (SELECT count(*)::int FROM "Legal_Document_Versions" WHERE "documentId" = $2::uuid) AS v,
              (SELECT count(*)::int FROM "Legal_Audit_Logs" WHERE "documentId" = $2::uuid) AS a`,
      [`e2e-${TAG}%`, doc.id],
    );
    expect(left[0]).toEqual({ d: 0, v: 0, a: 0 });
  });

  it('the cleanup helper cannot touch a real document (predicate + triggers)', async () => {
    await purgeSandbox(sql);
    const n = await sql(
      `SELECT count(*)::int AS n FROM "Legal_Documents" WHERE NOT "isSandbox"`,
    );
    expect(n[0].n).toBe(REAL.length);
    expect(await realLegalFingerprint(sql)).toBe(fingerprint);
  });

  it('no migration/DDL side effects: existing tables untouched (additive only)', () => {
    const dir = readdirSync('prisma/migrations').find((d) =>
      d.endsWith('_add_legal_documents'),
    )!;
    const full = readFileSync(`prisma/migrations/${dir}/migration.sql`, 'utf8');
    expect(full).not.toMatch(/ALTER TABLE "(?!Legal_)/);
    expect(full).not.toMatch(/DROP /i);
  });
});
