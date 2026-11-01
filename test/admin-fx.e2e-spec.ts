import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  FakeFxProvider,
  FAKE_FX_FIXTURES,
} from './../src/fx/fake-fx.provider.js';
import { FxRefreshService } from './../src/fx/fx-refresh.service.js';
import { snapshotFx, restoreFx, type FxState } from './helpers/db-snapshot.js';

type App = Parameters<typeof request>[0];
const USER = 'e2e-admin-story-18-2';
const EMAIL = 'e2e-admin-story-18-2@212collectorsclub.test';
const PASS = 'correct-horse-battery-staple-18-2';
const BASE = '/api/v1/admin/fx';
const D0 = new Date('2026-10-30T12:00:00.000Z');
const D1 = new Date('2026-10-31T12:00:00.000Z');
const D2 = new Date('2026-11-01T06:00:00.000Z');

interface Err {
  errorCode?: string;
}
interface Status {
  source: string;
  rate: string;
  providerUpdatedAt: string | null;
  fetchedAt: string | null;
  stale: boolean;
  hardStale: boolean;
  lastError: string | null;
  rejectedReading: { reason: string } | null;
  sources: Record<string, { rate: string } | null>;
  result?: string;
}

/**
 * Story 18.2 (AD-79 Admin, FR-90/92/95) + QA 18.1 fixes. Fake provider (zero
 * network); the real FX row, snapshots and audits are snapshotted and
 * restored.
 */
