import { AuditService } from './../src/audit/audit.service.js';
import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { applyJsonBodyLimit } from './../src/common/json-body-limit.js';
import { ApiException } from './../src/common/api-exception.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import type { Prisma } from './../src/generated/prisma/client.js';
import { legalTx } from './../src/legal/legal-admin.common.js';
import { LegalAuditService } from './../src/legal/legal-audit.service.js';
import { LegalMarkdownService } from './../src/legal/legal-markdown.service.js';
import { PoolFailure } from './../src/legal/legal-markdown-pool.js';
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
 * Story 19.2 (FR-105..108, FR-111, AD-89..91): admin legal API against the real
 * database and the real HTTP stack. Everything that publishes uses SANDBOX
 * documents (`e2e-*`, created by SQL helpers and purged at the end). Versions and
 * audit rows of the six real documents are append-only and are never written:
 * the only real writes are drafts (snapshot/restore) and the identity
 * singleton, whose success path runs inside a transaction that is ALWAYS
 * rolled back (its audit row has no document, so it could never be purged).
 */
const TAG = randomUUID().slice(0, 8);
const USER = `e2e-admin-story-19-2-${TAG}`;
const EMAIL = `${USER}@212collectorsclub.test`;
const PASS = 'correct-horse-battery-staple-19-2';
const BASE = '/api/v1/admin/legal';
const ROLLBACK = new Error('rollback-sentinel');
const SIX = [
  'terminos',
  'privacidad',
  'cookies',
  'envios',
  'devoluciones',
  'aviso-legal',
];

interface Err {
  errorCode?: string;
  details?: Record<string, unknown>;
}
interface DraftBody {
  slug: string;
  bodyMd: string;
  revision: number;
  restoredFromVersion: number | null;
  placeholders: { token: string; line: number }[];
}
interface HistoryBody {
  versions: {
    versionNumber: number;
    publishedByEmail: string | null;
    restoredFromVersion: number | null;
    isScheduled: boolean;
    isCurrent: boolean;
    changeSummary: string;
  }[];
}
interface AuditBody {
  items: {
    action: string;
    slug: string | null;
    adminEmail: string | null;
    versionNumber: number | null;
    meta: Record<string, unknown>;
  }[];
}

