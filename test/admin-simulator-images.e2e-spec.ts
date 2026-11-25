import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { VersioningType } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  PUBLIC_STATIC_PREFIX,
  SIMULATOR_IMAGES_DIR,
  UPLOADS_PUBLIC_ROOT,
} from './../src/admin-catalog/product-image-upload-paths.constants.js';
import { avifOf, jpegOf, pngOf, webpOf } from './fixtures/simulator-images.js';
import { pngOf as pngLanding } from './fixtures/landing-images.js';

type App = Parameters<typeof request>[0];
const USER = 'e2e-admin-story-22-6';
const EMAIL = 'e2e-admin-story-22-6@212collectorsclub.test';
const PASS = 'correct-horse-battery-staple-22-6';
const BASE = '/api/v1/admin/simulator/images';
const SETS = '/api/v1/admin/simulator/manual-sets';
const MAX = 2 * 1024 * 1024;

interface Body {
  errorCode?: string;
  url?: string;
  width?: number;
  height?: number;
  bytes?: number;
  details?: { maxBytes?: number };
  id?: string;
  imageUrl?: string;
}

/** Story 22.6 (AD-107, FR-151): simulator image upload against the real app and disk. */
describe('Admin simulator image upload (e2e, Story 22.6)', () => {
  let app: NestExpressApplication & { getHttpServer(): App };
  let prisma: PrismaService;
  let token: string;
  const urls: string[] = [];
  const setIds: string[] = [];

  const server = () => request(app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });
  const up = (buf: Buffer, name = 'a.png', ct = 'image/png', field = 'file') =>
    server()
      .post(BASE)
      .set(auth())
      .attach(field, buf, { filename: name, contentType: ct });
  const track = (u?: string) => {
    if (u) urls.push(u);
    return u;
  };
  const fileOf = (url: string) =>
    join(SIMULATOR_IMAGES_DIR, url.split('/').pop()!);

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
    // same static mount as main.ts
    app.useStaticAssets(UPLOADS_PUBLIC_ROOT, { prefix: PUBLIC_STATIC_PREFIX });
    await app.init();
    prisma = app.get(PrismaService);
    const passwordHash = await argon2.hash(PASS, { type: argon2.argon2id });
    await prisma.adminUser.upsert({
      where: { username: USER },
      create: { username: USER, email: EMAIL, passwordHash },
      update: { email: EMAIL, passwordHash },
    });
    const login = await server()
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    if (setIds.length)
      await prisma.simulatorSet.deleteMany({ where: { id: { in: setIds } } });
    await Promise.all(urls.map((u) => rm(fileOf(u), { force: true })));
    await prisma.adminUser.deleteMany({ where: { username: USER } });
    await app.close();
  });

  it('AC2: 401 without a session', async () => {
    await server()
      .post(BASE)
      .attach('file', pngOf(10, 10), 'a.png')
      .expect(401);
  });

  it.each([
    ['png', pngOf(300, 200), 'image/png'],
    ['jpg', jpegOf(300, 200), 'image/jpeg'],
    ['webp', webpOf(300, 200), 'image/webp'],
    ['avif', avifOf(300, 200), 'image/avif'],
  ])('AC2/3: valid %s => 201, stored and served', async (ext, buf, mime) => {
    // declared name/content-type deliberately wrong: content decides
    const r = await up(buf, 'whatever.bin', 'application/octet-stream').expect(
      201,
    );
    const b = r.body as Body;
    track(b.url);
    expect(b.url).toMatch(
      new RegExp(`^/uploads/public/simulator/[0-9a-f-]{36}\\.${ext}$`),
    );
    expect(b).toMatchObject({ width: 300, height: 200, bytes: buf.length });
    await access(fileOf(b.url as string));
    const get = await server()
      .get(b.url as string)
      .expect(200);
    expect(get.headers['content-type']).toContain(mime);
  });

  it('AC3: fake extension / text / empty / gif / svg / bmp => 400 UNSUPPORTED_FILE_TYPE', async () => {
    const fakes: [Buffer, string][] = [
      [Buffer.from('MZ\x90\x00 not an image'), 'evil.png'],
      [Buffer.from('plain text'), 'a.jpg'],
      [Buffer.alloc(0), 'empty.png'],
      [Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;'), 'a.png'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'a.svg'],
      [Buffer.from('BM\x1e\x00\x00\x00\x00\x00\x00\x00\x1a'), 'a.bmp'],
    ];
    for (const [buf, name] of fakes) {
      const r = await up(buf, name);
      expect([400]).toContain(r.status);
      expect(['UNSUPPORTED_FILE_TYPE', 'SIMULATOR_IMAGE_REQUIRED']).toContain(
        (r.body as Body).errorCode,
      );
    }
    const r = await up(Buffer.from('plain text'), 'a.jpg').expect(400);
    expect((r.body as Body).errorCode).toBe('UNSUPPORTED_FILE_TYPE');
  });

  it('AC4: weight boundary (2 MB ok, +1 byte => 413)', async () => {
    const pad = (n: number) =>
      Buffer.concat([
        webpOf(100, 100),
        Buffer.alloc(n - webpOf(100, 100).length),
      ]);
    // RIFF length is not verified; header-only dims are enough for image-size
    const ok = await up(pad(MAX), 'a.webp', 'image/webp').expect(201);
    track((ok.body as Body).url);
    const r = await up(pad(MAX + 1), 'a.webp', 'image/webp').expect(413);
    expect(r.body as Body).toMatchObject({
      errorCode: 'SIMULATOR_IMAGE_TOO_LARGE',
      details: { maxBytes: MAX },
    });
  });

  it('AC4: side boundary (4096 ok, 4097 => 422) and any proportion', async () => {
    const ok = await up(pngOf(4096, 100)).expect(201);
    track((ok.body as Body).url);
    for (const buf of [pngOf(4097, 100), pngOf(100, 4097)]) {
      const r = await up(buf).expect(422);
      expect((r.body as Body).errorCode).toBe('SIMULATOR_IMAGE_DIMENSIONS');
    }
    // proportions that landing kind=card rejects pass here
    for (const [w, h] of [
      [1000, 1000],
      [300, 900],
    ]) {
      const r = await up(pngOf(w, h)).expect(201);
      track((r.body as Body).url);
    }
    await server()
      .post('/api/v1/admin/landing-content/images?kind=card')
      .set(auth())
      .attach('file', pngLanding(1000, 1000), 'a.png')
      .expect(422);
  });

  it('AC4: unreadable/0 dimensions => 422', async () => {
    const r = await up(pngOf(0, 0)).expect(422);
    expect((r.body as Body).errorCode).toBe('SIMULATOR_IMAGE_DIMENSIONS');
  });

  it('AC5: no file / other field name / several files => 400 with errorCode, never 500', async () => {
    const none = await server()
      .post(BASE)
      .set(auth())
      .field('x', 'y')
      .expect(400);
    expect((none.body as Body).errorCode).toBe('SIMULATOR_IMAGE_REQUIRED');
    const other = await up(pngOf(10, 10), 'a.png', 'image/png', 'image').expect(
      400,
    );
    expect((other.body as Body).errorCode).toBe('SIMULATOR_IMAGE_REQUIRED');
    const many = await server()
      .post(BASE)
      .set(auth())
      .attach('file', pngOf(10, 10), 'a.png')
      .attach('file', pngOf(10, 10), 'b.png');
    expect(many.status).toBe(400);
    expect((many.body as Body).errorCode).toBe(
      'SIMULATOR_IMAGE_MULTIPART_INVALID',
    );
  });

  it('AC6: polyglot is stored with the real extension; original name never used', async () => {
    const poly = Buffer.concat([
      pngOf(50, 50),
      Buffer.from('<script>alert(1)</script>'),
    ]);
    const r = await up(poly, '../../x.html', 'text/html').expect(201);
    const b = r.body as Body;
    track(b.url);
    expect(b.url).toMatch(/^\/uploads\/public\/simulator\/[0-9a-f-]{36}\.png$/);
    const get = await server()
      .get(b.url as string)
      .expect(200);
    expect(get.headers['content-type']).toContain('image/png');
    const traversal = await up(pngOf(10, 10), '../../x.png').expect(201);
    track((traversal.body as Body).url);
    expect((traversal.body as Body).url).toMatch(
      /^\/uploads\/public\/simulator\/[0-9a-f-]{36}\.png$/,
    );
    expect((await readFile(fileOf(b.url as string))).equals(poly)).toBe(true);
  });

  it('AC7: the returned url is accepted as imageUrl when creating a set', async () => {
    const r = await up(pngOf(64, 64)).expect(201);
    const url = track((r.body as Body).url) as string;
    const set = await server()
      .post(SETS)
      .set(auth())
      .send({ name: `e2e226-${Date.now()}`, imageUrl: url })
      .expect(201);
    setIds.push((set.body as Body).id as string);
    expect((set.body as Body).imageUrl).toBe(url);
  });

  it('AC9: 10 simultaneous uploads => 10 distinct files', async () => {
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => up(pngOf(20, 20))),
    );
    const us = rs.map((r) => {
      expect(r.status).toBe(201);
      return track((r.body as Body).url) as string;
    });
    expect(new Set(us).size).toBe(10);
    await Promise.all(us.map((u) => access(fileOf(u))));
  });
});
