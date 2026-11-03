import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { applyJsonBodyLimit } from './../src/common/json-body-limit.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  LegalSeedService,
  loadLegalSeedTemplates,
  type LegalSeedTemplate,
} from './../src/legal/legal-seed.service.js';
import { LEGAL_SLUGS } from './../src/legal/legal-slugs.js';
import {
  createSandboxDocument,
  insertSandboxDraft,
  insertSandboxVersion,
  purgeSandbox,
  realLegalFingerprint,
  restoreLegalReal,
  snapshotLegalReal,
  type LegalRealSnapshot,
  type SandboxDoc,
} from './helpers/legal-sandbox.js';

vi.setConfig({ testTimeout: 40_000, hookTimeout: 60_000 });

/**
 * Story 19.3 (AC1, AC4-AC6): the idempotent seed of the six drafts against the
 * real database. Seeding REAL documents would leave undeletable audit rows
 * (append-only), so the creation paths run on SANDBOX documents (`e2e-*`) that
 * receive the real templates under sandbox slugs; the six real documents are
 * only exercised on paths that write nothing (they already have a draft or a
 * version), inside a snapshot/restore of the real draft table.
 */
const TAG = randomUUID().slice(0, 8);
const USER = `e2e-admin-story-19-3-${TAG}`;
const EMAIL = `${USER}@212collectorsclub.test`;
const PASS = 'correct-horse-battery-staple-19-3';
const HEADER = 'Plantilla — revisar';