describe('Admin FX API (e2e, Story 18.2)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fake: FakeFxProvider;
  let token: string;
  let adminId: string;
  let saved: FxState;
  let savedAudits: Awaited<
    ReturnType<PrismaService['fxSettingAudit']['findMany']>
  >;
  let realRowText: string;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const server = () => request(app.getHttpServer());
  const rowText = async () =>
    JSON.stringify(
      await prisma.$queryRaw`SELECT * FROM "Fx_Rate_Settings" ORDER BY "id"`,
    );
  const setting = () =>
    prisma.fxRateSetting.findUniqueOrThrow({ where: { id: 'default' } });
  const snaps = (source = 'BCV_USD') =>
    prisma.fxRateSnapshot.count({ where: { source: source as 'BCV_USD' } });
  const put = (body: object) =>
    server().put(`${BASE}/settings`).set(auth()).send(body);
  const status = async () =>
    (await server().get(`${BASE}/status`).set(auth()).expect(200))
      .body as Status;

  const reset = async (source = 'BCV_USD') => {
    await prisma.fxRateSnapshot.deleteMany();
    await prisma.fxSettingAudit.deleteMany();
    await prisma.$executeRaw`
      UPDATE "Fx_Rate_Settings" SET "vesPerUsd" = 100, "source" = ${source}::"FxRateSource",
        "manualVesPerUsd" = NULL, "maxVariationPct" = 15, "maxAgeHours" = 48,
        "rateFetchedAt" = now(), "providerUpdatedAt" = NULL, "lastError" = NULL,
        "lastErrorAt" = NULL, "rejectedReading" = NULL WHERE "id" = 'default'`;
    fake.reset();
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    fake = app.get(FakeFxProvider);
    saved = await snapshotFx(prisma);
    savedAudits = await prisma.fxSettingAudit.findMany();
    realRowText = await rowText();
    const passwordHash = await argon2.hash(PASS, { type: argon2.argon2id });
    const admin = await prisma.adminUser.upsert({
      where: { username: USER },
      create: { username: USER, email: EMAIL, passwordHash },
      update: { email: EMAIL, passwordHash },
    });
    adminId = admin.id;
    const login = await server()
      .post('/api/v1/admin/auth/login')
      .send({ usernameOrEmail: USER, password: PASS })
      .expect(200);
    token = (login.body as { accessToken: string }).accessToken;
  });

  afterAll(async () => {
    await restoreFx(prisma, saved);
    await prisma.fxSettingAudit.deleteMany();
    if (savedAudits.length) {
      await prisma.fxSettingAudit.createMany({
        data: savedAudits.map((a) => ({
          ...a,
          adminUserId: a.adminUserId === adminId ? null : a.adminUserId,
        })),
      });
    }
    expect(await rowText()).toBe(realRowText);
    expect(await prisma.fxRateSnapshot.count()).toBe(saved.snapshots.length);
    expect(await prisma.fxSettingAudit.count()).toBe(savedAudits.length);
    await app.close();
  });

  beforeEach(() => reset());

  it('401 without token on every route (AC1)', async () => {
    await server().get(`${BASE}/settings`).expect(401);
    await server().put(`${BASE}/settings`).send({}).expect(401);
    await server().get(`${BASE}/status`).expect(401);
    await server().post(`${BASE}/refresh`).expect(401);
    await server().post(`${BASE}/accept-rejected`).expect(401);
    await server().get(`${BASE}/history`).expect(401);
    await server().get(`${BASE}/audit`).expect(401);
  });

  it('GET settings returns the 5 documented fields (AC1)', async () => {
    const res = await server().get(`${BASE}/settings`).set(auth()).expect(200);
    expect(res.body).toEqual({
      source: 'BCV_USD',
      manualVesPerUsd: null,
      maxAgeHours: 48,
      maxVariationPct: 15,
      vesPerUsd: '100.0000',
    });
  });

  describe('PUT validation (AC2)', () => {
    it('400 on out-of-range values, unknown fields and bad source', async () => {
      const bad = [
        { source: 'BCV_USD', maxAgeHours: 0 },
        { source: 'BCV_USD', maxAgeHours: 721 },
        { source: 'BCV_USD', maxAgeHours: 1.5 },
        { source: 'BCV_USD', maxVariationPct: 0.5 },
        { source: 'BCV_USD', maxVariationPct: 51 },
        { source: 'BCV_USD', admin: 'x' },
        { source: 'BCV_USD', adminUserId: adminId },
        { source: 'NOPE' },
        {},
        { source: 'MANUAL', manualVesPerUsd: 'abc' },
        { source: 'BCV_USD', manualVesPerUsd: -3 },
      ];
      for (const b of bad) await put(b).expect(400);
      expect(await prisma.fxSettingAudit.count()).toBe(0);
    });

    it('400 FX_MANUAL_RATE_REQUIRED for MANUAL without a positive rate', async () => {
      for (const b of [
        { source: 'MANUAL' },
        { source: 'MANUAL', manualVesPerUsd: 0 },
        { source: 'MANUAL', manualVesPerUsd: -1 },
      ]) {
        const res = await put(b).expect(400);
        expect((res.body as Err).errorCode).toBe('FX_MANUAL_RATE_REQUIRED');
      }
      expect((await setting()).source).toBe('BCV_USD');
      expect(await prisma.fxSettingAudit.count()).toBe(0);
    });
  });

  describe('PUT behaviour (AC2, AC3)', () => {
    it('each of the 3 sources switches the rate to its fixture; one audit row each', async () => {
      const chain = ['BCV_EUR', 'PARALELO_USD', 'BCV_USD'] as const;
      let from = 'BCV_USD';
      for (const source of chain) {
        const res = await put({ source }).expect(200);
        expect(res.body).toMatchObject({
          source,
          stale: false,
          vesPerUsd: FAKE_FX_FIXTURES[source].toFixed(4),
        });
        expect((await setting()).vesPerUsd.toFixed(4)).toBe(
          FAKE_FX_FIXTURES[source].toFixed(4),
        );
        const last = await prisma.fxSettingAudit.findFirstOrThrow({
          orderBy: { createdAt: 'desc' },
        });
        expect(last).toMatchObject({
          adminUserId: adminId,
          fromSource: from,
          toSource: source,
          manualRate: null,
        });
        from = source;
      }
      expect(await prisma.fxSettingAudit.count()).toBe(3);
    });

    it('MANUAL sets vesPerUsd = manual, audits the manual rate, never calls the network', async () => {
      const res = await put({
        source: 'MANUAL',
        manualVesPerUsd: 912.5,
      }).expect(200);
      expect(res.body).toMatchObject({
        source: 'MANUAL',
        manualVesPerUsd: '912.5000',
        vesPerUsd: '912.5000',
        stale: false,
      });
      expect(fake.calls).toEqual([]);
      const a = await prisma.fxSettingAudit.findFirstOrThrow();
      expect(a.manualRate?.toFixed(4)).toBe('912.5000');
      expect(a).toMatchObject({ fromSource: 'BCV_USD', toSource: 'MANUAL' });
    });

    it('thresholds are updated without changing the source; still audited', async () => {
      const res = await put({
        source: 'BCV_USD',
        maxAgeHours: 720,
        maxVariationPct: 1,
      }).expect(200);
      expect(res.body).toMatchObject({ maxAgeHours: 720, maxVariationPct: 1 });
      expect(await prisma.fxSettingAudit.count()).toBe(1);
    });

    it('provider down + new source without snapshots => source and rate unchanged, 200 stale:true sourceChanged:false (QA 18.3)', async () => {
      await put({ source: 'BCV_EUR' }).expect(200);
      const before = await setting();
      const audits = await prisma.fxSettingAudit.count();
      fake.fail('boom');
      const res = await put({ source: 'PARALELO_USD' }).expect(200);
      expect(res.body).toMatchObject({
        source: 'BCV_EUR',
        stale: true,
        refresh: 'FAILED',
        sourceChanged: false,
        reason: 'PROVIDER_ERROR',
        vesPerUsd: before.vesPerUsd.toFixed(4),
      });
      const after = await setting();
      expect(after.source).toBe('BCV_EUR');
      expect(after.rateFetchedAt?.getTime()).toBe(
        before.rateFetchedAt?.getTime(),
      );
      expect(await prisma.fxSettingAudit.count()).toBe(audits);
    });

    it('provider down + new source WITH a snapshot => switches to that snapshot (own rate and real dates), stale:true, lastError on the new source (QA 18.3)', async () => {
      const at = new Date('2026-10-01T12:00:00.000Z');
      const fetchedAt = new Date(Date.now() - 2 * 3600 * 1000);
      await prisma.fxRateSnapshot.create({
        data: {
          source: 'PARALELO_USD',
          rate: '777.0000',
          providerUpdatedAt: at,
          fetchedAt,
        },
      });
      fake.fail('boom');
      const res = await put({ source: 'PARALELO_USD' }).expect(200);
      expect(res.body).toMatchObject({
        source: 'PARALELO_USD',
        vesPerUsd: '777.0000',
        stale: true,
        refresh: 'FAILED',
        sourceChanged: true,
        reason: 'PROVIDER_ERROR',
      });
      const row = await setting();
      expect(row.providerUpdatedAt?.getTime()).toBe(at.getTime());
      expect(row.rateFetchedAt?.getTime()).toBe(fetchedAt.getTime());
      expect(row.lastError).toContain('boom');
    });

    it('rejected reading of the new source => falls back to its snapshot; rejectedReading belongs to the NEW source (QA 18.3)', async () => {
      await prisma.fxRateSnapshot.create({
        data: {
          source: 'PARALELO_USD',
          rate: '950.1000',
          providerUpdatedAt: new Date('2026-10-30T12:00:00.000Z'),
        },
      });
      fake.succeedFor(
        'PARALELO_USD',
        950.1,
        new Date('2026-10-01T12:00:00.000Z'),
      );
      const res = await put({ source: 'PARALELO_USD' }).expect(200);
      expect(res.body).toMatchObject({
        source: 'PARALELO_USD',
        vesPerUsd: '950.1000',
        stale: true,
        refresh: 'REJECTED',
        reason: 'DATE_REGRESSION',
      });
      const row = await setting();
      expect(row.rejectedReading).toMatchObject({
        source: 'PARALELO_USD',
        reason: 'DATE_REGRESSION',
      });
    });

    it('source change with a valid reading writes source+rate+snapshot+audit together (QA 18.3)', async () => {
      const res = await put({ source: 'PARALELO_USD' }).expect(200);
      expect(res.body).toMatchObject({
        source: 'PARALELO_USD',
        vesPerUsd: '950.1000',
        stale: false,
        refresh: 'UPDATED',
        sourceChanged: true,
        reason: null,
      });
      expect(await snaps('PARALELO_USD')).toBe(1);
    });

    it('a refresh whose fetch straddles a source change is discarded (SKIPPED), never leaves a mixed pair (QA 18.3)', async () => {
      const refresher = app.get(FxRefreshService);
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const orig = fake.fetchRate.bind(fake);
      fake.fetchRate = async (src) => {
        await gate;
        return orig(src);
      };
      try {
        const pending = refresher.refresh(); // active = BCV_USD, blocked in fetch
        await new Promise((r) => setTimeout(r, 50));
        fake.fetchRate = orig;
        await put({ source: 'PARALELO_USD' }).expect(200);
        release();
        expect((await pending).status).toBe('SKIPPED');
      } finally {
        fake.fetchRate = orig;
        release();
      }
      const row = await setting();
      expect(row.source).toBe('PARALELO_USD');
      expect(row.vesPerUsd.toFixed(4)).toBe('950.1000');
    });

    it('5 simultaneous PUTs => 5 coherent audit rows, chained, no 5xx (AC3)', async () => {
      const targets = [
        { source: 'BCV_EUR' },
        { source: 'PARALELO_USD' },
        { source: 'MANUAL', manualVesPerUsd: 500 },
        { source: 'BCV_USD' },
        { source: 'BCV_EUR' },
      ];
      const results = await Promise.all(targets.map((b) => put(b)));
      for (const r of results) expect(r.status).toBe(200);
      const rows = await prisma.fxSettingAudit.findMany({
        orderBy: { createdAt: 'asc' },
      });
      expect(rows).toHaveLength(5);
      expect(rows[0].fromSource).toBe('BCV_USD');
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i].fromSource).toBe(rows[i - 1].toSource);
      }
      expect(rows.map((r) => r.toSource).sort()).toEqual(
        targets.map((t) => t.source).sort(),
      );
      expect((await setting()).source).toBe(rows[4].toSource);
    });
  });

  describe('GET status (AC4)', () => {
    it('reports the live value of the 3 sources from snapshots without network', async () => {
      for (const s of ['BCV_USD', 'BCV_EUR', 'PARALELO_USD'] as const) {
        await put({ source: s }).expect(200);
      }
      fake.calls = [];
      const st = await status();
      expect(fake.calls).toEqual([]);
      expect(st).toMatchObject({
        source: 'PARALELO_USD',
        rate: FAKE_FX_FIXTURES.PARALELO_USD.toFixed(4),
        stale: false,
        hardStale: false,
        lastError: null,
        rejectedReading: null,
      });
      expect(st.sources.BCV_USD?.rate).toBe(
        FAKE_FX_FIXTURES.BCV_USD.toFixed(4),
      );
      expect(st.sources.BCV_EUR?.rate).toBe(
        FAKE_FX_FIXTURES.BCV_EUR.toFixed(4),
      );
      expect(st.sources.PARALELO_USD?.rate).toBe(
        FAKE_FX_FIXTURES.PARALELO_USD.toFixed(4),
      );
    });

    it('sources without snapshot are null', async () => {
      const st = await status();
      expect(st.sources).toEqual({
        BCV_USD: null,
        BCV_EUR: null,
        PARALELO_USD: null,
      });
    });

    it('stale / hardStale thresholds, never for MANUAL', async () => {
      const ago = (h: number) => new Date(Date.now() - h * 3600_000);
      const setFetched = (d: Date) =>
        prisma.fxRateSetting.update({
          where: { id: 'default' },
          data: { rateFetchedAt: d },
        });
      await setFetched(ago(47));
      expect(await status()).toMatchObject({ stale: false, hardStale: false });
      await setFetched(ago(49));
      expect(await status()).toMatchObject({ stale: true, hardStale: false });
      await setFetched(ago(145));
      expect(await status()).toMatchObject({ stale: true, hardStale: true });
      await prisma.fxRateSetting.update({
        where: { id: 'default' },
        data: { source: 'MANUAL', manualVesPerUsd: 10 },
      });
      expect(await status()).toMatchObject({ stale: false, hardStale: false });
    });
  });

  describe('POST refresh (AC5)', () => {
    it('refreshes the active source and returns the status', async () => {
      const res = await server()
        .post(`${BASE}/refresh`)
        .set(auth())
        .expect(200);
      expect(res.body).toMatchObject({
        result: 'UPDATED',
        rate: FAKE_FX_FIXTURES.BCV_USD.toFixed(4),
      });
      expect(await snaps()).toBe(1);
    });

    it('409 FX_REFRESH_IN_PROGRESS while the advisory lock is held', async () => {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      let acquired!: () => void;
      const gotLock = new Promise<void>((r) => (acquired = r));
      const holder = prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('fx:refresh', 0))`;
        acquired();
        await held;
      });
      await gotLock;
      try {
        const res = await server()
          .post(`${BASE}/refresh`)
          .set(auth())
          .expect(409);
        expect((res.body as Err).errorCode).toBe('FX_REFRESH_IN_PROGRESS');
        expect(await snaps()).toBe(0);
      } finally {
        release();
        await holder;
      }
    });

    it('5 simultaneous refreshes => a single new snapshot, 200/409 only', async () => {
      const rs = await Promise.all(
        Array.from({ length: 5 }, () =>
          server().post(`${BASE}/refresh`).set(auth()),
        ),
      );
      for (const r of rs) expect([200, 409]).toContain(r.status);
      expect(rs.some((r) => r.status === 200)).toBe(true);
      expect(await snaps()).toBe(1);
    });

    it('MANUAL does not touch the network', async () => {
      await put({ source: 'MANUAL', manualVesPerUsd: 77 }).expect(200);
      const res = await server()
        .post(`${BASE}/refresh`)
        .set(auth())
        .expect(200);
      expect((res.body as Status).result).toBe('MANUAL');
      expect(fake.calls).toEqual([]);
    });
  });

  describe('POST accept-rejected (AC6)', () => {
    const seedRejected = async () => {
      await prisma.fxRateSnapshot.create({
        data: { source: 'BCV_USD', rate: 100, providerUpdatedAt: D0 },
      });
      await prisma.fxRateSetting.update({
        where: { id: 'default' },
        data: { providerUpdatedAt: D0 },
      });
      fake.succeed(200, D1);
      const res = await server()
        .post(`${BASE}/refresh`)
        .set(auth())
        .expect(200);
      expect((res.body as Status).result).toBe('REJECTED');
      expect((res.body as Status).rejectedReading?.reason).toBe(
        'VARIATION_EXCEEDED',
      );
    };

    it('409 FX_NO_REJECTED_READING without a rejected reading', async () => {
      const res = await server()
        .post(`${BASE}/accept-rejected`)
        .set(auth())
        .expect(409);
      expect((res.body as Err).errorCode).toBe('FX_NO_REJECTED_READING');
    });

    it('applies it skipping the variation check, inserts the snapshot, clears it and audits', async () => {
      await seedRejected();
      const res = await server()
        .post(`${BASE}/accept-rejected`)
        .set(auth())
        .expect(200);
      expect(res.body).toMatchObject({
        rate: '200.0000',
        rejectedReading: null,
        lastError: null,
      });
      expect(await snaps()).toBe(2);
      const a = await prisma.fxSettingAudit.findFirstOrThrow();
      expect(a).toMatchObject({
        adminUserId: adminId,
        fromSource: 'BCV_USD',
        toSource: 'BCV_USD',
        action: 'REJECTED_READING_ACCEPTED',
      });
    });

    it('two simultaneous calls: one applies, the other 409', async () => {
      await seedRejected();
      const rs = await Promise.all([
        server().post(`${BASE}/accept-rejected`).set(auth()),
        server().post(`${BASE}/accept-rejected`).set(auth()),
      ]);
      expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(await snaps()).toBe(2);
      expect(await prisma.fxSettingAudit.count()).toBe(1);
    });

    it('a rejection is dropped when the source changes', async () => {
      await seedRejected();
      await put({ source: 'BCV_EUR' }).expect(200);
      await server().post(`${BASE}/accept-rejected`).set(auth()).expect(409);
    });

    it('422 for a structurally invalid rejected reading (NaN)', async () => {
      fake.nan(D1);
      await server().post(`${BASE}/refresh`).set(auth()).expect(200);
      const res = await server()
        .post(`${BASE}/accept-rejected`)
        .set(auth())
        .expect(422);
      expect((res.body as Err).errorCode).toBe(
        'FX_REJECTED_READING_NOT_ACCEPTABLE',
      );
    });

    it('QA 18.1 #3: same providerUpdatedAt with another rate is rejected; accepting it also corrects the snapshot', async () => {
      fake.succeed(100, D0);
      await server().post(`${BASE}/refresh`).set(auth()).expect(200);
      fake.succeed(105, D0);
      const res = await server()
        .post(`${BASE}/refresh`)
        .set(auth())
        .expect(200);
      expect((res.body as Status).result).toBe('REJECTED');
      expect((res.body as Status).rejectedReading?.reason).toBe(
        'DATE_NOT_NEWER',
      );
      expect((await setting()).vesPerUsd.toFixed(4)).toBe('100.0000');
      await server().post(`${BASE}/accept-rejected`).set(auth()).expect(200);
      expect((await setting()).vesPerUsd.toFixed(4)).toBe('105.0000');
      const s = await prisma.fxRateSnapshot.findMany();
      expect(s).toHaveLength(1);
      expect(s[0].rate.toFixed(4)).toBe('105.0000');
    });
  });

  describe('QA 18.1 fixes through the refresh path', () => {
    it('#1: exactly +15 % is accepted (cur 20.2 -> 23.23)', async () => {
      fake.succeed(20.2, D0);
      await server().post(`${BASE}/refresh`).set(auth()).expect(200);
      fake.succeed(23.23, D1);
      const res = await server()
        .post(`${BASE}/refresh`)
        .set(auth())
        .expect(200);
      expect((res.body as Status).result).toBe('UPDATED');
      expect((res.body as Status).rate).toBe('23.2300');
    });

    it('#2: a 1e20 reading is rejected OUT_OF_RANGE and admin endpoints stay 200', async () => {
      fake.succeed(1e20, D1);
      const res = await server()
        .post(`${BASE}/refresh`)
        .set(auth())
        .expect(200);
      expect((res.body as Status).result).toBe('REJECTED');
      expect((res.body as Status).rejectedReading?.reason).toBe('OUT_OF_RANGE');
      expect((await setting()).vesPerUsd.toFixed(4)).toBe('100.0000');
      await status();
      await put({ source: 'BCV_EUR' }).expect(200);
      fake.succeed(1e20, D2);
      const r2 = await put({ source: 'BCV_USD' }).expect(200);
      expect((r2.body as { stale: boolean }).stale).toBe(true);
    });
  });

  describe('GET history / audit (AC7)', () => {
    const seed = async () => {
      for (let i = 0; i < 4; i++) {
        await prisma.fxRateSnapshot.create({
          data: {
            source: i % 2 ? 'BCV_EUR' : 'BCV_USD',
            rate: 100 + i,
            providerUpdatedAt: new Date(D0.getTime() + i * 3600_000),
            fetchedAt: new Date(D0.getTime() + i * 3600_000),
          },
        });
      }
    };

    it('history: default order fetchedAt DESC, source filter and limit', async () => {
      await seed();
      const all = await server().get(`${BASE}/history`).set(auth()).expect(200);
      const rates = (all.body as { data: { rate: string }[] }).data.map(
        (d) => d.rate,
      );
      expect(rates).toEqual(['103.0000', '102.0000', '101.0000', '100.0000']);
      const eur = await server()
        .get(`${BASE}/history?source=BCV_EUR&limit=1`)
        .set(auth())
        .expect(200);
      expect((eur.body as { data: unknown[] }).data).toHaveLength(1);
      expect((eur.body as { data: { source: string }[] }).data[0].source).toBe(
        'BCV_EUR',
      );
    });

    it('history: limit 200 ok; 201 / 0 / abc / invalid source => 400', async () => {
      await server().get(`${BASE}/history?limit=200`).set(auth()).expect(200);
      for (const q of ['limit=201', 'limit=0', 'limit=abc', 'source=NOPE']) {
        await server().get(`${BASE}/history?${q}`).set(auth()).expect(400);
      }
    });

    it('audit: newest first, paginated, only admin id/email', async () => {
      for (const s of ['BCV_EUR', 'PARALELO_USD', 'BCV_USD']) {
        await put({ source: s }).expect(200);
      }
      const p1 = await server()
        .get(`${BASE}/audit?limit=2`)
        .set(auth())
        .expect(200);
      const b1 = p1.body as {
        data: { toSource: string; action: string; admin: object }[];
        meta: { total: number; totalPages: number; hasNextPage: boolean };
      };
      expect(b1.data.map((d) => d.toSource)).toEqual([
        'BCV_USD',
        'PARALELO_USD',
      ]);
      expect(b1.data[0].admin).toEqual({ id: adminId, email: EMAIL });
      // Story 18.3: PUTs are SETTINGS_UPDATED; accept-rejected is its own action.
      expect(b1.data.every((d) => d.action === 'SETTINGS_UPDATED')).toBe(true);
      expect(b1.meta).toMatchObject({
        total: 3,
        totalPages: 2,
        hasNextPage: true,
      });
      expect(JSON.stringify(p1.body)).not.toMatch(/passwordHash|username/);
      const p2 = await server()
        .get(`${BASE}/audit?limit=2&page=2`)
        .set(auth())
        .expect(200);
      expect((p2.body as { data: unknown[] }).data).toHaveLength(1);
      await server().get(`${BASE}/audit?limit=101`).set(auth()).expect(400);
      await server().get(`${BASE}/audit?page=0`).set(auth()).expect(400);
    });
  });

  it('Swagger documents body, queries and errorCodes of every endpoint (AC8)', () => {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('t').build(),
    );
    const p = (path: string) =>
      (doc.paths[path] ?? {}) as Record<
        string,
        {
          requestBody?: unknown;
          parameters?: { name: string }[];
          responses: Record<string, { description?: string }>;
        }
      >;
    const all = [
      `/api/v1/admin/fx/settings`,
      `/api/v1/admin/fx/status`,
      `/api/v1/admin/fx/refresh`,
      `/api/v1/admin/fx/accept-rejected`,
      `/api/v1/admin/fx/history`,
      `/api/v1/admin/fx/audit`,
    ];
    for (const path of all) expect(doc.paths[path]).toBeDefined();
    const put_ = p(all[0]).put;
    expect(put_.requestBody).toBeDefined();
    expect(put_.responses['400'].description).toContain(
      'FX_MANUAL_RATE_REQUIRED',
    );
    expect(p(all[2]).post.responses['409'].description).toBe(
      'FX_REFRESH_IN_PROGRESS',
    );
    expect(p(all[3]).post.responses['409'].description).toBe(
      'FX_NO_REJECTED_READING',
    );
    expect(p(all[4]).get.parameters?.map((x) => x.name)).toEqual(
      expect.arrayContaining(['source', 'limit']),
    );
    expect(p(all[5]).get.parameters?.map((x) => x.name)).toEqual(
      expect.arrayContaining(['page', 'limit']),
    );
    for (const path of all) {
      for (const m of Object.values(p(path))) {
        expect(m.responses['401'].description).toBe('INVALID_ADMIN_TOKEN');
      }
    }
  });
});
