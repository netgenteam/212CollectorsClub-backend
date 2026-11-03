/**
 * Story 19.1: helpers for e2e that touch the legal tables.
 *
 * Rules (NFR-19.2, A81): sandbox documents (`isSandbox`, slug `e2e-*`) are
 * created ONLY here, through SQL; versions/audit rows of REAL documents are
 * append-only in the database and are never written or deleted by a test.
 * Cleanup deletes strictly through the sandbox predicate (and the DB triggers
 * would reject anything else anyway). `exec` is any "run this SQL with
 * params" function (Prisma `$queryRawUnsafe` or a pg client).
 */
type Exec = (
  sql: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>;

export interface SandboxDoc {
  id: string;
  slug: string;
}

export async function createSandboxDocument(
  exec: Exec,
  tag: string,
  opts: { kind?: string; title?: string; requiresAcceptance?: boolean } = {},
): Promise<SandboxDoc> {
  const slug = `e2e-${tag}`;
  const rows = await exec(
    `INSERT INTO "Legal_Documents" ("id","slug","title","kind","requiresAcceptance","isSandbox")
     VALUES (gen_random_uuid(), $1, $2, $3::"LegalDocKind", $4, true)
     RETURNING "id"`,
    [
      slug,
      opts.title ?? `Sandbox ${tag}`,
      opts.kind ?? 'TERMS',
      opts.requiresAcceptance ?? true,
    ],
  );
  return { id: rows[0].id as string, slug };
}

/** `effectiveFrom` is a Postgres interval relative to the DB `now()` (e.g. '-2 days'). */
export async function insertSandboxVersion(
  exec: Exec,
  documentId: string,
  versionNumber: number,
  opts: {
    bodyMd?: string;
    effectiveFrom?: string;
    isSubstantial?: boolean;
    changeSummary?: string;
    publishedByEmail?: string;
  } = {},
): Promise<void> {
  await exec(
    `INSERT INTO "Legal_Document_Versions"
       ("id","documentId","versionNumber","bodyMd","changeSummary","isSubstantial","effectiveFrom","publishedAt","publishedById","publishedByEmail")
     VALUES (gen_random_uuid(), $1::uuid, $2, $3, $4, $5, now() + $6::interval, now(), gen_random_uuid(), $7)`,
    [
      documentId,
      versionNumber,
      opts.bodyMd ?? `## Seccion ${versionNumber}\n\nTexto v${versionNumber}.`,
      opts.changeSummary ?? `Cambio de prueba ${versionNumber}`,
      opts.isSubstantial ?? false,
      opts.effectiveFrom ?? '-1 day',
      opts.publishedByEmail ?? 'author-secret@212collectorsclub.test',
    ],
  );
}

export async function insertSandboxDraft(
  exec: Exec,
  documentId: string,
  bodyMd: string,
): Promise<void> {
  await exec(
    `INSERT INTO "Legal_Drafts" ("id","documentId","bodyMd","updatedByEmail")
     VALUES (gen_random_uuid(), $1::uuid, $2, 'draft-author@212collectorsclub.test')`,
    [documentId, bodyMd],
  );
}

export async function insertSandboxAudit(
  exec: Exec,
  documentId: string,
  action = 'PUBLISHED',
): Promise<void> {
  await exec(
    `INSERT INTO "Legal_Audit_Logs" ("id","documentId","action","adminEmail","meta")
     VALUES (gen_random_uuid(), $1::uuid, $2::"LegalAuditAction", 'x@212collectorsclub.test', '{}'::jsonb)`,
    [documentId, action],
  );
}

/**
 * Deletes sandbox documents (all `isSandbox`, optionally one tag) with their
 * audit rows, drafts and versions. Never touches a real document.
 */
export async function purgeSandbox(exec: Exec, tag?: string): Promise<void> {
  const like = tag ? `e2e-${tag}%` : 'e2e-%';
  const ids = `(SELECT "id" FROM "Legal_Documents" WHERE "isSandbox" = true AND "slug" LIKE $1)`;
  // Story 19.4: acceptance evidence (append-only) that points at a sandbox
  // version blocks its deletion (FK RESTRICT). Only rows already orphaned by
  // their customer/order being removed can be deleted (the trigger decides);
  // linked ones must be released first by deleting that customer/order.
  await exec(
    `DELETE FROM "Consent_Records" WHERE "customerId" IS NULL AND "orderId" IS NULL
       AND "documentVersionId" IN (SELECT "id" FROM "Legal_Document_Versions" WHERE "documentId" IN ${ids})`,
    [like],
  );
  await exec(`DELETE FROM "Legal_Audit_Logs" WHERE "documentId" IN ${ids}`, [
    like,
  ]);
  await exec(`DELETE FROM "Legal_Drafts" WHERE "documentId" IN ${ids}`, [like]);
  await exec(
    `DELETE FROM "Legal_Document_Versions" WHERE "documentId" IN ${ids}`,
    [like],
  );
  await exec(
    `DELETE FROM "Legal_Documents" WHERE "isSandbox" = true AND "slug" LIKE $1`,
    [like],
  );
}

/** md5 of every REAL legal row (documents, versions, audits, drafts, identity). */
export async function realLegalFingerprint(exec: Exec): Promise<string> {
  const agg = (t: string, where: string, order: string) =>
    `(SELECT coalesce(string_agg(to_jsonb(x)::text, '|' ORDER BY ${order}), '') FROM "${t}" x ${where})`;
  const real = `WHERE x."documentId" IN (SELECT "id" FROM "Legal_Documents" WHERE NOT "isSandbox")`;
  const rows = await exec(
    `SELECT md5(concat_ws('#',
       ${agg('Legal_Documents', 'WHERE NOT x."isSandbox"', 'x."slug"')},
       ${agg('Legal_Document_Versions', real, 'x."id"')},
       ${agg('Legal_Audit_Logs', real, 'x."id"')},
       ${agg('Legal_Drafts', real, 'x."id"')},
       ${agg('Seller_Identity_Settings', '', 'x."id"')})) AS h`,
  );
  return rows[0].h as string;
}

export interface LegalRealSnapshot {
  drafts: string;
  identity: string;
  /** `draftRevisionFloor` of the real documents (a DB trigger raises it on every draft delete). */
  floors: string;
}

/**
 * Snapshot of the two REAL legal tables a test may legitimately modify and
 * restore (drafts of real documents, the identity singleton). Versions and
 * audit rows are append-only and are not part of it by design.
 */
export async function snapshotLegalReal(
  exec: Exec,
): Promise<LegalRealSnapshot> {
  const d = await exec(
    `SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x."id"), '[]'::jsonb)::text AS j FROM "Legal_Drafts" x
     WHERE x."documentId" IN (SELECT "id" FROM "Legal_Documents" WHERE NOT "isSandbox")`,
  );
  const i = await exec(
    `SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY x."id"), '[]'::jsonb)::text AS j FROM "Seller_Identity_Settings" x`,
  );
  const f = await exec(
    `SELECT coalesce(jsonb_agg(jsonb_build_object('id', x."id", 'f', x."draftRevisionFloor") ORDER BY x."id"), '[]'::jsonb)::text AS j
     FROM "Legal_Documents" x WHERE NOT x."isSandbox"`,
  );
  return {
    drafts: d[0].j as string,
    identity: i[0].j as string,
    floors: f[0].j as string,
  };
}

export async function restoreLegalReal(
  exec: Exec,
  s: LegalRealSnapshot,
): Promise<void> {
  await exec(
    `DELETE FROM "Legal_Drafts" WHERE "documentId" IN (SELECT "id" FROM "Legal_Documents" WHERE NOT "isSandbox")`,
  );
  await exec(
    `INSERT INTO "Legal_Drafts" SELECT * FROM jsonb_populate_recordset(NULL::"Legal_Drafts", $1::jsonb)`,
    [s.drafts],
  );
  // The insert trigger numbers drafts above the floor: put the saved revisions
  // and the saved floors back (UPDATEs are not guarded by those triggers).
  await exec(
    `UPDATE "Legal_Drafts" d SET "revision" = r."revision"
     FROM jsonb_populate_recordset(NULL::"Legal_Drafts", $1::jsonb) r WHERE r."id" = d."id"`,
    [s.drafts],
  );
  await exec(
    `UPDATE "Legal_Documents" x SET "draftRevisionFloor" = (j->>'f')::int
     FROM jsonb_array_elements($1::jsonb) j WHERE x."id" = (j->>'id')::uuid`,
    [s.floors],
  );
  await exec(`DELETE FROM "Seller_Identity_Settings"`);
  await exec(
    `INSERT INTO "Seller_Identity_Settings" SELECT * FROM jsonb_populate_recordset(NULL::"Seller_Identity_Settings", $1::jsonb)`,
    [s.identity],
  );
}
