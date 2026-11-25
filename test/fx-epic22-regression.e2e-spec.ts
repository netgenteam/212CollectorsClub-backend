import { Test } from '@nestjs/testing';
import { INestApplication, VersioningType } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import * as argon2 from 'argon2';
import { AppModule } from './../src/app.module.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { FakeFxProvider } from './../src/fx/fake-fx.provider.js';
import { FxRefreshService } from './../src/fx/fx-refresh.service.js';
import { snapshotFx, restoreFx, type FxState } from './helpers/db-snapshot.js';

type App = Parameters<typeof request>[0];
const HOUR = 3_600_000;
const ago = (h: number) => new Date(Date.now() - h * HOUR);
const SOURCES = ['BCV_USD', 'BCV_EUR', 'PARALELO_USD'] as const;
const USER = 'e2e-admin-story-22-9-fx';
const EMAIL = 'e2e-admin-story-22-9-fx@212collectorsclub.test';
const PASS = 'correct-horse-battery-staple-22-9-fx';

interface Status {
  rate: string;
  lastError: string | null;
  sources: Record<string, { rate: string; providerUpdatedAt: string } | null>;
  sourceStates: Record<
    string,
    {
      lastError: string | null;
      lastSuccessAt: string | null;
      rejectedReading: { reason: string } | null;
    }
  >;
}