describe('Legal admin API (e2e, Story 19.2)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let token: string;
  let adminId: string;
  let fingerprint: string;
  let saved: LegalRealSnapshot;
  const docs: Record<string, SandboxDoc> = {};
  let openapi: {
    paths: Record<
      string,
      Record<string, { responses: Record<string, { description?: string }> }>
    >;
  };

  const sql = (q: string, p: unknown[] = []) =>
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const get = (p: string) => request(http()).get(`${BASE}${p}`).set(auth());
  const put = (p: string, b: object) =>
    request(http()).put(`${BASE}${p}`).set(auth()).send(b);
  const post = (p: string, b: object = {}) =>
    request(http()).post(`${BASE}${p}`).set(auth()).send(b);
  const dbNow = async () => (await sql(`SELECT now() AS n`))[0].n as Date;
  /** ISO instant `ms` after the DATABASE clock. */
  const inMs = async (ms: number) =>
    new Date((await dbNow()).getTime() + ms).toISOString();
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const errOf = (res: { body: unknown }) => res.body as Err;
  const versionRows = (docId: string) =>
    sql(
      `SELECT md5(coalesce(string_agg(to_jsonb(v)::text, '|' ORDER BY v."versionNumber"), '')) AS h, count(*)::int AS n
       FROM "Legal_Document_Versions" v WHERE v."documentId" = $1::uuid`,
      [docId],
    );
  const auditOf = async (slug: string, limit = 200) =>
    (await get(`/audit?slug=${slug}&limit=${limit}`).expect(200))
      .body as AuditBody;
  const countAudit = async (docId: string, action: string) =>
    Number(
      (
        await sql(
          `SELECT count(*)::int AS n FROM "Legal_Audit_Logs" WHERE "documentId" = $1::uuid AND "action" = $2::"LegalAuditAction"`,
          [docId, action],
        )
      )[0].n,
    );

  /** Creates a draft over HTTP and returns its body. */
  const createDraft = async (slug: string, bodyMd: string) =>
    (await put(`/${slug}/draft`, { bodyMd, baseRevision: 0 }).expect(200))
      .body as DraftBody;
  /**
   * POST publish. Revisions are monotonic per document (QA F), so unless the
   * test passes `expectedRevision` the helper reads the draft's current one.
   */
  const publish = (slug: string, over: Record<string, unknown> = {}) => {
    const send = async () => {
      let expectedRevision = over.expectedRevision;
      if (expectedRevision === undefined) {
        const cur = await get(`/${slug}/draft`);
        expectedRevision =
          cur.status === 200 ? (cur.body as DraftBody).revision : 1;
      }
      return {
        t: post(`/${slug}/publish`, {
          changeSummary: 'Cambio de prueba e2e',
          isSubstantial: false,
          ...over,
          expectedRevision,
        }),
      };
    };
    return {
      expect: async (code: number) => (await send()).t.expect(code),
      then: (
        ok: (r: Awaited<ReturnType<typeof post>>) => unknown,
        bad?: (e: unknown) => unknown,
      ) => send().then(({ t }) => t.then(ok, bad), bad),
    };
  };

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
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('212CollectorsClub API').build(),
      ),
    );
    await app.init();
    prisma = app.get(PrismaService);

    await purgeSandbox(sql); // leftovers of an aborted run
    fingerprint = await realLegalFingerprint(sql);
    saved = await snapshotLegalReal(sql);

    const passwordHash = await argon2.hash(PASS, { type: argon2.argon2id });
    const admin = await prisma.adminUser.create({
      data: { username: USER, email: EMAIL, passwordHash },
    });
    adminId = admin.id;
    const login = await request(http())
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;

    for (const k of [
      'draft',
      'conc',
      'pub',
      'plh',
      'flow',
      'diff',
      'aud',
      'busy',
      'trg',
      'big',
      'aba',
    ]) {
      docs[k] = await createSandboxDocument(sql, `${TAG}-${k}`);
    }
    openapi = (await request(http()).get('/api/docs-json')).body as never;
  }, 60_000);

  afterAll(async () => {
    await purgeSandbox(sql, TAG);
    await restoreLegalReal(sql, saved);
    expect(await realLegalFingerprint(sql)).toBe(fingerprint);
    await prisma.adminUser.delete({ where: { id: adminId } }).catch(() => {});
    await app.close();
  });

  it('AC1: 401 without a token on every admin route', async () => {
    const s = 'terminos';
    const r = (m: 'get' | 'put' | 'post', p: string) =>
      request(http())[m](`${BASE}${p}`);
    for (const [m, p] of [
      ['get', ''],
      ['get', `/${s}/draft`],
      ['put', `/${s}/draft`],
      ['post', `/${s}/draft/discard`],
      ['post', `/${s}/publish`],
      ['post', `/${s}/restore`],
      ['get', `/${s}/history`],
      ['get', `/${s}/diff?from=1&to=2`],
      ['get', '/audit'],
      ['get', '/identity'],
      ['put', '/identity'],
    ] as const) {
      const res = await r(m, p).send({});
      expect([m, p, res.status]).toEqual([m, p, 401]);
    }
  });

  describe('AC1: GET /admin/legal', () => {
    it('lists the six real documents, with draft state and unresolved placeholders; sandbox documents are not listed', async () => {
      const res = await get('').expect(200);
      const list = res.body as {
        slug: string;
        hasDraft: boolean;
        pendingPlaceholders: number;
        currentVersion: number | null;
      }[];
      expect(list.map((d) => d.slug)).toEqual(SIX);
      // A draft of a real document written by SQL (no audit row, restored in afterAll).
      const [real] = await sql(
        `SELECT "id" FROM "Legal_Documents" WHERE "slug" = 'aviso-legal' AND NOT "isSandbox"`,
      );
      const before = (await snapshotLegalReal(sql)).drafts;
      await sql(`DELETE FROM "Legal_Drafts" WHERE "documentId" = $1::uuid`, [
        real.id,
      ]);
      await insertSandboxDraft(
        sql,
        real.id as string,
        '## A\n\n[[RAZON_SOCIAL]] y [[RIF]]',
      );
      try {
        const after = (await get('').expect(200)).body as typeof list;
        const aviso = after.find((d) => d.slug === 'aviso-legal');
        expect(aviso).toMatchObject({
          hasDraft: true,
          draftRevision: 1,
          pendingPlaceholders: 2,
        });
        expect(after.filter((d) => d.slug !== 'aviso-legal')).toEqual(
          list.filter((d) => d.slug !== 'aviso-legal'),
        );
      } finally {
        await restoreLegalReal(sql, { ...saved, drafts: before });
      }
    });

    it('the draft is not reachable through any public route', async () => {
      const marker = `PRIVATE-DRAFT-${TAG}`;
      await createDraft(docs.draft.slug, `## Privado\n\n${marker}`);
      for (const p of [
        `/api/v1/legal/${docs.draft.slug}`,
        `/api/v1/legal/${docs.draft.slug}/versions`,
        `/api/v1/legal/${docs.draft.slug}/versions/1`,
        '/api/v1/legal',
        '/api/v1/legal/current-versions',
      ]) {
        const res = await request(http()).get(p);
        expect(JSON.stringify(res.body)).not.toContain(marker);
      }
      await post(`/${docs.draft.slug}/draft/discard`).expect(204);
    });
  });

  describe('AC2: draft PUT/GET', () => {
    it('GET 404 LEGAL_DRAFT_NOT_FOUND, then create, then optimistic edits', async () => {
      const slug = docs.draft.slug;
      const r404 = await get(`/${slug}/draft`).expect(404);
      expect(errOf(r404).errorCode).toBe('LEGAL_DRAFT_NOT_FOUND');

      const created = await createDraft(slug, '## Uno\n\nTexto [[RIF]] aqui');
      // Revisions never restart for a document (QA F): relative from here on.
      const r1 = created.revision;
      expect(created).toMatchObject({ slug });
      expect(created.placeholders).toEqual([{ token: '[[RIF]]', line: 3 }]);

      // A second creation (baseRevision 0 over an existing draft) is stale.
      const dup = await put(`/${slug}/draft`, {
        bodyMd: '## Otro',
        baseRevision: 0,
      }).expect(409);
      expect(errOf(dup)).toMatchObject({
        errorCode: 'LEGAL_DRAFT_STALE',
        details: { currentRevision: r1 },
      });

      const edited = (
        await put(`/${slug}/draft`, {
          bodyMd: '## Uno\n\nTexto resuelto',
          baseRevision: r1,
        }).expect(200)
      ).body as DraftBody;
      expect(edited.revision).toBe(r1 + 1);
      expect(edited.placeholders).toEqual([]);

      const stale = await put(`/${slug}/draft`, {
        bodyMd: '## Viejo',
        baseRevision: r1,
      }).expect(409);
      expect(errOf(stale)).toMatchObject({
        errorCode: 'LEGAL_DRAFT_STALE',
        details: { currentRevision: r1 + 1 },
      });
      const read = (await get(`/${slug}/draft`).expect(200)).body as DraftBody;
      expect(read.bodyMd).toBe('## Uno\n\nTexto resuelto');
      expect(read.revision).toBe(r1 + 1);
    });

    it('400 on a bad body or forbidden Markdown, 404 on an unknown document, edit of a missing draft is 404', async () => {
      const slug = docs.draft.slug;
      const cur = ((await get(`/${slug}/draft`)).body as DraftBody).revision;
      await put(`/${slug}/draft`, { baseRevision: cur }).expect(400);
      await put(`/${slug}/draft`, { bodyMd: 'x', baseRevision: -1 }).expect(
        400,
      );
      await put(`/${slug}/draft`, { bodyMd: 'x', baseRevision: 1.5 }).expect(
        400,
      );
      await put(`/${slug}/draft`, {
        bodyMd: 'x',
        baseRevision: cur,
        extra: 1,
      }).expect(400);
      const html = await put(`/${slug}/draft`, {
        bodyMd: '## A\n\n<script>alert(1)</script>',
        baseRevision: cur,
      }).expect(400);
      expect(errOf(html).errorCode).toBe('LEGAL_MARKDOWN_INVALID');
      expect(
        (errOf(html).details as { issues: unknown[] }).issues.length,
      ).toBeGreaterThan(0);
      const big = await put(`/${slug}/draft`, {
        bodyMd: ('x'.repeat(99) + '\n').repeat(2100),
        baseRevision: cur,
      }).expect(400);
      expect(errOf(big).errorCode).toBe('LEGAL_MARKDOWN_INVALID');
      // The rejected edits changed nothing.
      expect(((await get(`/${slug}/draft`)).body as DraftBody).revision).toBe(
        cur,
      );

      await put('/nope/draft', { bodyMd: 'x', baseRevision: 0 }).expect(404);
      const ghost = await put(`/e2e-${TAG}-ghost/draft`, {
        bodyMd: 'x',
        baseRevision: 0,
      }).expect(404);
      expect(errOf(ghost).errorCode).toBe('LEGAL_DOCUMENT_NOT_FOUND');
      await get(`/e2e-${TAG}-ghost/draft`).expect(404);
      await post(`/${slug}/draft/discard`).expect(204);
      const gone = await put(`/${slug}/draft`, {
        bodyMd: 'x',
        baseRevision: 3,
      }).expect(404);
      expect(errOf(gone).errorCode).toBe('LEGAL_DRAFT_NOT_FOUND');
    });

    it('LEGAL_MARKDOWN_BUSY (503) from the validator is propagated, not turned into a 500', async () => {
      const md = app.get(LegalMarkdownService);
      const spy = vi
        .spyOn(md, 'validate')
        .mockRejectedValueOnce(
          new ApiException(503, 'LEGAL_MARKDOWN_BUSY', 'busy'),
        );
      const res = await put(`/${docs.draft.slug}/draft`, {
        bodyMd: '## x',
        baseRevision: 0,
      }).expect(503);
      expect(errOf(res).errorCode).toBe('LEGAL_MARKDOWN_BUSY');
      spy.mockRestore();
    });

    it('accepts a body of ~190 KB (A78) through the real parser limit', async () => {
      const body =
        'Linea de texto legal de prueba numero uno, con mas palabras para ocupar sitio.\n\n'.repeat(
          2300,
        );
      expect(Buffer.byteLength(body)).toBeGreaterThan(180_000);
      const t0 = performance.now();
      const d = await createDraft(docs.draft.slug, body);
      console.log(
        `[19.2 A78] ~190 KB draft through the real parser and the Markdown validator: ${(performance.now() - t0).toFixed(0)} ms`,
      );
      expect(d.revision).toBeGreaterThanOrEqual(1);
      await post(`/${docs.draft.slug}/draft/discard`).expect(204);
      // QA 20.5: this is correctness (the limit is accepted), not a time budget: it validates 190 KB
      // of Markdown in a worker, which under a loaded machine took longer than vitest's 5 s default.
      // The budgets live in `pnpm test:perf`.
    }, 60_000);
  });

  describe('AC3: concurrency over the real HTTP stack', () => {
    it('2 simultaneous PUT with the same baseRevision: exactly one 200 and one 409', async () => {
      const slug = docs.conc.slug;
      await createDraft(slug, '## Base');
      for (let round = 1; round <= 3; round++) {
        const rs = await Promise.all([
          put(`/${slug}/draft`, {
            bodyMd: `## A${round}`,
            baseRevision: round,
          }),
          put(`/${slug}/draft`, {
            bodyMd: `## B${round}`,
            baseRevision: round,
          }),
        ]);
        expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
        const loser = rs.find((r) => r.status === 409)!;
        expect(errOf(loser)).toMatchObject({
          errorCode: 'LEGAL_DRAFT_STALE',
          details: { currentRevision: round + 1 },
        });
      }
      await post(`/${slug}/draft/discard`).expect(204);
    });

    it('2 simultaneous creations: one 200, one 409 (never a 5xx or an uncaught P2002)', async () => {
      const slug = docs.conc.slug;
      const rs = await Promise.all([
        put(`/${slug}/draft`, { bodyMd: '## X', baseRevision: 0 }),
        put(`/${slug}/draft`, { bodyMd: '## Y', baseRevision: 0 }),
      ]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(errOf(rs.find((r) => r.status === 409)!).errorCode).toBe(
        'LEGAL_DRAFT_STALE',
      );
      expect(
        Number(
          (
            await sql(
              `SELECT count(*)::int AS n FROM "Legal_Drafts" WHERE "documentId" = $1::uuid`,
              [docs.conc.id],
            )
          )[0].n,
        ),
      ).toBe(1);
      await post(`/${slug}/draft/discard`).expect(204);
    });
  });

  describe('AC8: audit and coalescence', () => {
    it('DRAFT_EDITED is written once per 10-minute window per admin; created/discarded always', async () => {
      const slug = docs.aud.slug;
      const a0 = await createDraft(slug, '## a');
      for (let rev = a0.revision; rev < a0.revision + 4; rev++) {
        await put(`/${slug}/draft`, {
          bodyMd: `## a${rev}`,
          baseRevision: rev,
        }).expect(200);
      }
      expect(await countAudit(docs.aud.id, 'DRAFT_CREATED')).toBe(1);
      expect(await countAudit(docs.aud.id, 'DRAFT_EDITED')).toBe(1);
      await post(`/${slug}/draft/discard`).expect(204);
      expect(await countAudit(docs.aud.id, 'DRAFT_DISCARDED')).toBe(1);
      const b0 = await createDraft(slug, '## b');
      await put(`/${slug}/draft`, {
        bodyMd: '## b1',
        baseRevision: b0.revision,
      }).expect(200);
      expect(await countAudit(docs.aud.id, 'DRAFT_CREATED')).toBe(2);
      expect(await countAudit(docs.aud.id, 'DRAFT_EDITED')).toBe(1); // still the same window
      await post(`/${slug}/draft/discard`).expect(204);
    });

    it('rows carry the admin snapshot and a bounded meta without the body; rollback leaves no row', async () => {
      const slug = docs.aud.slug;
      const marker = `BODY-MARKER-${TAG}`;
      await createDraft(slug, `## m\n\n${marker}`);
      const audit = await auditOf(slug);
      const created = audit.items.find((i) => i.action === 'DRAFT_CREATED')!;
      expect(created.adminEmail).toBe(EMAIL);
      expect(created.slug).toBe(slug);
      expect(JSON.stringify(audit)).not.toContain(marker);
      await post(`/${slug}/draft/discard`).expect(204);

      // Rollback: the audit insert shares the transaction of the action.
      const audits = app.get(LegalAuditService);
      const before = await countAudit(docs.aud.id, 'RESTORED');
      await prisma
        .$transaction(async (tx) => {
          await audits.record(tx, {
            documentId: docs.aud.id,
            action: 'RESTORED',
            actor: { id: adminId, email: EMAIL },
            meta: { x: 1 },
          });
          const inside = await tx.legalAuditLog.count({
            where: { documentId: docs.aud.id, action: 'RESTORED' },
          });
          expect(inside).toBe(before + 1);
          throw ROLLBACK;
        })
        .catch((e: unknown) => {
          if (e !== ROLLBACK) throw e;
        });
      expect(await countAudit(docs.aud.id, 'RESTORED')).toBe(before);
      // An oversized meta is bounded instead of violating the DB CHECK.
      expect(
        Buffer.byteLength(
          JSON.stringify(
            LegalAuditService.boundMeta({
              a: 'x'.repeat(5000),
              b: 'y'.repeat(5000),
            }),
          ),
        ),
      ).toBeLessThanOrEqual(2048);
    });

    it('GET /admin/legal/audit: filter by slug, limit validation, 404 unknown slug', async () => {
      const slug = docs.aud.slug;
      const all = await auditOf(slug);
      expect(all.items.length).toBeGreaterThanOrEqual(4);
      expect(all.items.every((i) => i.slug === slug)).toBe(true);
      const two = (await get(`/audit?slug=${slug}&limit=2`).expect(200))
        .body as AuditBody;
      expect(two.items).toHaveLength(2);
      expect(two.items).toEqual(all.items.slice(0, 2)); // newest first
      for (const bad of ['0', '201', 'abc', '-1', '1.5', '']) {
        const res = await get(`/audit?limit=${bad}`).expect(400);
        expect(errOf(res).errorCode).toBe('LEGAL_AUDIT_LIMIT_INVALID');
      }
      await get('/audit?limit=200').expect(200);
      await get('/audit').expect(200);
      await get('/audit?slug=nope').expect(404);
      await get(`/audit?slug=e2e-${TAG}-ghost`).expect(404);
    });
  });

  describe('AC4/5: publish', () => {
    it('400 changeSummary, 400 effectiveFrom (past, infinite, far, malformed), 404 no draft, 409 stale, 422 placeholders; no version is created by any of them', async () => {
      const slug = docs.plh.slug;
      const none = await publish(slug, { effectiveFrom: await inMs(60_000) });
      expect(none.status).toBe(404);
      expect(errOf(none).errorCode).toBe('LEGAL_DRAFT_NOT_FOUND');

      await createDraft(
        slug,
        '## Datos\n\nRazon social: [[RAZON_SOCIAL]]\n\nRIF [[RIF]]',
      );
      const future = await inMs(60_000);
      await publish(slug, {
        effectiveFrom: future,
        changeSummary: 'corto',
      }).expect(400);
      await publish(slug, {
        effectiveFrom: future,
        changeSummary: '         x   ',
      }).expect(400);
      await publish(slug, {
        effectiveFrom: future,
        isSubstantial: 'yes',
      }).expect(400);
      await publish(slug, { effectiveFrom: future, extra: true }).expect(400);
      await publish(slug, { effectiveFrom: 'infinity' }).expect(400);
      await publish(slug, { effectiveFrom: 'not-a-date' }).expect(400);
      await publish(slug, { effectiveFrom: '2026-12-01' }).expect(400);
      await publish(slug, {}).expect(400); // no effectiveFrom
      const stale = await publish(slug, {
        effectiveFrom: future,
        expectedRevision: 7,
      }).expect(409);
      expect(errOf(stale)).toMatchObject({
        errorCode: 'LEGAL_DRAFT_STALE',
        details: { currentRevision: 1 },
      });
      const pending = await publish(slug, { effectiveFrom: future }).expect(
        422,
      );
      expect(errOf(pending).errorCode).toBe('LEGAL_PLACEHOLDERS_PENDING');
      expect(errOf(pending).details).toMatchObject({
        total: 2,
        items: [
          { token: '[[RAZON_SOCIAL]]', line: 3 },
          { token: '[[RIF]]', line: 5 },
        ],
      });
      expect((await versionRows(docs.plh.id))[0].n).toBe(0);

      // Resolve them and publish with a past / infinite-looking / too-far date.
      await put(`/${slug}/draft`, {
        bodyMd: '## Datos\n\nTodo resuelto',
        baseRevision: 1,
      }).expect(200);
      const past = await publish(slug, {
        expectedRevision: 2,
        effectiveFrom: await inMs(-60_000),
      }).expect(400);
      expect(errOf(past).errorCode).toBe('LEGAL_EFFECTIVE_FROM_INVALID');
      const far = await publish(slug, {
        expectedRevision: 2,
        effectiveFrom: await inMs(400 * 86_400_000),
      }).expect(400);
      expect(errOf(far).errorCode).toBe('LEGAL_EFFECTIVE_FROM_INVALID');
      expect((await versionRows(docs.plh.id))[0].n).toBe(0);
      expect(await countAudit(docs.plh.id, 'PUBLISHED')).toBe(0);
      // The draft survived every rejection.
      expect(((await get(`/${slug}/draft`)).body as DraftBody).revision).toBe(
        2,
      );
      await post(`/${slug}/draft/discard`).expect(204);
    });

    it('Story 19.3a: a residue of a marker or of the template notice never publishes (normalized text), a realistic text does', async () => {
      const slug = docs.plh.slug;
      const Z = '\u200B';
      const vectors = [
        '[[rif]]',
        '[[ RIF ]]',
        '[[RIF ]]',
        '[[RIF]',
        '[[Rif]]',
        '[[X]]',
        '[[1ABC]]',
        `[[${'A'.repeat(81)}]]`,
        'texto [[ suelto',
        '[[RAZON-SOCIAL]]',
        '[[RAZON.SOCIAL]]',
        '[[**RIF**]]',
        `[[R${Z}IF]]`,
        '[[\u00A0RIF\u00A0]]',
        '\uFF3B\uFF3BRIF\uFF3D\uFF3D',
        '[[RI\nF]]',
        '&#91;&#91;RIF]]',
        '\\[\\[RIF]]',
        'Plantilla -- revisar con un abogado antes de publicar',
        'Plantilla\u2014revisar con un abogado antes de publicar',
        `Plantilla \u2014${Z} revisar con un abogado antes de publicar`,
        'Plan\u00ADtilla \u2014 revisar con un abogado antes de publicar',
        'Plantilla &mdash; revisar con un abogado antes de publicar',
        'Plantilla &#8212; revisar con un abogado antes de publicar',
        '> Plantilla \u2014 revisar con un\n> abogado antes de publicar',
        'Plantilla [\u2014](https://e.test) revisar con un abogado antes de publicar',
        '| Plantilla \u2014 revisar | con un abogado |\n|---|---|\n| antes de | publicar |',
        'Pl\u0430ntilla \u2014 revisar con un abogado antes de publicar',
        'Plantilla \uFF0D revisar con un abogado antes de publicar',
      ];
      let rev = 0;
      for (const v of vectors) {
        const d = await createDraft(slug, `## Datos\n\n${v}\n`);
        rev = d.revision;
        const r = await publish(slug, { effectiveFrom: await inMs(60_000) });
        expect([v, r.status]).toEqual([v, 422]);
        expect(errOf(r).errorCode).toBe('LEGAL_PLACEHOLDERS_PENDING');
        const items = (errOf(r).details as { items: { line: number }[] }).items;
        expect(items.length).toBeGreaterThanOrEqual(1);
        expect(items[0].line).toBe(3);
        await post(`/${slug}/draft/discard`).expect(204);
      }
      expect(rev).toBeGreaterThan(0);
      expect((await versionRows(docs.plh.id))[0].n).toBe(0);

      // Harmless brackets and links, and "plantilla"/"abogado" alone, publish.
      await createDraft(
        slug,
        '## Aviso\n\nVer [1], [a][b] y [texto](https://e.test). Usamos una plantilla de correo; puedes revisar con un abogado tus derechos.\n\n[b]: https://e.test\n',
      );
      await publish(slug, { effectiveFrom: await inMs(60_000) }).expect(201);
    });

    it('publishes v1, v2 (v1 stays intact), monotonic effectiveFrom, history, audit and public reads', async () => {
      const slug = docs.pub.slug;
      const body1 = '## Alcance\n\nPrimera version del texto.\n';
      await createDraft(slug, body1);
      const eff1 = await inMs(1_200);
      const res1 = await publish(slug, {
        effectiveFrom: eff1,
        isSubstantial: true,
        changeSummary: '  Version inicial del documento  ',
      }).expect(201);
      expect(res1.body).toMatchObject({
        slug,
        versionNumber: 1,
        isSubstantial: true,
        changeSummary: 'Version inicial del documento',
        restoredFromVersion: null,
      });
      expect((await get(`/${slug}/draft`)).status).toBe(404); // draft deleted
      expect(await countAudit(docs.pub.id, 'PUBLISHED')).toBe(1);

      // v2 (draft with the same revision number 1 again: a NEW draft).
      const body2 = '## Alcance\n\nSegunda version del texto.\n';
      await createDraft(slug, body2);
      // Not before the effectiveFrom of v1 (monotonic), even though it is in the future.
      const earlier = await publish(slug, {
        effectiveFrom: new Date(new Date(eff1).getTime() - 500).toISOString(),
      }).expect(400);
      expect(errOf(earlier).errorCode).toBe('LEGAL_EFFECTIVE_FROM_INVALID');
      const eff2 = await inMs(3_000);
      const res2 = await publish(slug, { effectiveFrom: eff2 }).expect(201);
      expect(res2.body).toMatchObject({ versionNumber: 2 });

      // Public reads only see versions already in force (DB clock): poll.
      const publicGet = async (path: string, until: (b: never) => boolean) => {
        for (let i = 0; i < 40; i++) {
          const r = await request(http()).get(`/api/v1/legal/${path}`);
          if (r.status === 200 && until(r.body as never))
            return r.body as never;
          await sleep(250);
        }
        throw new Error(`public ${path} never reached the expected state`);
      };
      const pub1 = (await publicGet(`${slug}/versions/1`, () => true)) as {
        version: { bodyMd: string; isCurrent: boolean };
      };
      expect(pub1.version.bodyMd).toBe(body1);
      const cur = (await publicGet(
        slug,
        (b: { version?: { versionNumber: number } }) =>
          b.version?.versionNumber === 2,
      )) as { version: { versionNumber: number; bodyMd: string } };
      expect(cur.version.versionNumber).toBe(2);
      const pub1Again = (
        await request(http())
          .get(`/api/v1/legal/${slug}/versions/1`)
          .expect(200)
      ).body as { version: { bodyMd: string } };
      expect(pub1Again.version.bodyMd).toBe(body1); // v1 intact after v2

      const hist = (await get(`/${slug}/history`).expect(200))
        .body as HistoryBody;
      expect(hist.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
      expect(hist.versions[0]).toMatchObject({
        publishedByEmail: EMAIL,
        isCurrent: true,
        isScheduled: false,
        restoredFromVersion: null,
      });

      const audit = await auditOf(slug);
      const pubs = audit.items.filter((i) => i.action === 'PUBLISHED');
      expect(pubs.map((p) => p.versionNumber).sort()).toEqual([1, 2]);
      // Both drafts are the first of their kind here, but the second one can
      // never reuse the first one's number (QA F).
      const revs = pubs
        .sort((a, b) => a.versionNumber! - b.versionNumber!)
        .map((p) => p.meta.draftRevision as number);
      expect(revs[0]).toBe(1);
      expect(revs[1]).toBeGreaterThan(revs[0]);
      expect(Buffer.byteLength(JSON.stringify(pubs[0].meta))).toBeLessThan(
        2048,
      );

      // Scheduled version: effectiveFrom far in the future, then monotonic.
      await createDraft(slug, '## Alcance\n\nTercera, programada.\n');
      const far = await inMs(10 * 86_400_000);
      await publish(slug, { effectiveFrom: far }).expect(201);
      await createDraft(slug, '## Alcance\n\nCuarta.\n');
      const lower = await inMs(5 * 86_400_000);
      const m = await publish(slug, { effectiveFrom: lower }).expect(400);
      expect(errOf(m).errorCode).toBe('LEGAL_EFFECTIVE_FROM_INVALID');
      expect(errOf(m).details).toHaveProperty('minEffectiveFrom');
      await publish(slug, { effectiveFrom: far }).expect(201); // equal is allowed
      const hist2 = (await get(`/${slug}/history`)).body as HistoryBody;
      expect(
        hist2.versions.map((v) => [v.versionNumber, v.isScheduled]),
      ).toEqual([
        [4, true],
        [3, true],
        [2, false],
        [1, false],
      ]);
      expect(hist2.versions.find((v) => v.isCurrent)?.versionNumber).toBe(2);
    });

    it('5 simultaneous publishes of the same document: consecutive versions, no 5xx, one PUBLISHED row per version', async () => {
      const slug = docs.flow.slug;
      const c1 = await createDraft(slug, '## Carrera\n\nTexto.\n');
      const eff = await inMs(2_000);
      const rs = await Promise.all(
        Array.from({ length: 5 }, () =>
          publish(slug, { effectiveFrom: eff, expectedRevision: c1.revision }),
        ),
      );
      const statuses = rs.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.every((s) => [201, 404, 409, 422].includes(s))).toBe(
        true,
      );
      const v = await sql(
        `SELECT "versionNumber" FROM "Legal_Document_Versions" WHERE "documentId" = $1::uuid ORDER BY 1`,
        [docs.flow.id],
      );
      expect(v.map((r) => r.versionNumber)).toEqual([1]);
      expect(await countAudit(docs.flow.id, 'PUBLISHED')).toBe(1);

      // Second round: 5 racers with a fresh draft each time, 3 rounds back to back.
      for (let round = 2; round <= 4; round++) {
        const cr = await createDraft(slug, `## Carrera ${round}\n\nTexto.\n`);
        const rr = await Promise.all(
          Array.from({ length: 5 }, () =>
            publish(slug, {
              effectiveFrom: eff,
              expectedRevision: cr.revision,
            }),
          ),
        );
        expect(rr.filter((r) => r.status === 201)).toHaveLength(1);
        expect(rr.every((r) => r.status < 500)).toBe(true);
      }
      const all = await sql(
        `SELECT "versionNumber" FROM "Legal_Document_Versions" WHERE "documentId" = $1::uuid ORDER BY 1`,
        [docs.flow.id],
      );
      expect(all.map((r) => r.versionNumber)).toEqual([1, 2, 3, 4]);
      expect(await countAudit(docs.flow.id, 'PUBLISHED')).toBe(4);
    });

    it('a publish racing an edit of the same draft never publishes unvalidated text', async () => {
      const slug = docs.busy.slug;
      const base = '## Carrera\n\nTexto base.\n';
      const eff = await inMs(60_000);
      const seen: number[][] = [];
      for (let round = 0; round < 4; round++) {
        await sql(`DELETE FROM "Legal_Drafts" WHERE "documentId" = $1::uuid`, [
          docs.busy.id,
        ]);
        const d0 = await createDraft(slug, base);
        const [p, e] = await Promise.all([
          publish(slug, {
            expectedRevision: d0.revision,
            effectiveFrom: eff,
          }),
          put(`/${slug}/draft`, {
            bodyMd: `## Editado ${round}`,
            baseRevision: d0.revision,
          }),
        ]);
        seen.push([p.status, e.status]);
        expect([201, 409, 404]).toContain(p.status);
        expect([200, 404, 409]).toContain(e.status);
      }
      const rows = await sql(
        `SELECT "bodyMd" FROM "Legal_Document_Versions" WHERE "documentId" = $1::uuid`,
        [docs.busy.id],
      );
      // Only the text that was validated at revision 1 can ever be published.
      for (const r of rows) expect(r.bodyMd).toBe(base);
      expect(seen.length).toBe(4);
    });

    it('a rejected version INSERT (database guard) becomes a retryable 409, never a 500', async () => {
      await expect(
        legalTx(new AuditService(prisma), (tx) =>
          tx.$executeRawUnsafe(
            `INSERT INTO "Legal_Document_Versions" ("id","documentId","versionNumber","bodyMd","changeSummary","isSubstantial","effectiveFrom")
             VALUES (gen_random_uuid(), $1::uuid, 9, 'x', 'resumen', false, now())`,
            docs.trg.id,
          ),
        ),
      ).rejects.toMatchObject({
        constructor: ApiException,
        status: 409,
        response: { errorCode: 'LEGAL_VERSION_CONFLICT' },
      });
      // Unique key violation as well (P2002 path).
      await sql(
        `INSERT INTO "Legal_Document_Versions" ("id","documentId","versionNumber","bodyMd","changeSummary","isSubstantial","effectiveFrom")
         VALUES (gen_random_uuid(), $1::uuid, 1, 'x', 'resumen', false, now())`,
        [docs.trg.id],
      );
      await expect(
        legalTx(new AuditService(prisma), (tx) =>
          tx.legalDocumentVersion.create({
            data: {
              documentId: docs.trg.id,
              versionNumber: 1,
              bodyMd: 'y',
              changeSummary: 'resumen',
              isSubstantial: false,
              effectiveFrom: new Date(),
            },
          }),
        ),
      ).rejects.toMatchObject({
        response: { errorCode: 'LEGAL_VERSION_CONFLICT' },
      });
    });

    it('database guard (migration 20261102300000): infinite and out-of-order effectiveFrom are rejected; a real document cannot be back-dated', async () => {
      const ins = (
        c: {
          $executeRawUnsafe: (q: string, ...p: unknown[]) => Promise<number>;
        },
        docId: string,
        n: number,
        eff: string,
      ) =>
        c.$executeRawUnsafe(
          `INSERT INTO "Legal_Document_Versions" ("id","documentId","versionNumber","bodyMd","changeSummary","isSubstantial","effectiveFrom")
           VALUES (gen_random_uuid(), $1::uuid, $2, 'x', 'resumen', false, ${eff})`,
          docId,
          n,
        );
      // trg already holds v1 (effective now()) from the previous test.
      await expect(
        ins(prisma, docs.trg.id, 2, `'infinity'::timestamptz`),
      ).rejects.toThrow();
      await expect(
        ins(prisma, docs.trg.id, 2, `'-infinity'::timestamptz`),
      ).rejects.toThrow();
      await expect(
        ins(prisma, docs.trg.id, 2, `now() - interval '2 days'`),
      ).rejects.toThrow(); // before v1
      await ins(prisma, docs.trg.id, 2, `now() + interval '1 day'`);

      // REAL document: only inside a transaction that is always rolled back.
      const outcome: Record<string, string> = {};
      await prisma
        .$transaction(async (tx) => {
          const [real] = await tx.$queryRawUnsafe<{ id: string }[]>(
            `SELECT "id" FROM "Legal_Documents" WHERE "slug" = 'envios' AND NOT "isSandbox"`,
          );
          for (const [name, n, eff] of [
            ['past', 1, `now() - interval '1 day'`],
            ['infinity', 1, `'infinity'::timestamptz`],
          ] as const) {
            await tx.$executeRawUnsafe('SAVEPOINT a');
            try {
              await ins(tx, real.id, n, eff);
              outcome[name] = 'SUCCEEDED';
            } catch {
              outcome[name] = 'REJECTED';
            }
            await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT a');
          }
          await ins(tx, real.id, 1, 'now()');
          outcome.now = 'SUCCEEDED';
          throw ROLLBACK;
        })
        .catch((e: unknown) => {
          if (e !== ROLLBACK) throw e;
        });
      expect(outcome).toEqual({
        past: 'REJECTED',
        infinity: 'REJECTED',
        now: 'SUCCEEDED',
      });
    });
  });

  describe('AC6/7: restore, history, diff', () => {
    it('restore creates a draft with restoredFromVersion and never touches the history; discard too', async () => {
      const slug = docs.diff.slug;
      const bodies = [
        '## Titulo\n\nlinea 1\nlinea 2\nlinea 3\nlinea 4\nlinea 5\nlinea 6\nlinea 7\nlinea 8\nlinea 9\n',
        '## Titulo\n\nlinea 1\nlinea 2\nlinea 3 CAMBIADA\nlinea 4\nlinea 5\nlinea 6\nlinea 7\nlinea 8\nlinea 9\nlinea 10 NUEVA\n',
      ];
      for (const b of bodies) {
        await createDraft(slug, b);
        await publish(slug, { effectiveFrom: await inMs(1_000) }).expect(201);
      }
      const before = await versionRows(docs.diff.id);

      const bad = await post(`/${slug}/restore`, { version: 0 }).expect(400);
      expect(errOf(bad).errorCode ?? 'validation').toBeDefined();
      await post(`/${slug}/restore`, {}).expect(400);
      await post(`/${slug}/restore`, { version: 1, extra: 1 }).expect(400);
      const nf = await post(`/${slug}/restore`, { version: 9 }).expect(404);
      expect(errOf(nf).errorCode).toBe('LEGAL_VERSION_NOT_FOUND');
      await post('/nope/restore', { version: 1 }).expect(404);

      const restored = (
        await post(`/${slug}/restore`, { version: 1 }).expect(201)
      ).body as DraftBody;
      expect(restored).toMatchObject({ restoredFromVersion: 1 });
      expect(restored.bodyMd).toBe(bodies[0]);
      const exists = await post(`/${slug}/restore`, { version: 2 }).expect(409);
      expect(errOf(exists).errorCode).toBe('LEGAL_DRAFT_EXISTS');
      expect(await countAudit(docs.diff.id, 'RESTORED')).toBe(1);
      const aud = (await auditOf(slug)).items.find(
        (i) => i.action === 'RESTORED',
      )!;
      expect(aud).toMatchObject({ versionNumber: 1, adminEmail: EMAIL });

      // Edits keep restoredFromVersion; publishing records it on the version.
      await put(`/${slug}/draft`, {
        bodyMd: bodies[0] + 'linea restaurada y editada\n',
        baseRevision: restored.revision,
      }).expect(200);
      expect(
        ((await get(`/${slug}/draft`)).body as DraftBody).restoredFromVersion,
      ).toBe(1);
      await post(`/${slug}/draft/discard`).expect(204);
      expect(await countAudit(docs.diff.id, 'DRAFT_DISCARDED')).toBe(1);
      await post(`/${slug}/draft/discard`).expect(404);
      expect(await versionRows(docs.diff.id)).toEqual(before); // history byte-identical

      await post(`/${slug}/restore`, { version: 1 }).expect(201);
      const rev = await publish(slug, {
        effectiveFrom: await inMs(1_000),
        changeSummary: 'Restauracion de la version 1',
      }).expect(201);
      expect(rev.body).toMatchObject({
        versionNumber: 3,
        restoredFromVersion: 1,
      });
      const hist = (await get(`/${slug}/history`)).body as HistoryBody;
      expect(hist.versions[0]).toMatchObject({
        versionNumber: 3,
        restoredFromVersion: 1,
        changeSummary: 'Restauracion de la version 1',
      });
    });

    it('diff N -> N+1 has exactly the changed lines with 3 lines of context; read only; 404/400', async () => {
      const slug = docs.diff.slug;
      const d = (await get(`/${slug}/diff?from=1&to=2`).expect(200)).body as {
        from: number;
        to: number;
        stats: { added: number; removed: number };
        hunks: {
          type: string;
          lines: string[];
          oldStart: number;
          newStart: number;
        }[];
      };
      expect(d).toMatchObject({
        from: 1,
        to: 2,
        stats: { added: 2, removed: 1 },
      });
      const changed = d.hunks.filter((h) => h.type !== 'context');
      expect(changed).toEqual([
        { type: 'removed', lines: ['linea 3'], oldStart: 5, newStart: 5 },
        {
          type: 'added',
          lines: ['linea 3 CAMBIADA'],
          oldStart: 6,
          newStart: 5,
        },
        {
          type: 'added',
          lines: ['linea 10 NUEVA'],
          oldStart: 12,
          newStart: 12,
        },
      ]);
      const ctx = d.hunks.filter((h) => h.type === 'context');
      // Edges keep 3 lines; an inner stretch up to 6 (3 + 3) is kept whole.
      expect(ctx.every((h) => h.lines.length <= 6)).toBe(true);
      expect(d.hunks[0].lines.length).toBeLessThanOrEqual(3);
      // Leading context is the 3 lines before the first change.
      expect(d.hunks[0]).toEqual({
        type: 'context',
        lines: ['', 'linea 1', 'linea 2'],
        oldStart: 2,
        newStart: 2,
      });
      const same = (await get(`/${slug}/diff?from=2&to=2`).expect(200))
        .body as {
        hunks: unknown[];
        stats: unknown;
      };
      expect(same).toMatchObject({
        hunks: [],
        stats: { added: 0, removed: 0 },
      });

      const nf = await get(`/${slug}/diff?from=1&to=99`).expect(404);
      expect(errOf(nf).errorCode).toBe('LEGAL_VERSION_NOT_FOUND');
      await get(`/${slug}/diff?from=a&to=2`).expect(400);
      await get(`/${slug}/diff?from=1`).expect(400);
      await get(`/${slug}/diff?from=0&to=1`).expect(400);
      await get(`/${slug}/diff?from=1&to=2;DROP`).expect(400);
      await get('/nope/diff?from=1&to=2').expect(404);
      await get('/nope/history').expect(404);
    });
  });

  describe('AC9: identity', () => {
    it('400 on invalid RIF / email / lengths / unknown properties', async () => {
      for (const body of [
        { rif: 'X-123' },
        { rif: 'J-1234567' },
        { rif: 'J-12345678-99' },
        { contactEmail: 'no-es-correo' },
        { legalName: 'a'.repeat(201) },
        { fiscalAddress: 'a'.repeat(501) },
        { phone: 'a'.repeat(41) },
        { rif: 12345 },
        { unknown: 'x' },
      ]) {
        const res = await put('/identity', body);
        expect([JSON.stringify(body), res.status]).toEqual([
          JSON.stringify(body),
          400,
        ]);
      }
    });

    it('GET shape; PUT updates only the present fields and audits the changed field names (rolled back here: the audit row has no document)', async () => {
      const g = (await get('/identity').expect(200)).body as Record<
        string,
        unknown
      >;
      expect(Object.keys(g).sort()).toEqual(
        [
          'complete',
          'contactEmail',
          'fiscalAddress',
          'legalName',
          'missing',
          'phone',
          'rif',
        ].sort(),
      );
      const original = await sql(
        `SELECT to_jsonb(s)::text AS j FROM "Seller_Identity_Settings" s WHERE "id" = 'default'`,
      );

      // Run the HTTP call inside a transaction that is always rolled back.
      const observed: Record<string, unknown>[] = [];
      const orig = prisma.$transaction.bind(prisma) as (
        fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
        o?: object,
      ) => Promise<unknown>;
      const spy = vi
        .spyOn(prisma, '$transaction')
        .mockImplementation(
          (
            fn: (tx: Prisma.TransactionClient) => Promise<unknown>,
            o?: object,
          ) => {
            let result: unknown;
            return orig(async (tx) => {
              result = await fn(tx);
              observed.push(
                ...(await tx.$queryRawUnsafe<Record<string, unknown>[]>(
                  `SELECT "action"::text AS "action", "documentId", "meta", "adminEmail"
                 FROM "Legal_Audit_Logs" WHERE "documentId" IS NULL AND "adminUserId" = $1::uuid`,
                  adminId,
                )),
                ...(await tx.$queryRawUnsafe<Record<string, unknown>[]>(
                  `SELECT "legalName", "rif", "contactEmail", "updatedById" FROM "Seller_Identity_Settings" WHERE "id" = 'default'`,
                )),
              );
              throw ROLLBACK;
            }, o).catch((e: unknown) => {
              if (e === ROLLBACK) return result;
              throw e;
            });
          },
        );
      try {
        const res = await put('/identity', {
          legalName: '  212 Collectors Club C.A.  ',
          rif: 'j-12345678-9',
          contactEmail: 'ventas@212collectorsclub.test',
        }).expect(200);
        expect(res.body).toMatchObject({
          legalName: '212 Collectors Club C.A.',
          rif: 'j-12345678-9',
          complete: true,
          missing: [],
        });
      } finally {
        spy.mockRestore();
      }
      expect(observed[0]).toMatchObject({
        action: 'IDENTITY_UPDATED',
        documentId: null,
        adminEmail: EMAIL,
        meta: { changedFields: ['legalName', 'rif', 'contactEmail'] },
      });
      expect(JSON.stringify(observed[0].meta)).not.toContain('12345678');
      expect(observed[1]).toMatchObject({
        legalName: '212 Collectors Club C.A.',
        updatedById: adminId,
      });
      // Nothing persisted.
      expect(
        await sql(
          `SELECT to_jsonb(s)::text AS j FROM "Seller_Identity_Settings" s WHERE "id" = 'default'`,
        ),
      ).toEqual(original);
      expect(
        Number(
          (
            await sql(
              `SELECT count(*)::int AS n FROM "Legal_Audit_Logs" WHERE "documentId" IS NULL AND "adminUserId" = $1::uuid`,
              [adminId],
            )
          )[0].n,
        ),
      ).toBe(0);
    });
  });

  describe('Swagger (/api/docs-json)', () => {
    it('documents every admin endpoint with its errorCodes', () => {
      const P = '/api/v1/admin/legal';
      const expectIn = (
        path: string,
        method: string,
        status: string,
        text: string,
      ) =>
        expect(
          openapi.paths[`${P}${path}`]?.[method]?.responses?.[status]
            ?.description,
        ).toContain(text);
      expect(openapi.paths[P]?.get).toBeDefined();
      expectIn('/audit', 'get', '400', 'LEGAL_AUDIT_LIMIT_INVALID');
      expect(openapi.paths[`${P}/identity`]?.get).toBeDefined();
      expect(openapi.paths[`${P}/identity`]?.put).toBeDefined();
      expectIn('/{slug}/draft', 'get', '404', 'LEGAL_DRAFT_NOT_FOUND');
      expectIn('/{slug}/draft', 'put', '409', 'LEGAL_DRAFT_STALE');
      expectIn('/{slug}/draft', 'put', '400', 'LEGAL_MARKDOWN_INVALID');
      expectIn('/{slug}/draft', 'put', '503', 'LEGAL_MARKDOWN_BUSY');
      expectIn('/{slug}/draft/discard', 'post', '404', 'LEGAL_DRAFT_NOT_FOUND');
      expectIn(
        '/{slug}/publish',
        'post',
        '400',
        'LEGAL_EFFECTIVE_FROM_INVALID',
      );
      expectIn('/{slug}/publish', 'post', '409', 'LEGAL_DRAFT_STALE');
      expectIn('/{slug}/publish', 'post', '422', 'LEGAL_PLACEHOLDERS_PENDING');
      expectIn('/{slug}/restore', 'post', '409', 'LEGAL_DRAFT_EXISTS');
      expectIn('/{slug}/history', 'get', '404', 'LEGAL_DOCUMENT_NOT_FOUND');
      expectIn('/{slug}/diff', 'get', '404', 'LEGAL_VERSION_NOT_FOUND');
      expectIn('/{slug}/diff', 'get', '422', 'LEGAL_DIFF_TOO_LARGE');
      expectIn('/{slug}/diff', 'get', '503', 'LEGAL_MARKDOWN_BUSY');
      for (const [path, ops] of Object.entries(openapi.paths)) {
        if (!path.startsWith(P)) continue;
        for (const op of Object.values(ops)) {
          expect(op.responses['401']?.description).toBe('INVALID_ADMIN_TOKEN');
        }
      }
    });
  });
  describe('QA 19.2 D1: the diff never blocks the event loop; errors are 422/503', () => {
    // 5990 lines of 33 characters, one blank every 900, every other line different.
    const vector = (seed: string) => {
      const out: string[] = [];
      for (let i = 0; out.length < 5990; i++) {
        out.push(
          i % 900 === 899
            ? ''
            : `${seed}${i} lorem ipsum dolor sit amet`.slice(0, 33),
        );
      }
      return out.join('\n');
    };

    it('two ~196 KB versions: the diff is complete and the event loop (same process as the server) is never held', async () => {
      const slug = docs.big.slug;
      await insertSandboxVersion(sql, docs.big.id, 1, {
        bodyMd: vector('a'),
      });
      await insertSandboxVersion(sql, docs.big.id, 2, {
        bodyMd: vector('b'),
      });
      let last = performance.now();
      let maxDelay = 0;
      const iv = setInterval(() => {
        const now = performance.now();
        maxDelay = Math.max(maxDelay, now - last - 10);
        last = now;
      }, 10);
      const t = performance.now();
      const res = await get(`/${slug}/diff?from=1&to=2`).expect(200);
      const ms = performance.now() - t;
      clearInterval(iv);
      const body = res.body as {
        stats: { added: number; removed: number };
        hunks: unknown[];
      };
      console.log(
        `[19.2 D1 e2e] diff 196 KB x2: ${ms.toFixed(0)} ms, response ${JSON.stringify(body).length} bytes, max event-loop delay ${maxDelay.toFixed(1)} ms`,
      );
      expect(body.stats).toEqual({ added: 5984, removed: 5984 });
      expect(maxDelay).toBeLessThan(250);
    });

    it('a diff past its deadline is 422 LEGAL_DIFF_TOO_LARGE and a saturated pool is 503 LEGAL_MARKDOWN_BUSY, never 500', async () => {
      const md = app.get(LegalMarkdownService);
      const slug = docs.big.slug;
      const spy = vi.spyOn(md, 'diff');
      spy.mockRejectedValueOnce(new PoolFailure('TIMEOUT'));
      const r422 = await get(`/${slug}/diff?from=1&to=2`).expect(422);
      expect(errOf(r422).errorCode).toBe('LEGAL_DIFF_TOO_LARGE');
      spy.mockRejectedValueOnce(new PoolFailure('FAILED', 'oom'));
      await get(`/${slug}/diff?from=1&to=2`).expect(422);
      spy.mockRejectedValueOnce(new PoolFailure('BUSY'));
      const r503 = await get(`/${slug}/diff?from=1&to=2`).expect(503);
      expect(errOf(r503).errorCode).toBe('LEGAL_MARKDOWN_BUSY');
      spy.mockRestore();
    });
  });

  describe('QA 19.2 E: JSON body limit is 100 KB except the legal draft route', () => {
    const big = (kb: number) => 'x'.repeat(kb * 1024);

    it('150 KB to public/anonymous routes is 413 before any guard or throttler', async () => {
      const payload = { name: 'a', email: 'a@b.co', message: big(150) };
      await request(http()).post('/api/v1/contact').send(payload).expect(413);
      await request(http())
        .post('/api/v1/cart/items')
        .send({ productId: 'x', quantity: 1, pad: big(150) })
        .expect(413);
      await request(http())
        .post('/api/v1/admin/auth/login')
        .send({ usernameOrEmail: 'a', password: big(150) })
        .expect(413);
    });

    it('the 400 KB parser applies only to PUT /admin/legal/:slug/draft with a Bearer header', async () => {
      const slug = docs.big.slug;
      const body = { bodyMd: big(150), baseRevision: 0 };
      // Anonymous: keeps the 100 KB parser.
      await request(http()).put(`${BASE}/${slug}/draft`).send(body).expect(413);
      // Authenticated but another admin legal route: 413 as well.
      await post(`/${slug}/publish`, {
        expectedRevision: 1,
        changeSummary: big(150),
      }).expect(413);
      await request(http())
        .put(`${BASE}/identity`)
        .set(auth())
        .send({ legalName: big(150) })
        .expect(413);
      // Look-alike paths do not get it either.
      await request(http())
        .put(`${BASE}/${slug}/draft/x`)
        .set(auth())
        .send(body)
        .expect(413);
      await request(http())
        .put(`/api/v1/admin/other/${slug}/draft`)
        .set(auth())
        .send(body)
        .expect(413);
      await request(http())
        .put(`${BASE}/${slug}/draft`)
        .set(auth())
        .send({ ...body, bodyMd: big(401) })
        .expect(413);
    });

    it('190 KB to PUT /admin/legal/:slug/draft with a token still works', async () => {
      const slug = docs.big.slug;
      const bodyMd =
        'Linea de texto legal de prueba numero uno, con mas palabras para ocupar sitio.\n\n'.repeat(
          2400,
        );
      expect(Buffer.byteLength(bodyMd)).toBeGreaterThan(190_000);
      const d = await createDraft(slug, bodyMd);
      expect(d.revision).toBeGreaterThanOrEqual(1);
      await post(`/${slug}/draft/discard`).expect(204);
    }, 60_000); // correctness, not a budget: see the ~190 KB test of AC2
  });

  describe('QA 19.2 F: draft revision is monotonic per document (no ABA)', () => {
    it('create, discard, create another text: a publish with the old revision is 409 and the new draft is never published by it', async () => {
      const slug = docs.aba.slug;
      const first = await createDraft(slug, '## Texto A\n\nPrimero.');
      expect(first.revision).toBe(1); // first draft of a document keeps starting at 1
      await post(`/${slug}/draft/discard`).expect(204);
      const second = await createDraft(slug, '## Texto B\n\nOtro texto.');
      expect(second.revision).toBeGreaterThan(first.revision);
      const res = await publish(slug, {
        expectedRevision: first.revision,
        effectiveFrom: await inMs(1_000),
      }).expect(409);
      expect(errOf(res).errorCode).toBe('LEGAL_DRAFT_STALE');
      expect(res.body).toMatchObject({
        details: { currentRevision: second.revision },
      });
      expect((await versionRows(docs.aba.id))[0].n).toBe(0);
      // Edits keep climbing; discard + restore also continues the sequence.
      const edited = (
        await put(`/${slug}/draft`, {
          bodyMd: '## Texto B2',
          baseRevision: second.revision,
        }).expect(200)
      ).body as DraftBody;
      expect(edited.revision).toBe(second.revision + 1);
      await post(`/${slug}/draft/discard`).expect(204);
      const third = await createDraft(slug, '## Texto C');
      expect(third.revision).toBe(edited.revision + 1);
      // Publishing the draft also consumes its number: the next one is above it.
      await publish(slug, {
        expectedRevision: third.revision,
        effectiveFrom: await inMs(1_000),
      }).expect(201);
      const fourth = await createDraft(slug, '## Texto D');
      expect(fourth.revision).toBe(third.revision + 1);
      await post(`/${slug}/draft/discard`).expect(204);
    });
  });
});
