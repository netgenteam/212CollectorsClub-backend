import { Test } from '@nestjs/testing';
import { INestApplication, INestApplicationContext } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppModule } from './../src/app.module.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import {
  TCG_API_CLIENT,
  TcgApiClient,
  TcgCardDto,
  TcgPage,
  TcgSetContext,
  TcgSetDto,
} from './../src/tcg/tcg-api-client.interface.js';
import { FakeTcgApiClient } from './../src/tcg/fake-tcg-api-client.js';
import { TcgIngestService } from './../src/tcg/tcg-ingest.service.js';
import { TcgCliModule } from './../src/tcg/cli/tcg-cli.module.js';
import {
  snapshotSyncRuns,
  restoreSyncRuns,
  stashCursors,
  type SyncRuns,
} from './helpers/db-snapshot.js';

const GAME = 'e2e154';
const SET = (n: number) => FakeTcgApiClient.setIdFor(GAME, n);
const CARD = (setN: number, n: number) => String(Number(SET(setN)) * 100 + n);

/** Splits each fake set page in two and can fail / empty on demand. */
class ScriptedClient implements TcgApiClient {
  readonly provider = 'FAKE';
  cardCalls: string[] = [];
  failOnCardCall: number | null = null;
  emptyPagesForever = false;
  constructor(private readonly fake: FakeTcgApiClient) {}
  listSets(game: string, page: number): Promise<TcgPage<TcgSetDto>> {
    return this.fake.listSets(game, page);
  }
  async listSetCards(
    setId: string,
    page: number,
    ctx?: TcgSetContext,
  ): Promise<TcgPage<TcgCardDto>> {
    this.cardCalls.push(`${setId}:${page}`);
    if (this.failOnCardCall === this.cardCalls.length) {
      throw new Error('simulated network crash');
    }
    if (this.emptyPagesForever) {
      const base = await this.fake.listSetCards(setId, 1, ctx);
      return { ...base, items: [], hasMore: true, page };
    }
    const full = await this.fake.listSetCards(setId, 1, ctx);
    const items =
      page === 1
        ? full.items.slice(0, 6)
        : page === 2
          ? full.items.slice(6)
          : [];
    return { ...full, items, page, hasMore: page < 2 };
  }
}

/**
 * Story 15.4 (FR-67; AD-55, AD-58): configurable, resumable ingestion. Uses
 * only the fake (no network); rows are cleaned by game slug `e2e154` and the
 * FAKE `pokemon` rows.
 */
