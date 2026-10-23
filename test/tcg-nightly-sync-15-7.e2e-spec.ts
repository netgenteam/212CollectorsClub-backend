import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { TCG_API_CLIENT } from './../src/tcg/tcg-api-client.interface.js';
import { FakeTcgApiClient } from './../src/tcg/fake-tcg-api-client.js';
import { TcgIngestService } from './../src/tcg/tcg-ingest.service.js';
import { TcgNightlySyncService } from './../src/tcg/tcg-nightly-sync.service.js';

const GAME = 'e2e157';
const PREFIX = 'e2e157-';
const SET = (n: number) => FakeTcgApiClient.setIdFor(GAME, n);
const CARD = (setN: number, n: number) => String(Number(SET(setN)) * 100 + n);
const ENVS = [
  'TCG_NIGHTLY_SYNC_ENABLED',
  'TCG_NIGHTLY_MAX_REQUESTS',
  'TCG_PRICE_ALERT_PCT',
  'TCG_REQUEST_RESERVE',
];

/**
 * Story 15.7 (FR-70; AD-58): nightly price sync + audit. Fake client only
 * (no network); data is scoped by game slug `e2e157` / slug prefix.
 */
describe('TCG nightly sync (e2e, Story 15.7)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ingest: TcgIngestService;
  let nightly: TcgNightlySyncService;
  let fake: FakeTcgApiClient;
  let categoryId: string;
  // DONE cursors that do not belong to this suite (other suites, real data):
  // the worker syncs every DONE set, so they are parked as PENDING while the
  // test runs and restored afterwards.
  let parkedCursorIds: string[] = [];

  const clean = async () => {
    await prisma.order.deleteMany({
      where: { recipientName: 'E2E157 buyer' },
    });
    await prisma.product.deleteMany({
      where: { slug: { startsWith: PREFIX } },
    });
    await prisma.masterCard.deleteMany({ where: { gameSlug: GAME } });
    await prisma.tcgIngestCursor.deleteMany({ where: { gameSlug: GAME } });
    await prisma.tcgSyncRun.deleteMany();
  };

  const link = async (
    setN: number,
    n: number,
    data: {
      priceUsd: string;
      autoSyncPrice?: boolean;
      isManual?: boolean;
      isActive?: boolean;
    },
  ) => {
    const mc = await prisma.masterCard.findUniqueOrThrow({
      where: {
        externalProvider_externalId: {
          externalProvider: 'FAKE',
          externalId: CARD(setN, n),
        },
      },
    });
    return prisma.product.create({
      data: {
        name: `E2E157 ${setN}-${n}`,
        slug: `${PREFIX}${randomUUID()}`,
        description: 'd',
        franchise: 'POKEMON',
        productType: 'SINGLE_CARD',
        rarity: 'COMMON',
        stock: 1,
        categoryId,
        masterCardId: mc.id,
        isManual: data.isManual ?? false,
        autoSyncPrice: data.autoSyncPrice ?? true,
        isActive: data.isActive ?? true,
        priceUsd: data.priceUsd,
      },
    });
  };

  const price = async (id: string) =>
    Number(
      (await prisma.product.findUniqueOrThrow({ where: { id } })).priceUsd,
    );

  beforeEach(async () => {
    fake = new FakeTcgApiClient();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TCG_API_CLIENT)
      .useValue(fake)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    ingest = app.get(TcgIngestService);
    nightly = app.get(TcgNightlySyncService);
    categoryId = (await prisma.category.findFirstOrThrow()).id;
    await clean();
    const foreign = await prisma.tcgIngestCursor.findMany({
      where: { status: 'DONE', gameSlug: { not: GAME } },
      select: { id: true },
    });
    parkedCursorIds = foreign.map((c) => c.id);
    await prisma.tcgIngestCursor.updateMany({
      where: { id: { in: parkedCursorIds } },
      data: { status: 'PENDING' },
    });
    await ingest.run({ games: [GAME] });
    fake.reset();
    await prisma.tcgSyncRun.deleteMany();
    for (const k of ENVS) delete process.env[k];
  });

  afterEach(async () => {
    for (const k of ENVS) delete process.env[k];
    await clean();
    await prisma.tcgIngestCursor.updateMany({
      where: { id: { in: parkedCursorIds } },
      data: { status: 'DONE' },
    });
    await app.close();
  });

  it('AC1: disabled (default) => cron does nothing; no request, no run row', async () => {
    await app.get(TcgNightlySyncService).handleCron();
    expect(fake.calls).toEqual([]);
    expect(await prisma.tcgSyncRun.count()).toBe(0);
    process.env.TCG_NIGHTLY_SYNC_ENABLED = 'false';
    await nightly.handleCron();
    expect(fake.calls).toEqual([]);
  });

  it('AC2: cron registered as tcg-nightly-sync (0 3 * * * UTC); enabled cron runs', async () => {
    const job = app.get(SchedulerRegistry).getCronJob('tcg-nightly-sync');
    expect(job.cronTime.source).toBe('0 3 * * *');
    expect(job.cronTime.timeZone).toBe('UTC');
    process.env.TCG_NIGHTLY_SYNC_ENABLED = 'true';
    await nightly.handleCron();
    expect(await prisma.tcgSyncRun.count({ where: { kind: 'NIGHTLY' } })).toBe(
      1,
    );
  });

  it('AC3/4/8/9/11: updates auto-sync products only, null price keeps price, audits variations', async () => {
    const big = await link(1, 1, { priceUsd: '1.00' });
    const small = await link(3, 4, { priceUsd: '1.00', isActive: false });
    const off = await link(1, 2, { priceUsd: '3.33', autoSyncPrice: false });
    const manualFlag = await link(1, 3, { priceUsd: '4.44', isManual: true });
    const priceless = await link(1, 11, { priceUsd: '7.77' });
    const category = categoryId;
    const noLink = await prisma.product.create({
      data: {
        name: 'E2E157 manual',
        slug: `${PREFIX}manual`,
        description: 'd',
        franchise: 'POKEMON',
        productType: 'SINGLE_CARD',
        rarity: 'COMMON',
        stock: 1,
        categoryId: category,
        priceUsd: '9.99',
      },
    });
    // 4: fake hook => big jump on `big`; `small` moves ~11%.
    fake.setPrice(CARD(1, 1), 10);
    const smallMaster = await prisma.masterCard.findUniqueOrThrow({
      where: {
        externalProvider_externalId: {
          externalProvider: 'FAKE',
          externalId: CARD(3, 4),
        },
      },
    });
    const target = Number(smallMaster.marketPriceUsd);
    await prisma.product.update({
      where: { id: small.id },
      data: { priceUsd: (target * 0.9).toFixed(2) },
    });
    fake.setPrice(CARD(3, 4), target);

    const res = await nightly.runNightlySync();
    expect(res.status).toBe('SUCCEEDED');
    expect(await price(big.id)).toBe(10);
    expect(await price(small.id)).toBe(target);
    expect(await price(off.id)).toBe(3.33);
    expect(await price(manualFlag.id)).toBe(4.44);
    expect(await price(priceless.id)).toBe(7.77); // null API price
    expect(await price(noLink.id)).toBe(9.99);
    const synced = await prisma.product.findUniqueOrThrow({
      where: { id: big.id },
    });
    expect(synced.lastMarketSyncAt).not.toBeNull();
    const mc = await prisma.masterCard.findUniqueOrThrow({
      where: { id: synced.masterCardId! },
    });
    expect(Number(mc.marketPriceUsd)).toBe(10);
    expect(
      (await prisma.product.findUniqueOrThrow({ where: { id: off.id } }))
        .lastMarketSyncAt,
    ).toBeNull();

    // AC8/9: audit row.
    const run = await prisma.tcgSyncRun.findFirstOrThrow();
    expect(run).toMatchObject({
      kind: 'NIGHTLY',
      status: 'SUCCEEDED',
      requestsUsed: 3,
      errorCount: 0,
      quotaExhausted: false,
    });
    expect(run.finishedAt).not.toBeNull();
    expect(run.cardsSynced).toBeGreaterThan(0);
    expect(run.productsUpdated).toBe(2);
    const variations = run.bigVariations as {
      productId: string;
      oldPrice: number;
      newPrice: number;
      pct: number;
    }[];
    expect(variations).toEqual([
      { productId: big.id, oldPrice: 1, newPrice: 10, pct: 900 },
    ]);
  });

  it('AC5: linked sets first by lastPriceSyncAt ASC NULLS FIRST, then other DONE sets; cursor updated per set', async () => {
    await link(1, 1, { priceUsd: '1.00' });
    await link(3, 1, { priceUsd: '1.00' });
    const at = (y: number) => new Date(`${y}-01-01T00:00:00Z`);
    const cur = (n: number, d: Date | null) =>
      prisma.tcgIngestCursor.update({
        where: { gameSlug_setId: { gameSlug: GAME, setId: SET(n) } },
        data: { lastPriceSyncAt: d },
      });
    await cur(1, at(2022));
    await cur(3, null); // NULLS FIRST
    await cur(2, at(2019)); // oldest but unlinked => last
    await nightly.runNightlySync();
    expect(fake.calls).toEqual([
      `listSetCards:${SET(3)}:1`,
      `listSetCards:${SET(1)}:1`,
      `listSetCards:${SET(2)}:1`,
    ]);
    for (const n of [1, 2, 3]) {
      const c = await prisma.tcgIngestCursor.findUniqueOrThrow({
        where: { gameSlug_setId: { gameSlug: GAME, setId: SET(n) } },
      });
      expect(c.lastPriceSyncAt!.getTime()).toBeGreaterThan(Date.now() - 60_000);
    }
  });

  it('AC6: budget stops the run (PARTIAL + quotaExhausted); next run continues with remaining sets', async () => {
    await link(1, 1, { priceUsd: '1.00' });
    await link(2, 1, { priceUsd: '1.00' });
    await link(3, 1, { priceUsd: '1.00' });
    const past = (n: number, y: number) =>
      prisma.tcgIngestCursor.update({
        where: { gameSlug_setId: { gameSlug: GAME, setId: SET(n) } },
        data: { lastPriceSyncAt: new Date(`${y}-01-01T00:00:00Z`) },
      });
    await past(1, 2020);
    await past(2, 2021);
    await past(3, 2022);
    process.env.TCG_NIGHTLY_MAX_REQUESTS = '2';
    const first = await nightly.runNightlySync();
    expect(first).toMatchObject({
      status: 'PARTIAL',
      quotaExhausted: true,
      requests: 2,
      setsCompleted: 2,
    });
    fake.calls.length = 0;
    const second = await nightly.runNightlySync();
    expect(fake.calls[0]).toBe(`listSetCards:${SET(3)}:1`);
    expect(second.requests).toBe(2);
    const rows = await prisma.tcgSyncRun.findMany({
      orderBy: { startedAt: 'asc' },
    });
    expect(rows.map((r) => r.status)).toEqual(['PARTIAL', 'PARTIAL']);
    expect(rows[0].quotaExhausted).toBe(true);
  });

  it('AC6: HTTP 429 and the quota reserve stop cleanly, keeping applied batches', async () => {
    const p = await link(1, 1, { priceUsd: '1.00' });
    await link(2, 1, { priceUsd: '1.00' });
    await prisma.tcgIngestCursor.update({
      where: { gameSlug_setId: { gameSlug: GAME, setId: SET(1) } },
      data: { lastPriceSyncAt: new Date('2020-01-01T00:00:00Z') },
    });
    fake.setPrice(CARD(1, 1), 12.34);
    fake.setQuota(1); // 2nd request => 429
    const res = await nightly.runNightlySync();
    expect(res).toMatchObject({ status: 'PARTIAL', quotaExhausted: true });
    expect(await price(p.id)).toBe(12.34);

    fake.reset();
    process.env.TCG_REQUEST_RESERVE = '99'; // remaining 99 after 1st => stop
    const res2 = await nightly.runNightlySync();
    expect(res2).toMatchObject({
      status: 'PARTIAL',
      quotaExhausted: true,
      requests: 1,
    });
  });

  it('AC9: a mid-run failure keeps earlier batches (PARTIAL), nothing applied => FAILED', async () => {
    const p = await link(1, 1, { priceUsd: '1.00' });
    await link(2, 1, { priceUsd: '1.00' });
    await prisma.tcgIngestCursor.update({
      where: { gameSlug_setId: { gameSlug: GAME, setId: SET(1) } },
      data: { lastPriceSyncAt: new Date('2020-01-01T00:00:00Z') },
    });
    fake.setPrice(CARD(1, 1), 5.55);
    const original = fake.listSetCards.bind(fake);
    let n = 0;
    fake.listSetCards = (...args: Parameters<typeof original>) => {
      n += 1;
      if (n === 2) return Promise.reject(new Error('boom'));
      return original(...args);
    };
    const res = await nightly.runNightlySync();
    expect(res.status).toBe('PARTIAL');
    expect(res.errorCount).toBe(1);
    expect(await price(p.id)).toBe(5.55);
    const run = await prisma.tcgSyncRun.findFirstOrThrow();
    expect(run).toMatchObject({ status: 'PARTIAL', errorCount: 1 });
    expect(run.errorSummary).toContain('boom');

    await prisma.tcgSyncRun.deleteMany();
    fake.listSetCards = () => Promise.reject(new Error('down'));
    const failed = await nightly.runNightlySync();
    expect(failed.status).toBe('FAILED');
  });

  it('Story 15.8: a set failing with a non-quota error is audited, skipped and moved to the back; the others still sync', async () => {
    const a = await link(1, 1, { priceUsd: '1.00' });
    const b = await link(2, 1, { priceUsd: '1.00' });
    const c = await link(3, 1, { priceUsd: '1.00' });
    await prisma.tcgIngestCursor.update({
      where: { gameSlug_setId: { gameSlug: GAME, setId: SET(1) } },
      data: { lastPriceSyncAt: new Date('2020-01-01T00:00:00Z') },
    });
    fake.setPrice(CARD(1, 1), 5);
    fake.setPrice(CARD(2, 1), 6);
    fake.setPrice(CARD(3, 1), 7);
    const original = fake.listSetCards.bind(fake);
    fake.listSetCards = (...args: Parameters<typeof original>) =>
      args[0] === SET(1)
        ? Promise.reject(new Error('HTTP 404 set gone'))
        : original(...args);
    const res = await nightly.runNightlySync();
    expect(res).toMatchObject({ status: 'PARTIAL', errorCount: 1 });
    expect(res.errorSummary).toContain(SET(1));
    expect(res.errorSummary).toContain('404');
    expect(await price(a.id)).toBe(1);
    expect(await price(b.id)).toBe(6);
    expect(await price(c.id)).toBe(7);
    const cur = await prisma.tcgIngestCursor.findUniqueOrThrow({
      where: { gameSlug_setId: { gameSlug: GAME, setId: SET(1) } },
    });
    expect(cur.lastPriceSyncAt!.getFullYear()).toBeGreaterThanOrEqual(2026);
    const run = await prisma.tcgSyncRun.findFirstOrThrow();
    expect(run).toMatchObject({ status: 'PARTIAL', errorCount: 1 });

    // Next night the broken set is no longer first.
    fake.calls.length = 0;
    await nightly.runNightlySync();
    expect(fake.calls[0]).not.toContain(`listSetCards:${SET(1)}`);
  });

  it('Story 15.8: a linked set without cursor row is audited and skipped without requests', async () => {
    await link(1, 1, { priceUsd: '1.00' });
    const b = await link(2, 1, { priceUsd: '1.00' });
    await prisma.tcgIngestCursor.delete({
      where: { gameSlug_setId: { gameSlug: GAME, setId: SET(1) } },
    });
    fake.setPrice(CARD(2, 1), 6);
    const res = await nightly.runNightlySync();
    expect(res).toMatchObject({ status: 'PARTIAL', errorCount: 1 });
    expect(res.errorSummary).toContain('no Tcg_Ingest_Cursors row');
    expect(fake.calls.some((c) => c.includes(`listSetCards:${SET(1)}`))).toBe(
      false,
    );
    expect(await price(b.id)).toBe(6);
  });

  it('AC10: concurrent runs => exactly one proceeds; excludes the ingest; stale RUNNING recovered', async () => {
    await link(1, 1, { priceUsd: '1.00' });
    const [a, b] = await Promise.all([
      nightly.runNightlySync(),
      nightly.runNightlySync(),
    ]);
    expect([a.status, b.status].filter((s) => s === 'ALREADY_RUNNING')).toEqual(
      ['ALREADY_RUNNING'],
    );
    expect(await prisma.tcgSyncRun.count({ where: { kind: 'NIGHTLY' } })).toBe(
      1,
    );
    expect([a, b].find((r) => r.status === 'ALREADY_RUNNING')!.requests).toBe(
      0,
    );

    // The CLI/ingest holds the lock => nightly makes no request.
    await prisma.tcgSyncRun.deleteMany();
    fake.calls.length = 0;
    await prisma.tcgSyncRun.create({ data: { kind: 'INGEST' } });
    const blocked = await nightly.runNightlySync();
    expect(blocked.status).toBe('ALREADY_RUNNING');
    expect(fake.calls).toEqual([]);

    // ...and the other way around.
    await prisma.tcgSyncRun.deleteMany();
    await prisma.tcgSyncRun.create({ data: { kind: 'NIGHTLY' } });
    expect((await ingest.run({ games: [GAME] })).alreadyRunning).toBe(true);

    // Stale RUNNING (> 2 h) is recovered as FAILED.
    await prisma.tcgSyncRun.updateMany({
      data: { startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000) },
    });
    const ok = await nightly.runNightlySync();
    expect(ok.status).toBe('SUCCEEDED');
    const stale = await prisma.tcgSyncRun.findMany({
      where: { status: 'FAILED' },
    });
    expect(stale).toHaveLength(1);
  });

  it('AC11: only rows of the active provider are touched', async () => {
    const mine = await link(1, 1, { priceUsd: '1.00' });
    const mc = await prisma.masterCard.findUniqueOrThrow({
      where: { id: mine.masterCardId! },
    });
    const other = await prisma.masterCard.create({
      data: {
        externalProvider: 'TCGAPI_DEV',
        externalId: mc.externalId,
        name: 'real',
        cleanName: 'real',
        searchText: 'real',
        franchise: 'POKEMON',
        gameSlug: GAME,
        setId: mc.setId,
        setName: mc.setName,
        marketPriceUsd: '55.00',
        rawApiData: {},
      },
    });
    const real = await prisma.product.create({
      data: {
        name: 'E2E157 real',
        slug: `${PREFIX}real`,
        description: 'd',
        franchise: 'POKEMON',
        productType: 'SINGLE_CARD',
        rarity: 'COMMON',
        stock: 1,
        categoryId,
        masterCardId: other.id,
        isManual: false,
        autoSyncPrice: true,
        priceUsd: '2.00',
      },
    });
    fake.setPrice(CARD(1, 1), 8);
    await nightly.runNightlySync();
    expect(await price(mine.id)).toBe(8);
    expect(await price(real.id)).toBe(2);
    expect(
      Number(
        (await prisma.masterCard.findUniqueOrThrow({ where: { id: other.id } }))
          .marketPriceUsd,
      ),
    ).toBe(55);
  });

  it('AC12: OrderLine snapshots of existing orders are untouched', async () => {
    const p = await link(1, 1, { priceUsd: '1.00' });
    const order = await prisma.order.create({
      data: {
        status: 'PENDING_VERIFICATION',
        paymentRail: 'PAGO_MOVIL',
        fulfillmentType: 'PICKUP',
        recipientName: 'E2E157 buyer',
        recipientPhone: '0412-0000000',
        totalUsd: '1.00',
        accessTokenHash: randomUUID(),
        lines: {
          create: [
            {
              productId: p.id,
              productName: p.name,
              unitPriceUsd: '1.00',
              quantity: 1,
              lineTotalUsd: '1.00',
            },
          ],
        },
      },
    });
    fake.setPrice(CARD(1, 1), 20);
    await nightly.runNightlySync();
    expect(await price(p.id)).toBe(20);
    const line = await prisma.orderLine.findFirstOrThrow({
      where: { orderId: order.id },
    });
    expect(Number(line.unitPriceUsd)).toBe(1);
    expect(Number(line.lineTotalUsd)).toBe(1);
  });
});