describe('Legal seed (e2e, Story 19.3)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;
  let fingerprint: string;
  let saved: LegalRealSnapshot;
  let real: LegalSeedTemplate[];
  let sandboxTemplates: LegalSeedTemplate[];
  const docs: Record<string, SandboxDoc> = {};

  const sql = (q: string, p: unknown[] = []) =>
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const svc = () => new LegalSeedService(prisma);
  const sbSlug = (s: string) => `e2e-${TAG}-${s}`;
  const sandboxState = async () =>
    sql(
      `SELECT d."slug", dr."revision", dr."bodyMd", dr."updatedAt"::text AS "u", d."draftRevisionFloor" AS "floor",
              (SELECT count(*)::int FROM "Legal_Document_Versions" v WHERE v."documentId" = d."id") AS "versions",
              (SELECT count(*)::int FROM "Legal_Audit_Logs" a WHERE a."documentId" = d."id") AS "audits"
       FROM "Legal_Documents" d LEFT JOIN "Legal_Drafts" dr ON dr."documentId" = d."id"
       WHERE d."slug" LIKE $1 ORDER BY d."slug"`,
      [`e2e-${TAG}-%`],
    );

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    applyJsonBodyLimit(app);
    await app.init();
    prisma = app.get(PrismaService);

    await purgeSandbox(sql);
    fingerprint = await realLegalFingerprint(sql);
    saved = await snapshotLegalReal(sql);

    const admin = await prisma.adminUser.create({
      data: {
        username: USER,
        email: EMAIL,
        passwordHash: await argon2.hash(PASS, { type: argon2.argon2id }),
      },
    });
    adminId = admin.id;
    const login = await request(http())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;

    real = await loadLegalSeedTemplates();
    sandboxTemplates = real.map((t) => ({ ...t, slug: sbSlug(t.slug) }));
    for (const t of sandboxTemplates) {
      docs[t.slug] = await createSandboxDocument(sql, t.slug.slice(4));
    }
  }, 60_000);

  afterAll(async () => {
    await purgeSandbox(sql, TAG);
    await restoreLegalReal(sql, saved);
    expect(await realLegalFingerprint(sql)).toBe(fingerprint);
    await prisma.adminUser.delete({ where: { id: adminId } }).catch(() => {});
    await app.close();
  });

  it('AC1: 5 parallel seeds leave exactly 6 drafts, each created once, with no unhandled P2002', async () => {
    const runs = await Promise.all(
      Array.from({ length: 5 }, () => svc().seedDrafts(sandboxTemplates)),
    );
    const flat = runs.flat();
    expect(flat.filter((r) => r.outcome === 'CREATED')).toHaveLength(6);
    expect(flat.filter((r) => r.outcome === 'SKIPPED_HAS_DRAFT')).toHaveLength(
      24,
    );

    const rows = await sandboxState();
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      expect(r.revision).toBe(1);
      expect(r.floor).toBe(0); // a skipped run never raises the floor
      expect(r.versions).toBe(0); // never a published version
      expect(r.audits).toBe(1); // one DRAFT_CREATED, not five
    }
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM "Legal_Drafts" WHERE "documentId" IN (SELECT "id" FROM "Legal_Documents" WHERE "slug" LIKE $1)`,
      [`e2e-${TAG}-%`],
    );
    expect(n).toBe(6);
  });

  it('AC1: a second run is a no-op (same rows, same timestamps, same floor)', async () => {
    const before = await sandboxState();
    const again = await svc().seedDrafts(sandboxTemplates);
    expect(again.every((r) => r.outcome === 'SKIPPED_HAS_DRAFT')).toBe(true);
    expect(await sandboxState()).toEqual(before);
  });

  it('AC8 of 19.2: the creation is audited in the same transaction as a system action (no admin)', async () => {
    const audits = await sql(
      `SELECT a."action"::text AS "action", a."adminUserId", a."adminEmail", a."meta", a."versionNumber"
       FROM "Legal_Audit_Logs" a JOIN "Legal_Documents" d ON d."id" = a."documentId"
       WHERE d."slug" LIKE $1`,
      [`e2e-${TAG}-%`],
    );
    expect(audits).toHaveLength(6);
    for (const a of audits) {
      expect(a.action).toBe('DRAFT_CREATED');
      expect(a.adminUserId).toBeNull();
      expect(a.adminEmail).toBeNull();
      expect(a.versionNumber).toBeNull();
      expect(a.meta).toMatchObject({ source: 'seed', revision: 1 });
      expect(JSON.stringify(a.meta)).not.toContain(HEADER); // never the body
    }
  });

  it('AC4: publishing a seeded draft as is answers 422 LEGAL_PLACEHOLDERS_PENDING', async () => {
    const slug = sbSlug('terminos');
    const res = await request(http())
      .post(`/api/v1/admin/legal/${slug}/publish`)
      .set({ Authorization: `Bearer ${token}` })
      .send({
        changeSummary: 'Publicar plantilla sembrada tal cual',
        isSubstantial: false,
        expectedRevision: 1,
        effectiveFrom: new Date(Date.now() + 60_000).toISOString(),
      })
      .expect(422);
    const body = res.body as {
      errorCode: string;
      details: { items: { token: string }[] };
    };
    expect(body.errorCode).toBe('LEGAL_PLACEHOLDERS_PENDING');
    const tokens = body.details.items.map((i) => i.token);
    expect(tokens).toEqual(
      expect.arrayContaining([
        '[[RAZON_SOCIAL]]',
        '[[RIF]]',
        '[[DOMICILIO_FISCAL]]',
      ]),
    );
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM "Legal_Document_Versions" WHERE "documentId" = $1::uuid`,
      [docs[slug].id],
    );
    expect(n).toBe(0);
  });

  it('AC5: with a seeded draft the public endpoint answers IN_PREPARATION and never the template', async () => {
    const res = await request(http())
      .get(`/api/v1/legal/${sbSlug('privacidad')}`)
      .expect(200);
    const b = res.body as { status: string; bodyMd?: unknown };
    expect(b.status).toBe('IN_PREPARATION');
    expect(b.bodyMd ?? null).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(HEADER);
  });

  it('AC5: no public response of the six real documents contains the template header', async () => {
    const urls = [
      '/api/v1/legal',
      '/api/v1/legal/current-versions',
      '/api/v1/legal/identity',
      ...LEGAL_SLUGS.map((s) => `/api/v1/legal/${s}`),
      ...LEGAL_SLUGS.map((s) => `/api/v1/legal/${s}/versions`),
    ];
    for (const u of urls) {
      const res = await request(http()).get(u);
      expect([u, res.status < 500]).toEqual([u, true]);
      expect([u, res.text.includes(HEADER)]).toEqual([u, false]);
    }
  });

  it('AC6: an edited draft is never overwritten and its revision is kept', async () => {
    const slug = sbSlug('cookies');
    const doc = docs[slug];
    await sql(
      `UPDATE "Legal_Drafts" SET "bodyMd" = $2, "revision" = "revision" + 4, "updatedByEmail" = 'editor@212collectorsclub.test' WHERE "documentId" = $1::uuid`,
      [doc.id, '## Editado por el admin\n\nTexto real.'],
    );
    const before = await sandboxState();
    const res = await svc().seedDrafts(sandboxTemplates);
    expect(res.find((r) => r.slug === slug)?.outcome).toBe('SKIPPED_HAS_DRAFT');
    expect(await sandboxState()).toEqual(before);
    const [row] = await sql(
      `SELECT "bodyMd", "revision" FROM "Legal_Drafts" WHERE "documentId" = $1::uuid`,
      [doc.id],
    );
    expect(row).toEqual({
      bodyMd: '## Editado por el admin\n\nTexto real.',
      revision: 5,
    });
  });

  it('AC1/AC6: a document with a published version gets no draft (and its versions stay untouched)', async () => {
    const extra = await createSandboxDocument(sql, `${TAG}-conversion`);
    await insertSandboxVersion(sql, extra.id, 1);
    const [{ h: hBefore }] = await sql(
      `SELECT md5(string_agg(to_jsonb(v)::text, '|')) AS h FROM "Legal_Document_Versions" v WHERE v."documentId" = $1::uuid`,
      [extra.id],
    );
    const [out] = await Promise.all([
      svc().seedDrafts([{ slug: extra.slug, bodyMd: real[0].bodyMd }]),
      svc().seedDrafts([{ slug: extra.slug, bodyMd: real[0].bodyMd }]),
    ]);
    expect(out[0].outcome).toBe('SKIPPED_HAS_VERSION');
    const [{ n }] = await sql(
      `SELECT count(*)::int AS n FROM "Legal_Drafts" WHERE "documentId" = $1::uuid`,
      [extra.id],
    );
    expect(n).toBe(0);
    const [{ h: hAfter }] = await sql(
      `SELECT md5(string_agg(to_jsonb(v)::text, '|')) AS h FROM "Legal_Document_Versions" v WHERE v."documentId" = $1::uuid`,
      [extra.id],
    );
    expect(hAfter).toBe(hBefore);
    const [{ a }] = await sql(
      `SELECT count(*)::int AS a FROM "Legal_Audit_Logs" WHERE "documentId" = $1::uuid`,
      [extra.id],
    );
    expect(a).toBe(0);
  });

  it('a discarded draft is re-seeded above the monotonic floor (revision = floor + 1), once', async () => {
    const slug = sbSlug('envios');
    const doc = docs[slug];
    await sql(`DELETE FROM "Legal_Drafts" WHERE "documentId" = $1::uuid`, [
      doc.id,
    ]);
    const [{ floor }] = await sql(
      `SELECT "draftRevisionFloor" AS floor FROM "Legal_Documents" WHERE "id" = $1::uuid`,
      [doc.id],
    );
    expect(floor).toBe(1);
    const runs = await Promise.all([
      svc().seedDrafts([sandboxTemplates.find((t) => t.slug === slug)!]),
      svc().seedDrafts([sandboxTemplates.find((t) => t.slug === slug)!]),
    ]);
    expect(
      runs
        .flat()
        .map((r) => r.outcome)
        .sort(),
    ).toEqual(['CREATED', 'SKIPPED_HAS_DRAFT']);
    const [row] = await sql(
      `SELECT dr."revision", d."draftRevisionFloor" AS floor FROM "Legal_Drafts" dr JOIN "Legal_Documents" d ON d."id" = dr."documentId" WHERE d."id" = $1::uuid`,
      [doc.id],
    );
    expect(row).toEqual({ revision: 2, floor: 1 });
  });

  it('an unknown slug is skipped without error', async () => {
    const [r] = await svc().seedDrafts([
      { slug: sbSlug('no-existe'), bodyMd: 'x' },
    ]);
    expect(r.outcome).toBe('SKIPPED_NO_DOCUMENT');
  });

  it('AC6: seeding the six REAL documents never overwrites or alters real drafts, versions, audit or floors', async () => {
    // Make sure every real document has a draft or a version, so nothing is created
    // (a creation would leave an undeletable audit row in a shared database).
    for (const slug of LEGAL_SLUGS) {
      const [d] = await sql(
        `SELECT d."id",
                EXISTS (SELECT 1 FROM "Legal_Drafts" WHERE "documentId" = d."id") AS "hasDraft",
                EXISTS (SELECT 1 FROM "Legal_Document_Versions" WHERE "documentId" = d."id") AS "hasVersion"
         FROM "Legal_Documents" d WHERE d."slug" = $1 AND NOT d."isSandbox"`,
        [slug],
      );
      if (!d.hasDraft && !d.hasVersion) {
        await insertSandboxDraft(
          sql,
          d.id as string,
          `## Borrador real editado\n\n${slug}`,
        );
      }
    }
    const before = await realLegalFingerprint(sql);
    const runs = await Promise.all(
      Array.from({ length: 5 }, () => svc().seedDrafts(real)),
    );
    for (const r of runs.flat()) {
      expect(['SKIPPED_HAS_DRAFT', 'SKIPPED_HAS_VERSION']).toContain(r.outcome);
    }
    expect(await realLegalFingerprint(sql)).toBe(before);
  });
});