/** Story 22.9 (AC4, AC5): FX end to end over HTTP + the real cycle (fake provider), real database. */
describe('FX Epic 22 regression (e2e, Story 22.9 AC4/AC5)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let fx: FxRefreshService;
  let fake: FakeFxProvider;
  let saved: FxState;
  let token: string;
  const server = () => request(app.getHttpServer());
  const status = async (): Promise<Status> =>
    (
      await server()
        .get('/api/v1/admin/fx/status')
        .set({ Authorization: `Bearer ${token}` })
        .expect(200)
    ).body as Status;
  const rateNow = async () =>
    (
      await prisma.fxRateSetting.findUniqueOrThrow({ where: { id: 'default' } })
    ).vesPerUsd.toFixed(4);
  const lastEvent = async () =>
    (
      await prisma.$queryRaw<{ after: Record<string, unknown> }[]>`
        SELECT "after" FROM "Audit_Events" WHERE "action" = 'FX_RATE_CHANGED' ORDER BY "seq" DESC LIMIT 1`
    )[0]?.after;
  const eventCount = async () =>
    Number(
      (
        await prisma.$queryRaw<{ n: bigint }[]>`
          SELECT count(*) AS n FROM "Audit_Events" WHERE "action" = 'FX_RATE_CHANGED'`
      )[0].n,
    );
  const reset = async () => {
    await prisma.fxSourceState.deleteMany();
    await prisma.fxRateSnapshot.deleteMany();
    await prisma.$executeRaw`
      UPDATE "Fx_Rate_Settings" SET "vesPerUsd" = 200, "source" = 'BCV_USD'::"FxRateSource",
        "manualVesPerUsd" = NULL, "maxVariationPct" = 15, "maxAgeHours" = 48,
        "rateFetchedAt" = now(), "providerUpdatedAt" = NULL, "lastError" = NULL,
        "lastErrorAt" = NULL, "rejectedReading" = NULL WHERE "id" = 'default'`;
    fake.reset();
  };

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = mod.createNestApplication();
    app.use(
      cookieParser(app.get(ConfigService).getOrThrow<string>('COOKIE_SECRET')),
    );
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    prisma = app.get(PrismaService);
    fx = app.get(FxRefreshService);
    fake = app.get(FakeFxProvider);
    saved = await snapshotFx(prisma);
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
    await restoreFx(prisma, saved);
    await prisma.adminUser.deleteMany({ where: { username: USER } });
    await app.close();
  });
  beforeEach(reset);

  it('residual 5100.5 seeded for every source: the first real cycle applies the real rate and shows 3 sources + sourceStates', async () => {
    for (const source of SOURCES)
      await prisma.fxRateSnapshot.create({
        data: { source, rate: '5100.5000', providerUpdatedAt: ago(24 * 24) },
      });
    fake.succeedFor('BCV_USD', 920.25, ago(1));
    fake.succeedFor('BCV_EUR', 1010.5, ago(1));
    fake.succeedFor('PARALELO_USD', 1100.75, ago(1));
    expect(await fx.refresh()).toMatchObject({
      status: 'UPDATED',
      source: 'BCV_USD',
      rate: '920.2500',
    });
    const st = await status();
    expect(st.rate).toBe('920.2500');
    expect(st.rate).not.toBe('200.0000');
    expect(Object.keys(st.sources).sort()).toEqual([...SOURCES].sort());
    expect(st.sources.BCV_EUR?.rate).toBe('1010.5000');
    expect(st.sources.PARALELO_USD?.rate).toBe('1100.7500');
    expect(Object.keys(st.sourceStates).sort()).toEqual([...SOURCES].sort());
    for (const s of SOURCES) {
      expect(st.sourceStates[s].lastError).toBeNull();
      expect(st.sourceStates[s].lastSuccessAt).not.toBeNull();
    }
    expect(await lastEvent()).not.toHaveProperty('confirmedAfterRejection');
  });

  it('partial failure of one source: the others are recorded, the failing one keeps its last snapshot and shows its error', async () => {
    fake.succeedFor('BCV_USD', 900, ago(48));
    fake.succeedFor('BCV_EUR', 1000, ago(48));
    fake.succeedFor('PARALELO_USD', 1100, ago(48));
    await fx.refresh();
    fake.succeedFor('BCV_USD', 905, ago(2));
    fake.failFor('BCV_EUR', 'HTTP 500');
    fake.succeedFor('PARALELO_USD', 1105, ago(2));
    expect(await fx.refresh()).toMatchObject({
      status: 'UPDATED',
      rate: '905.0000',
    });
    const st = await status();
    expect(st.sources.BCV_EUR?.rate).toBe('1000.0000');
    expect(st.sources.PARALELO_USD?.rate).toBe('1105.0000');
    expect(st.sourceStates.BCV_EUR.lastError).toMatch(/500/);
    expect(st.sourceStates.BCV_USD.lastError).toBeNull();
    expect(st.sourceStates.PARALELO_USD.lastError).toBeNull();
  });

  it('variation > 15 % is rejected, then confirmed in the next cycle with an event flagged confirmedAfterRejection', async () => {
    fake.succeedFor('BCV_USD', 100, ago(48));
    await fx.refresh();
    const candAt = ago(10);
    fake.succeedFor('BCV_USD', 200, candAt);
    expect(await fx.refresh()).toMatchObject({
      status: 'REJECTED',
      reason: 'VARIATION_EXCEEDED',
    });
    expect(await rateNow()).toBe('100.0000');
    let st = await status();
    expect(st.sourceStates.BCV_USD.rejectedReading?.reason).toBe(
      'VARIATION_EXCEEDED',
    );
    fake.succeedFor('BCV_USD', 200.4, ago(3));
    expect(await fx.refresh()).toMatchObject({
      status: 'UPDATED',
      rate: '200.4000',
    });
    expect(await lastEvent()).toMatchObject({
      confirmedAfterRejection: true,
      candidateProviderUpdatedAt: candAt.toISOString(),
    });
    st = await status();
    expect(st.rate).toBe('200.4000');
    expect(st.sourceStates.BCV_USD.rejectedReading).toBeNull();
    expect(st.lastError).toBeNull();
  });

  it('MANUAL active: the 3 sources are still recorded and the rate does not change', async () => {
    await prisma.fxRateSetting.update({
      where: { id: 'default' },
      data: { source: 'MANUAL', manualVesPerUsd: '777', vesPerUsd: '777' },
    });
    fake.succeedFor('BCV_USD', 920, ago(1));
    fake.succeedFor('BCV_EUR', 1010, ago(1));
    fake.succeedFor('PARALELO_USD', 1100, ago(1));
    const events = await eventCount();
    expect(await fx.refresh()).toMatchObject({ status: 'MANUAL' });
    expect(await rateNow()).toBe('777.0000');
    expect(await eventCount()).toBe(events);
    const st = await status();
    for (const s of SOURCES) expect(st.sources[s]).not.toBeNull();
    expect(st.sources.PARALELO_USD?.rate).toBe('1100.0000');
  });

  it('two simultaneous refresh() => one applies, no double FX_RATE_CHANGED', async () => {
    fake.succeed(500, ago(1));
    const before = await eventCount();
    const rs = await Promise.all([fx.refresh(), fx.refresh()]);
    expect(rs.filter((r) => r.status === 'UPDATED')).toHaveLength(1);
    expect(await eventCount()).toBe(before + 1);
    expect(await rateNow()).toBe('500.0000');
  });
});