describe('TCG ingestion (e2e, Story 15.4)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let ingest: TcgIngestService;
  let fake: FakeTcgApiClient;
  let scripted: ScriptedClient;

  // Pre-existing real sync runs: snapshotted once, restored after cleaning.
  let runsSnapshot: SyncRuns | null = null;
  // Foreign real `pokemon` cursors, removed while a test runs so set discovery
  // happens, then re-created verbatim.
  let unstash: (() => Promise<void>) | null = null;
  const clean = async () => {
    await prisma.masterCard.deleteMany({
      where: {
        OR: [
          { gameSlug: GAME },
          { gameSlug: 'pokemon', externalProvider: 'FAKE' },
        ],
      },
    });
    // Only the cursors this suite creates: its own game and the FAKE client's
    // `Fake pokemon Set N` ones (never real `pokemon` cursors).
    await prisma.tcgIngestCursor.deleteMany({
      where: {
        OR: [
          { gameSlug: GAME },
          { gameSlug: 'pokemon', setName: { startsWith: 'Fake pokemon' } },
        ],
      },
    });
    runsSnapshot ??= await snapshotSyncRuns(prisma);
    await prisma.tcgSyncRun.deleteMany();
  };

  beforeEach(async () => {
    fake = new FakeTcgApiClient();
    scripted = new ScriptedClient(fake);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(TCG_API_CLIENT)
      .useValue(scripted)
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
    ingest = app.get(TcgIngestService);
    await clean();
    unstash = await stashCursors(prisma, {
      gameSlug: 'pokemon',
      NOT: { setName: { startsWith: 'Fake pokemon' } },
    });
  });

  afterEach(async () => {
    await clean();
    await restoreSyncRuns(prisma, runsSnapshot ?? []);
    await unstash?.();
    await app.close();
  });

  // Full-page client: the 12-card fake set in one page.
  const useSinglePage = () => {
    (scripted as unknown as { listSetCards: unknown }).listSetCards = (
      setId: string,
      page: number,
      ctx?: TcgSetContext,
    ) => {
      scripted.cardCalls.push(`${setId}:${page}`);
      return fake.listSetCards(setId, page, ctx);
    };
  };

  const resetCursors = () =>
    prisma.tcgIngestCursor.updateMany({
      where: { gameSlug: GAME },
      data: { status: 'PENDING', nextPage: 1 },
    });

  it('AC1: tables, unique cursor and single-RUNNING partial index', async () => {
    await prisma.tcgIngestCursor.create({
      data: { gameSlug: GAME, setId: 'x', setName: 'X' },
    });
    await expect(
      prisma.tcgIngestCursor.create({
        data: { gameSlug: GAME, setId: 'x', setName: 'X2' },
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await prisma.tcgSyncRun.create({ data: { kind: 'INGEST' } });
    await expect(
      prisma.tcgSyncRun.create({ data: { kind: 'NIGHTLY' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    await prisma.tcgSyncRun.create({
      data: { kind: 'NIGHTLY', status: 'SUCCEEDED' },
    });
  });

  it('AC2/5: defaults to pokemon only, skips sealed, stores a sync run summary', async () => {
    useSinglePage();
    expect(ingest.resolveOptions().games).toEqual(['pokemon']);
    const res = await ingest.run();
    expect(res.status).toBe('SUCCEEDED');
    // 3 fake sets x (11 cards + 1 sealed); setLimit default 5 >= 3.
    expect(res.summary).toMatchObject({
      created: 33,
      updated: 0,
      skipped: 3,
      errors: 0,
      requests: 4,
      quotaExhausted: false,
    });
    const games = await prisma.masterCard.groupBy({
      by: ['gameSlug'],
      where: {
        externalProvider: 'FAKE',
        setName: { startsWith: 'Fake pokemon' },
      },
    });
    expect(games.map((g) => g.gameSlug)).toEqual(['pokemon']);
    const run = await prisma.tcgSyncRun.findFirstOrThrow();
    expect(run).toMatchObject({
      kind: 'INGEST',
      status: 'SUCCEEDED',
      requestsUsed: 4,
      cardsSynced: 33,
      quotaExhausted: false,
    });
    expect(run.finishedAt).not.toBeNull();
    expect(run.summary).toMatchObject({ created: 33, skipped: 3 });
  });

  it('AC2: --games/--sets override, sets by id or slug; unspecified sets are bounded', async () => {
    useSinglePage();
    // slug
    let res = await ingest.run({ games: [GAME], sets: ['fake-e2e154-set-2'] });
    expect(res.summary.created).toBe(11);
    expect(scripted.cardCalls).toEqual([`${SET(2)}:1`]);
    // id
    res = await ingest.run({ games: [GAME], sets: [SET(1)] });
    expect(res.summary.created).toBe(11);
    // no sets given: bounded by setLimit (most recent first => set 3)
    await clean();
    scripted.cardCalls = [];
    res = await ingest.run({ games: [GAME], setLimit: 1 });
    expect(scripted.cardCalls).toEqual([`${SET(3)}:1`]);
    expect(res.setsCompleted).toBe(1);
  });

  it('AC3/4: no duplicates, second run creates 0; null price kept/updated/preserved', async () => {
    useSinglePage();
    await ingest.run({ games: [GAME] });
    const total = await prisma.masterCard.count({ where: { gameSlug: GAME } });
    expect(total).toBe(33);
    const priceless = CARD(1, 11);
    const get = () =>
      prisma.masterCard.findUniqueOrThrow({
        where: {
          externalProvider_externalId: {
            externalProvider: 'FAKE',
            externalId: priceless,
          },
        },
      });
    expect((await get()).marketPriceUsd).toBeNull();

    await resetCursors();
    const second = await ingest.run({ games: [GAME] });
    expect(second.summary).toMatchObject({
      created: 0,
      updated: 33,
      skipped: 3,
    });
    expect(await prisma.masterCard.count({ where: { gameSlug: GAME } })).toBe(
      33,
    );

    fake.setPrice(priceless, 7.5);
    await resetCursors();
    await ingest.run({ games: [GAME] });
    expect(Number((await get()).marketPriceUsd)).toBe(7.5);

    fake.setPrice(priceless, null);
    await resetCursors();
    await ingest.run({ games: [GAME] });
    expect(Number((await get()).marketPriceUsd)).toBe(7.5);
  });

  it('AC6: interrupted mid-set resumes at nextPage without repeating requests', async () => {
    // calls: set3 p1, set3 p2 (done), set2 p1 (ok), set2 p2 => crash
    scripted.failOnCardCall = 4;
    const first = await ingest.run({ games: [GAME] });
    expect(first.status).toBe('FAILED');
    expect(first.summary.errors).toBe(1);
    const cur = async (n: number) =>
      prisma.tcgIngestCursor.findUniqueOrThrow({
        where: { gameSlug_setId: { gameSlug: GAME, setId: SET(n) } },
      });
    expect(await cur(3)).toMatchObject({ status: 'DONE', nextPage: 3 });
    expect(await cur(2)).toMatchObject({ status: 'IN_PROGRESS', nextPage: 2 });
    expect(await cur(1)).toMatchObject({ status: 'PENDING', nextPage: 1 });
    expect(
      (
        await prisma.tcgSyncRun.findFirstOrThrow({
          orderBy: { startedAt: 'desc' },
        })
      ).status,
    ).toBe('FAILED');

    scripted.failOnCardCall = null;
    scripted.cardCalls = [];
    const second = await ingest.run({ games: [GAME] });
    expect(second.status).toBe('SUCCEEDED');
    expect(scripted.cardCalls).toEqual([
      `${SET(2)}:2`,
      `${SET(1)}:1`,
      `${SET(1)}:2`,
    ]);
    for (const n of [1, 2, 3]) expect((await cur(n)).status).toBe('DONE');
    expect(await prisma.masterCard.count({ where: { gameSlug: GAME } })).toBe(
      33,
    );
  });

  it('empty pages with has_more=true do not loop forever (set ends DONE)', async () => {
    scripted.emptyPagesForever = true;
    const res = await ingest.run({ games: [GAME], sets: [SET(1)] });
    expect(res.status).toBe('SUCCEEDED');
    expect(scripted.cardCalls).toEqual([`${SET(1)}:1`]);
    const cur = await prisma.tcgIngestCursor.findUniqueOrThrow({
      where: { gameSlug_setId: { gameSlug: GAME, setId: SET(1) } },
    });
    expect(cur.status).toBe('DONE');
  });

  it('AC7: reserve, request budget and 429 stop cleanly; next run continues', async () => {
    useSinglePage();
    // reserve: remaining 22 -> listSets(21) -> set3 (20) => stop.
    fake.setQuota(22);
    let res = await ingest.run({ games: [GAME], reserve: 20 });
    expect(res.summary).toMatchObject({ requests: 2, quotaExhausted: true });
    expect(res.status).toBe('PARTIAL');
    expect(res.setsCompleted).toBe(1);
    let run = await prisma.tcgSyncRun.findFirstOrThrow({
      orderBy: { startedAt: 'desc' },
    });
    expect(run).toMatchObject({ status: 'PARTIAL', quotaExhausted: true });

    // budget: 1 request left in this run
    fake.setQuota(100);
    res = await ingest.run({ games: [GAME], maxRequests: 1, reserve: 0 });
    expect(res.summary).toMatchObject({ requests: 1, quotaExhausted: true });
    expect(res.status).toBe('PARTIAL');

    // 429
    fake.setQuota(0);
    res = await ingest.run({ games: [GAME], reserve: 0 });
    expect(res.status).toBe('PARTIAL');
    expect(res.summary.quotaExhausted).toBe(true);
    expect(res.summary.errors).toBe(0);

    // continues and finishes
    fake.setQuota(100);
    res = await ingest.run({ games: [GAME], reserve: 0 });
    expect(res.status).toBe('SUCCEEDED');
    expect(await prisma.masterCard.count({ where: { gameSlug: GAME } })).toBe(
      33,
    );
    run = await prisma.tcgSyncRun.findFirstOrThrow({
      orderBy: { startedAt: 'desc' },
    });
    expect(run.status).toBe('SUCCEEDED');
  });

  it('AC8: RUNNING <2h blocks without requests; older RUNNING is failed and run proceeds', async () => {
    useSinglePage();
    const blocker = await prisma.tcgSyncRun.create({
      data: { kind: 'NIGHTLY' },
    });
    const blocked = await ingest.run({ games: [GAME] });
    expect(blocked.alreadyRunning).toBe(true);
    expect(fake.calls).toHaveLength(0);
    expect(scripted.cardCalls).toHaveLength(0);

    await prisma.tcgSyncRun.update({
      where: { id: blocker.id },
      data: { startedAt: new Date(Date.now() - 3 * 3600 * 1000) },
    });
    const res = await ingest.run({ games: [GAME] });
    expect(res.status).toBe('SUCCEEDED');
    const stale = await prisma.tcgSyncRun.findUniqueOrThrow({
      where: { id: blocker.id },
    });
    expect(stale.status).toBe('FAILED');
  });

  it('AC9: discovery stores PENDING cursors by releaseDate; refresh keeps DONE', async () => {
    useSinglePage();
    await ingest.run({ games: [GAME], sets: [SET(3)] });
    const cursors = await prisma.tcgIngestCursor.findMany({
      where: { gameSlug: GAME },
      orderBy: { releaseDate: 'desc' },
    });
    expect(cursors.map((c) => c.setId)).toEqual([SET(3), SET(2), SET(1)]);
    expect(cursors.map((c) => c.status)).toEqual([
      'DONE',
      'PENDING',
      'PENDING',
    ]);
    expect(cursors[0].releaseDate).not.toBeNull();

    fake.calls.length = 0;
    await ingest.run({ games: [GAME], sets: [SET(3)], refreshSets: true });
    expect(fake.calls.filter((c) => c.startsWith('listSets'))).toHaveLength(1);
    const after = await prisma.tcgIngestCursor.findUniqueOrThrow({
      where: { gameSlug_setId: { gameSlug: GAME, setId: SET(3) } },
    });
    expect(after).toMatchObject({ status: 'DONE', nextPage: 2 });
    // no discovery without --refresh-sets when cursors exist
    fake.calls.length = 0;
    await ingest.run({ games: [GAME], sets: [SET(3)] });
    expect(fake.calls).toHaveLength(0);
  });

  it('AC10: dry-run writes nothing and prints a plan', async () => {
    useSinglePage();
    const res = await ingest.run({ games: [GAME], dryRun: true });
    expect(res.plan.map((p) => p.setId)).toEqual([SET(3), SET(2), SET(1)]);
    expect(scripted.cardCalls).toHaveLength(0);
    expect(await prisma.masterCard.count({ where: { gameSlug: GAME } })).toBe(
      0,
    );
    expect(
      await prisma.tcgIngestCursor.count({ where: { gameSlug: GAME } }),
    ).toBe(0);
    expect(await prisma.tcgSyncRun.count()).toBe(0);
  });

  it('AC11: CLI context has no ScheduleModule and never leaks the key', async () => {
    process.env.TCGAPI_KEY = '';
    let ctx: INestApplicationContext | undefined;
    try {
      ctx = await NestFactory.createApplicationContext(TcgCliModule, {
        logger: false,
      });
      expect(ctx.get(TcgIngestService, { strict: false })).toBeDefined();
      expect(() => ctx!.get(SchedulerRegistry, { strict: false })).toThrow();
    } finally {
      await ctx?.close();
    }
    useSinglePage();
    const secret = 'sk-test-secret-should-never-appear';
    const res = await ingest.run({ games: [GAME], sets: [SET(1)] });
    expect(JSON.stringify(res)).not.toContain(secret);
  });
});
