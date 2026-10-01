import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';

interface Param {
  name: string;
  in: string;
  schema?: { type?: string; items?: unknown; $ref?: string };
}
interface OpenApiDoc {
  components: { schemas: Record<string, { enum?: string[] }> };
  paths: Record<string, Record<string, { parameters?: Param[] }>>;
}

// Story 11.6 (FR-35, FR-37, AD-23, AD-24): canonical routes + published
// OpenAPI contract for Epic 11.
describe('Canonical routes & Swagger contract (e2e, Story 11.6)', () => {
  let app: NestExpressApplication;
  let doc: OpenApiDoc;

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
    // Same wiring as main.ts so /api/docs-json is served.
    SwaggerModule.setup(
      'api/docs',
      app,
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder().setTitle('212CollectorsClub API').build(),
      ),
    );
    await app.init();
    const res = await request(app.getHttpServer()).get('/api/docs-json');
    doc = res.body as OpenApiDoc;
  });

  afterAll(async () => {
    await app.close();
  });

  it('serves the canonical routes under /api/v1 only', async () => {
    const http = app.getHttpServer();
    await request(http).get('/api/v1/products').expect(200);
    await request(http).get('/api/v1/categories').expect(200);
    await request(http).get('/products').expect(404);
    await request(http).get('/api/products').expect(404);
    await request(http).get('/v1/products').expect(404);
  });

  it('exposes the Epic 11 enums as reusable component schemas', () => {
    const s = doc.components.schemas;
    expect(s.Franchise.enum).toEqual(
      expect.arrayContaining(['TOPPS', 'NARUTO']),
    );
    expect(s.ProductType.enum).toContain('ACCESSORY');
    expect(s.Rarity).toBeDefined();
    expect(s.MacroCategory.enum).toEqual(
      expect.arrayContaining(['SEALED', 'SINGLES']),
    );
    expect(s.MarketProvider.enum).toEqual(
      expect.arrayContaining(['CARDMARKET', 'PSA_CERT']),
    );
    expect(s.GradingCompany.enum).toEqual(
      expect.arrayContaining(['PSA', 'BGS', 'CGC', 'RAW']),
    );
  });

  it('documents the related and wishlist paths', () => {
    expect(doc.paths['/api/v1/products/{id}/related']?.get).toBeDefined();
    expect(doc.paths['/api/v1/wishlist']?.get).toBeDefined();
    expect(doc.paths['/api/v1/wishlist/items']?.post).toBeDefined();
    expect(
      doc.paths['/api/v1/wishlist/items/{productId}']?.delete,
    ).toBeDefined();
  });

  it('documents the list query filters (productType as array)', () => {
    const params = doc.paths['/api/v1/products'].get.parameters ?? [];
    const by = (n: string) => params.find((p) => p.name === n);
    expect(by('productType')?.schema?.type).toBe('array');
    expect(by('macroCategory')).toBeDefined();
    expect(by('onlyInStock')).toBeDefined();
    expect(by('onlyPreorder')).toBeDefined();
  });
});
