import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  createSandboxDocument,
  insertSandboxAudit,
  insertSandboxDraft,
  insertSandboxVersion,
  purgeSandbox,
  realLegalFingerprint,
  restoreLegalReal,
  snapshotLegalReal,
  type LegalRealSnapshot,
  type SandboxDoc,
} from './helpers/legal-sandbox.js';

/**
 * Story 19.1 (AC6-8, FR-102/103, A65): public legal API against the real DB.
 * Scenarios use sandbox documents (`e2e-*`, SQL only); the six real rows are
 * fingerprinted before/after and the two real tables a test may touch
 * (drafts of real documents, identity) are snapshotted and restored.
 */
const TAG = randomUUID().slice(0, 8);
const MARKER = `DRAFT-MARKER-${TAG}-NEVER-PUBLIC`;
const AUTHOR = 'author-secret@212collectorsclub.test';
const SIX = [
  'terminos',
  'privacidad',
  'cookies',
  'envios',
  'devoluciones',
  'aviso-legal',
];

describe('Legal public API (e2e, Story 19.1)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let fingerprint: string;
  let saved: LegalRealSnapshot;
  const docs: Record<string, SandboxDoc> = {};
  let openapi: {
    paths: Record<
      string,
      Record<string, { responses: Record<string, unknown> }>
    >;
  };

  const sql = (q: string, p: unknown[] = []) =>
    prisma.$queryRawUnsafe<Record<string, unknown>[]>(q, ...p);
  const http = () => app.getHttpServer() as Parameters<typeof request>[0];
  const get = (p: string) => request(http()).get(`/api/v1/legal${p}`);

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

    // empty: no versions at all
    docs.empty = await createSandboxDocument(sql, `${TAG}-empty`);
    // current v2 (v1 superseded), v3 in the future (upcoming), v4 further out
    docs.multi = await createSandboxDocument(sql, `${TAG}-multi`, {
      kind: 'PRIVACY',
    });
    await insertSandboxVersion(sql, docs.multi.id, 1, {
      effectiveFrom: '-30 days',
      bodyMd: '## Alcance\n\nTexto v1 [uno](https://example.com)',
      isSubstantial: true,
    });
    await insertSandboxVersion(sql, docs.multi.id, 2, {
      effectiveFrom: '-1 day',
      bodyMd: '## Datos\n\n### Datos\n\n## Datos\n\nTexto v2',
      isSubstantial: false,
    });
    await insertSandboxVersion(sql, docs.multi.id, 3, {
      effectiveFrom: '+2 days',
      bodyMd: '## FUTURE-BODY-SECRET\n\nnot public yet',
      isSubstantial: true,
    });
    await insertSandboxVersion(sql, docs.multi.id, 4, {
      effectiveFrom: '+9 days',
    });
    await insertSandboxAudit(sql, docs.multi.id);
    await insertSandboxDraft(sql, docs.multi.id, MARKER);
    // only a future version: still IN_PREPARATION + upcoming
    docs.future = await createSandboxDocument(sql, `${TAG}-future`);
    await insertSandboxVersion(sql, docs.future.id, 1, {
      effectiveFrom: '+3 days',
    });
    // draft only
    docs.draftOnly = await createSandboxDocument(sql, `${TAG}-draftonly`);
    await insertSandboxDraft(sql, docs.draftOnly.id, MARKER);

    openapi = (await request(http()).get('/api/docs-json'))
      .body as typeof openapi;
  }, 60_000);

  afterAll(async () => {
    await purgeSandbox(sql, TAG);
    await restoreLegalReal(sql, saved);
    expect(await realLegalFingerprint(sql)).toBe(fingerprint);
    await app.close();
  }, 60_000);

  describe('GET /legal', () => {
    it('lists exactly the six documents in fixed order, never sandbox ones', async () => {
      const res = await get('').expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      const body = res.body as {
        slug: string;
        title: string;
        kind: string;
        requiresAcceptance: boolean;
        status: string;
      }[];
      expect(body.map((d) => d.slug)).toEqual(SIX);
      expect(body.map((d) => d.requiresAcceptance)).toEqual([
        true,
        true,
        false,
        true,
        true,
        false,
      ]);
      expect(body.map((d) => d.kind)).toEqual([
        'TERMS',
        'PRIVACY',
        'COOKIES',
        'SHIPPING',
        'RETURNS',
        'LEGAL_NOTICE',
      ]);
      for (const d of body) {
        expect(['PUBLISHED', 'IN_PREPARATION']).toContain(d.status);
        if (d.status === 'IN_PREPARATION') {
          expect(d).not.toHaveProperty('currentVersion');
          expect(d).not.toHaveProperty('effectiveFrom');
        }
      }
      expect(JSON.stringify(body)).not.toContain('e2e-');
    });
  });

  describe('GET /legal/current-versions', () => {
    it('only documents in force; sandbox excluded; fixed shape', async () => {
      const res = await get('/current-versions').expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      const body = res.body as {
        documents: {
          slug: string;
          versionNumber: number;
          effectiveFrom: string;
          lastSubstantialVersion: number | null;
        }[];
      };
      expect(Object.keys(body)).toEqual(['documents']);
      for (const d of body.documents) {
        expect(SIX).toContain(d.slug);
        expect(Object.keys(d).sort()).toEqual([
          'effectiveFrom',
          'lastSubstantialVersion',
          'slug',
          'versionNumber',
        ]);
        expect(new Date(d.effectiveFrom).getTime()).toBeLessThanOrEqual(
          Date.now() + 2000,
        );
      }
    });
  });

  describe('GET /legal/identity', () => {
    it('returns the five fields (null when not configured), without author data', async () => {
      await sql(`DELETE FROM "Seller_Identity_Settings"`);
      let res = await get('/identity').expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      expect(res.body).toEqual({
        legalName: null,
        rif: null,
        fiscalAddress: null,
        contactEmail: null,
        phone: null,
      });
      await sql(
        `INSERT INTO "Seller_Identity_Settings" ("id","legalName","rif","contactEmail","updatedAt","updatedById")
         VALUES ('default', 'Razon e2e', 'J-12345678-9', 'a@b.test', now(), gen_random_uuid())`,
      );
      res = await get('/identity').expect(200);
      expect(res.body).toEqual({
        legalName: 'Razon e2e',
        rif: 'J-12345678-9',
        fiscalAddress: null,
        contactEmail: 'a@b.test',
        phone: null,
      });
      await restoreLegalReal(sql, saved);
    });
  });

  describe('GET /legal/:slug', () => {
    it('real documents answer 200 (PUBLISHED or IN_PREPARATION) for the six slugs', async () => {
      for (const slug of SIX) {
        const res = await get(`/${slug}`).expect(200);
        const b = res.body as { slug: string; status: string };
        expect(b.slug).toBe(slug);
        expect(['PUBLISHED', 'IN_PREPARATION']).toContain(b.status);
      }
    });

    it('IN_PREPARATION: 200, no body, no version, no draft text', async () => {
      const res = await get(`/${docs.empty.slug}`).expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      expect(res.body).toEqual({
        slug: docs.empty.slug,
        title: `Sandbox ${TAG}-empty`,
        status: 'IN_PREPARATION',
      });
      const d = await get(`/${docs.draftOnly.slug}`).expect(200);
      expect((d.body as { status: string }).status).toBe('IN_PREPARATION');
      expect(JSON.stringify(d.body)).not.toContain(MARKER);
    });

    it('current = highest versionNumber with effectiveFrom <= now(); future one is upcoming without body', async () => {
      const res = await get(`/${docs.multi.slug}`).expect(200);
      const b = res.body as {
        status: string;
        version: Record<string, unknown>;
        upcoming: Record<string, unknown>;
      };
      expect(b.status).toBe('PUBLISHED');
      expect(Object.keys(b.version).sort()).toEqual([
        'bodyMd',
        'changeSummary',
        'effectiveFrom',
        'isSubstantial',
        'publishedAt',
        'toc',
        'versionNumber',
      ]);
      expect(b.version.versionNumber).toBe(2);
      expect(b.version.toc).toEqual([
        { depth: 2, text: 'Datos', id: 'datos' },
        { depth: 3, text: 'Datos', id: 'datos-2' },
        { depth: 2, text: 'Datos', id: 'datos-3' },
      ]);
      expect(Object.keys(b.upcoming).sort()).toEqual([
        'effectiveFrom',
        'versionNumber',
      ]);
      expect(b.upcoming.versionNumber).toBe(3); // the nearest, not v4
      const txt = JSON.stringify(res.body);
      expect(txt).not.toContain('FUTURE-BODY-SECRET');
      expect(txt).not.toContain(MARKER);
      expect(txt).not.toContain(AUTHOR);
      expect(txt).not.toContain('publishedBy');
    });

    it('a document with only a future version is IN_PREPARATION with upcoming', async () => {
      const res = await get(`/${docs.future.slug}`).expect(200);
      const b = res.body as {
        status: string;
        upcoming: { versionNumber: number };
      };
      expect(b.status).toBe('IN_PREPARATION');
      expect(b).not.toHaveProperty('version');
      expect(b.upcoming.versionNumber).toBe(1);
    });

    it('a version becomes current when its effectiveFrom passes (DB clock)', async () => {
      const d = await createSandboxDocument(sql, `${TAG}-clock`);
      await insertSandboxVersion(sql, d.id, 1, { effectiveFrom: '-1 day' });
      await insertSandboxVersion(sql, d.id, 2, { effectiveFrom: '1500 ms' });
      let b = (await get(`/${d.slug}`).expect(200)).body as {
        version: { versionNumber: number };
        upcoming?: unknown;
      };
      expect(b.version.versionNumber).toBe(1);
      expect(b.upcoming).toBeDefined();
      await new Promise((r) => setTimeout(r, 1800));
      b = (await get(`/${d.slug}`).expect(200)).body as typeof b;
      expect(b.version.versionNumber).toBe(2);
      expect(b.upcoming).toBeUndefined();
    });

    it('404 LEGAL_DOCUMENT_NOT_FOUND for a slug outside the six (and for unknown sandbox format)', async () => {
      for (const s of [
        'otro',
        'Terminos',
        'e2e-doesnotexist-' + TAG,
        'x%20y',
      ]) {
        const res = await get(`/${s}`).expect(404);
        expect((res.body as { errorCode: string }).errorCode).toBe(
          'LEGAL_DOCUMENT_NOT_FOUND',
        );
        expect(res.headers['cache-control'] ?? '').not.toContain('public');
      }
    });
  });

  describe('GET /legal/:slug/versions', () => {
    it('lists effective versions newest first, no body, no author, no future ones', async () => {
      const res = await get(`/${docs.multi.slug}/versions`).expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      const b = res.body as {
        slug: string;
        versions: Record<string, unknown>[];
      };
      expect(b.versions.map((v) => v.versionNumber)).toEqual([2, 1]);
      expect(b.versions.map((v) => v.isCurrent)).toEqual([true, false]);
      expect(Object.keys(b.versions[0]).sort()).toEqual([
        'changeSummary',
        'effectiveFrom',
        'isCurrent',
        'isSubstantial',
        'publishedAt',
        'versionNumber',
      ]);
      const txt = JSON.stringify(res.body);
      for (const s of ['FUTURE-BODY-SECRET', MARKER, AUTHOR, 'bodyMd']) {
        expect(txt).not.toContain(s);
      }
    });

    it('empty list for a document in preparation; 404 for unknown slug', async () => {
      const res = await get(`/${docs.empty.slug}/versions`).expect(200);
      expect((res.body as { versions: unknown[] }).versions).toEqual([]);
      await get('/otro/versions').expect(404);
    });
  });

  describe('GET /legal/:slug/versions/:n', () => {
    it('returns an old version with body, toc and supersededAt', async () => {
      const res = await get(`/${docs.multi.slug}/versions/1`).expect(200);
      expect(res.headers['cache-control']).toBe('public, max-age=60');
      const v = (res.body as { version: Record<string, unknown> }).version;
      expect(v.versionNumber).toBe(1);
      expect(v.bodyMd).toContain('Texto v1');
      expect(v.toc).toEqual([{ depth: 2, text: 'Alcance', id: 'alcance' }]);
      expect(v.isCurrent).toBe(false);
      expect(typeof v.supersededAt).toBe('string');
      expect(JSON.stringify(res.body)).not.toContain(AUTHOR);
      const cur = await get(`/${docs.multi.slug}/versions/2`).expect(200);
      const cv = (cur.body as { version: Record<string, unknown> }).version;
      expect(cv.isCurrent).toBe(true);
      expect(cv.supersededAt).toBeNull();
    });

    it('404 LEGAL_VERSION_NOT_FOUND for a missing version and for a future one', async () => {
      for (const n of [99, 3, 4]) {
        const res = await get(`/${docs.multi.slug}/versions/${n}`).expect(404);
        expect((res.body as { errorCode: string }).errorCode).toBe(
          'LEGAL_VERSION_NOT_FOUND',
        );
      }
      await get(`/${docs.empty.slug}/versions/1`).expect(404);
    });

    it('400 LEGAL_VERSION_INVALID (never 500) for a non-numeric / out-of-range n', async () => {
      for (const n of [
        'abc',
        '0',
        '-1',
        '1.5',
        '1e3',
        '2147483648',
        '99999999999999999999',
      ]) {
        const res = await get(`/${docs.multi.slug}/versions/${n}`).expect(400);
        expect((res.body as { errorCode: string }).errorCode).toBe(
          'LEGAL_VERSION_INVALID',
        );
      }
    });

    it('404 for an unknown slug even with a bad n (never a 500)', async () => {
      const res = await get('/otro/versions/abc');
      expect([400, 404]).toContain(res.status);
      await get('/otro/versions/1').expect(404);
    });
  });

  describe('drafts are never public (NFR-19.4)', () => {
    it('no endpoint returns the draft text of a real or sandbox document', async () => {
      // also a draft on a REAL document (snapshot/restored in afterAll)
      await sql(
        `INSERT INTO "Legal_Drafts" ("id","documentId","bodyMd")
         SELECT gen_random_uuid(), "id", $1 FROM "Legal_Documents" WHERE "slug" = 'terminos'`,
        [MARKER],
      );
      const paths = [
        '',
        '/current-versions',
        '/identity',
        ...SIX.map((s) => `/${s}`),
        ...SIX.map((s) => `/${s}/versions`),
        `/${docs.multi.slug}`,
        `/${docs.multi.slug}/versions`,
        `/${docs.multi.slug}/versions/1`,
        `/${docs.multi.slug}/versions/2`,
        `/${docs.draftOnly.slug}`,
        `/${docs.draftOnly.slug}/versions`,
      ];
      for (const p of paths) {
        const res = await get(p);
        expect(res.status).toBeLessThan(500);
        expect(JSON.stringify(res.body)).not.toContain(MARKER);
      }
      await restoreLegalReal(sql, saved);
    });
  });

  describe('Swagger (/api/docs-json)', () => {
    it.each([
      ['/api/v1/legal', ['200']],
      ['/api/v1/legal/current-versions', ['200']],
      ['/api/v1/legal/identity', ['200']],
      ['/api/v1/legal/{slug}', ['200', '404']],
      ['/api/v1/legal/{slug}/versions', ['200', '404']],
      ['/api/v1/legal/{slug}/versions/{n}', ['200', '400', '404']],
    ])('documents %s with its responses', (path, codes) => {
      const op = openapi.paths[path]?.get;
      expect(op).toBeDefined();
      for (const c of codes) expect(op.responses[c]).toBeDefined();
    });

    it('names the errorCodes in the 4xx descriptions', () => {
      const t = JSON.stringify(
        openapi.paths['/api/v1/legal/{slug}/versions/{n}'],
      );
      for (const c of [
        'LEGAL_VERSION_INVALID',
        'LEGAL_VERSION_NOT_FOUND',
        'LEGAL_DOCUMENT_NOT_FOUND',
      ]) {
        expect(t).toContain(c);
      }
    });
  });

  it('the six real documents are unchanged by this suite so far', async () => {
    expect(await realLegalFingerprint(sql)).toBe(fingerprint);
  });
});
