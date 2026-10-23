import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { TCG_API_CLIENT } from '../tcg/tcg-api-client.interface.js';
import { TcgIngestService } from '../tcg/tcg-ingest.service.js';
import { TcgSyncRunService } from '../tcg/tcg-sync-run.service.js';
import { AdminTcgService } from './admin-tcg.service.js';

const card = (id: string, price: string | null) => ({
  id,
  externalId: `x-${id}`,
  name: `Card ${id}`,
  franchise: 'POKEMON',
  setId: 's1',
  setName: 'Set One',
  cardNumber: '1/10',
  rarity: 'Rare',
  printing: 'Foil',
  editionLanguage: 'EN',
  imageSmall: null,
  imageLarge: null,
  marketPriceUsd: price,
});

/** Story 15.5 (FR-68, AD-56). Full-stack coverage: test/admin-tcg-master-cards.e2e-spec.ts. */
describe('AdminTcgService', () => {
  let service: AdminTcgService;
  let provider = 'TCGAPI_DEV';
  let allowFake: string | undefined;
  const ingest = { startRun: vi.fn(), execute: vi.fn() };
  const syncRuns = { finish: vi.fn() };
  let prisma: {
    tcgSyncRun: { findUnique: ReturnType<typeof vi.fn> };
    masterCard: {
      count: ReturnType<typeof vi.fn>;
      findMany: ReturnType<typeof vi.fn>;
    };
    product: { groupBy: ReturnType<typeof vi.fn> };
  };

  beforeEach(async () => {
    provider = 'TCGAPI_DEV';
    allowFake = undefined;
    ingest.startRun.mockReset();
    ingest.execute.mockReset();
    syncRuns.finish.mockReset().mockResolvedValue(undefined);
    prisma = {
      tcgSyncRun: { findUnique: vi.fn() },
      masterCard: { count: vi.fn(), findMany: vi.fn() },
      product: { groupBy: vi.fn() },
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminTcgService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: () => allowFake } },
        { provide: TcgIngestService, useValue: ingest },
        { provide: TcgSyncRunService, useValue: syncRuns },
        {
          provide: TCG_API_CLIENT,
          useValue: {
            get provider() {
              return provider;
            },
          },
        },
      ],
    }).compile();
    service = module.get(AdminTcgService);
  });

  it('escapes ILIKE wildcards in set but not in the exact setId', async () => {
    prisma.masterCard.count.mockResolvedValue(0);
    prisma.masterCard.findMany.mockResolvedValue([]);
    await service.searchMasterCards({ set: '50%_x\\', page: 1, limit: 20 });
    const arg = prisma.masterCard.findMany.mock.calls[0][0] as {
      where: { AND: unknown[] };
    };
    expect(arg.where.AND).toEqual([
      {
        OR: [
          { setId: '50%_x\\' },
          { setName: { contains: '50\\%\\_x\\\\', mode: 'insensitive' } },
        ],
      },
    ]);
  });

  it('builds one AND clause per normalized token plus franchise and set', async () => {
    prisma.masterCard.count.mockResolvedValue(0);
    prisma.masterCard.findMany.mockResolvedValue([]);
    await service.searchMasterCards({
      q: 'Pikáchu  199/165',
      franchise: 'POKEMON',
      set: 'sv3',
      page: 1,
      limit: 20,
    });
    const arg = prisma.masterCard.findMany.mock.calls[0][0] as {
      where: Record<string, unknown>;
      orderBy: unknown;
    };
    expect(arg.where.franchise).toBe('POKEMON');
    expect(arg.where.AND).toEqual([
      { searchText: { contains: 'pikachu' } },
      { searchText: { contains: '199' } },
      { searchText: { contains: '165' } },
      {
        OR: [
          { setId: 'sv3' },
          { setName: { contains: 'sv3', mode: 'insensitive' } },
        ],
      },
    ]);
    expect(arg.orderBy).toEqual([
      { marketPriceUsd: { sort: 'desc', nulls: 'last' } },
      { name: 'asc' },
      { id: 'asc' },
    ]);
    expect(prisma.product.groupBy).not.toHaveBeenCalled();
  });

  it('maps price/inventory with a single groupBy and builds meta', async () => {
    prisma.masterCard.count.mockResolvedValue(45);
    prisma.masterCard.findMany.mockResolvedValue([
      card('a', '12.50'),
      card('b', null),
    ]);
    prisma.product.groupBy.mockResolvedValue([
      { masterCardId: 'a', _count: { _all: 2 }, _sum: { stock: 7 } },
    ]);
    const res = await service.searchMasterCards({ page: 2, limit: 20 });
    expect(prisma.product.groupBy).toHaveBeenCalledTimes(1);
    expect(res.data[0]).toMatchObject({
      apiPriceUsd: 12.5,
      printing: 'Foil',
      alreadyInInventory: true,
      currentInventoryStock: 7,
    });
    expect(res.data[1]).toMatchObject({
      apiPriceUsd: null,
      alreadyInInventory: false,
      currentInventoryStock: 0,
    });
    expect(res.meta).toEqual({
      page: 2,
      limit: 20,
      total: 45,
      totalPages: 3,
      hasNextPage: true,
      hasPreviousPage: true,
    });
    expect(prisma.masterCard.findMany.mock.calls[0][0]).toMatchObject({
      skip: 20,
      take: 20,
    });
  });

  describe('startIngest (Story 15.9)', () => {
    const started = {
      opts: {},
      runId: 'run-1',
      alreadyRunning: false,
    };

    it('503 TCG_API_NOT_CONFIGURED on the fake client, before touching the lock', async () => {
      provider = 'FAKE';
      await expect(service.startIngest({})).rejects.toMatchObject({
        status: 503,
        response: { errorCode: 'TCG_API_NOT_CONFIGURED' },
      });
      expect(ingest.startRun).not.toHaveBeenCalled();
    });

    it('the test-only env lets the fake client through', async () => {
      provider = 'FAKE';
      allowFake = 'true';
      ingest.startRun.mockResolvedValue(started);
      ingest.execute.mockResolvedValue({});
      await expect(service.startIngest({})).resolves.toEqual({
        runId: 'run-1',
        status: 'RUNNING',
      });
    });

    it('forwards only the given options, never dryRun=true', async () => {
      ingest.startRun.mockResolvedValue(started);
      ingest.execute.mockResolvedValue({});
      await service.startIngest({ games: ['pokemon'], maxRequests: 5 });
      expect(ingest.startRun).toHaveBeenCalledWith({
        games: ['pokemon'],
        maxRequests: 5,
        maxCards: 10,
        dryRun: false,
      });
      expect(ingest.execute).toHaveBeenCalledWith(started);
    });

    it('409 TCG_SYNC_ALREADY_RUNNING with the active run id', async () => {
      ingest.startRun.mockResolvedValue({
        opts: {},
        runId: null,
        alreadyRunning: true,
        activeRunId: 'active-1',
      });
      await expect(service.startIngest({})).rejects.toMatchObject({
        status: 409,
        response: {
          errorCode: 'TCG_SYNC_ALREADY_RUNNING',
          details: { runId: 'active-1' },
        },
      });
      expect(ingest.execute).not.toHaveBeenCalled();
    });

    it('a crash of the background job marks the row FAILED and never rejects', async () => {
      ingest.startRun.mockResolvedValue(started);
      ingest.execute.mockRejectedValue(new Error('boom'));
      await service.startIngest({});
      await vi.waitFor(() => expect(syncRuns.finish).toHaveBeenCalled());
      expect(syncRuns.finish).toHaveBeenCalledWith(
        'run-1',
        expect.objectContaining({
          status: 'FAILED',
          errorSummary: 'Error: boom',
        }),
      );
    });
  });

  it('getRun maps quotaRemaining from the summary and 404s when missing', async () => {
    prisma.tcgSyncRun.findUnique.mockResolvedValueOnce({
      id: 'r',
      kind: 'INGEST',
      status: 'PARTIAL',
      startedAt: new Date(0),
      finishedAt: new Date(1),
      requestsUsed: 3,
      errorSummary: null,
      summary: { created: 1, quotaRemaining: 42 },
    });
    await expect(service.getRun('r')).resolves.toMatchObject({
      id: 'r',
      quotaRemaining: 42,
      requestsUsed: 3,
    });
    prisma.tcgSyncRun.findUnique.mockResolvedValueOnce(null);
    await expect(service.getRun('x')).rejects.toMatchObject({ status: 404 });
  });
});
