import {
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiException } from '../common/api-exception.js';
import { buildPageMeta } from '../common/pagination.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { TCG_API_CLIENT } from '../tcg/tcg-api-client.interface.js';
import type { TcgApiClient } from '../tcg/tcg-api-client.interface.js';
import { TcgIngestService } from '../tcg/tcg-ingest.service.js';
import { TcgSyncRunService } from '../tcg/tcg-sync-run.service.js';
import { normalizeSearchText } from '../tcg/tcg-mappings.js';
import type { MasterCardSearchResponseDto } from './dto/master-card-search-response.dto.js';
import type { SearchMasterCardsQueryDto } from './dto/search-master-cards-query.dto.js';
import type { StartIngestDto } from './dto/start-ingest.dto.js';
import type {
  StartIngestResponseDto,
  TcgMasterCardStatsDto,
  TcgSyncRunDto,
} from './dto/tcg-ingest-run.dto.js';

/**
 * Story 15.9 (AC4/AC10): TEST-ONLY switch. Remote ingestion refuses to run on
 * the fake client (it would fill production with fake data) unless this env is
 * exactly `true`. Only e2e specs set it; it is not documented for operators.
 */
export const TCG_ALLOW_FAKE_REMOTE_INGEST = 'TCG_ALLOW_FAKE_REMOTE_INGEST';

/**
 * Story 15.9 (AC12): temporary development/testing cap of cards stored per
 * remote run. Raise (e.g. 1000000) when going to production.
 */
export const TCG_REMOTE_INGEST_MAX_CARDS = 'TCG_REMOTE_INGEST_MAX_CARDS';
export const DEFAULT_REMOTE_INGEST_MAX_CARDS = 10;

type SyncRunRow = NonNullable<
  Awaited<ReturnType<TcgSyncRunService['findRunning']>>
>;

function toRunDto(row: SyncRunRow): TcgSyncRunDto {
  const summary = (row.summary ?? null) as Record<string, unknown> | null;
  const remaining = summary?.quotaRemaining;
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    requestsUsed: row.requestsUsed,
    quotaRemaining: typeof remaining === 'number' ? remaining : null,
    summary,
    errorSummary: row.errorSummary,
  };
}

/**
 * Story 15.5 (FR-68, AD-56). Local-DB-only search over `MasterCard` (never
 * calls tcgapi). One row per printing; `marketPriceUsd` may be null.
 */
@Injectable()
export class AdminTcgService {
  private readonly logger = new Logger(AdminTcgService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ingest: TcgIngestService,
    private readonly syncRuns: TcgSyncRunService,
    @Inject(TCG_API_CLIENT) private readonly client: TcgApiClient,
  ) {}

  /**
   * Story 15.9: registers the run, answers its id and keeps ingesting in the
   * background (the server's own `TCGAPI_KEY`; nothing secret crosses HTTP).
   */
  async startIngest(dto: StartIngestDto): Promise<StartIngestResponseDto> {
    if (
      this.client.provider === 'FAKE' &&
      this.config.get<string>(TCG_ALLOW_FAKE_REMOTE_INGEST) !== 'true'
    ) {
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        'TCG_API_NOT_CONFIGURED',
        'TCGAPI_KEY is not configured on the server (fake client in use); refusing to ingest fake data.',
      );
    }
    const envCap = Number(this.config.get<string>(TCG_REMOTE_INGEST_MAX_CARDS));
    const cap =
      Number.isInteger(envCap) && envCap > 0
        ? envCap
        : DEFAULT_REMOTE_INGEST_MAX_CARDS;
    const started = await this.ingest.startRun({
      maxCards: Math.min(dto.maxCards ?? cap, cap),
      ...(dto.games ? { games: dto.games } : {}),
      ...(dto.sets ? { sets: dto.sets } : {}),
      ...(dto.maxRequests !== undefined
        ? { maxRequests: dto.maxRequests }
        : {}),
      ...(dto.setLimit !== undefined ? { setLimit: dto.setLimit } : {}),
      ...(dto.refreshSets !== undefined
        ? { refreshSets: dto.refreshSets }
        : {}),
      dryRun: false,
    });
    if (started.alreadyRunning || !started.runId) {
      throw new ApiException(
        HttpStatus.CONFLICT,
        'TCG_SYNC_ALREADY_RUNNING',
        'Another TCG sync run (ingest or nightly) is already running.',
        started.activeRunId ? { runId: started.activeRunId } : undefined,
      );
    }
    const runId = started.runId;
    void this.ingest.execute(started).catch(async (err: unknown) => {
      const message = (
        err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      ).slice(0, 500);
      this.logger.error(`Background ingest ${runId} crashed — ${message}`);
      await this.syncRuns
        .finish(runId, {
          status: 'FAILED',
          requestsUsed: 0,
          cardsSynced: 0,
          errorCount: 1,
          errorSummary: message,
          quotaExhausted: false,
        })
        .catch(() => undefined);
    });
    return { runId, status: 'RUNNING' };
  }

  async getRun(id: string): Promise<TcgSyncRunDto> {
    const row = await this.prisma.tcgSyncRun.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Sync run ${id} not found`);
    return toRunDto(row);
  }

  async getStats(): Promise<TcgMasterCardStatsDto> {
    const [totalCards, groups, last] = await Promise.all([
      this.prisma.masterCard.count(),
      this.prisma.masterCard.groupBy({
        by: ['franchise'],
        _count: { _all: true },
      }),
      this.prisma.tcgSyncRun.findFirst({ orderBy: { startedAt: 'desc' } }),
    ]);
    return {
      totalCards,
      byFranchise: Object.fromEntries(
        groups.map((g) => [g.franchise, g._count._all]),
      ),
      lastRun: last ? toRunDto(last) : null,
    };
  }

  async searchMasterCards(
    query: Readonly<SearchMasterCardsQueryDto>,
  ): Promise<MasterCardSearchResponseDto> {
    const { page, limit, franchise } = query;
    const tokens = normalizeSearchText(query.q ?? '')
      .split(' ')
      .filter(Boolean);
    const rawSet = query.set?.trim();
    // ILIKE wildcards in the user's `set` must match literally.
    const escapedSet = rawSet?.replace(/[\\%_]/g, '\\$&');

    const and: Prisma.MasterCardWhereInput[] = tokens.map((t) => ({
      searchText: { contains: t },
    }));
    if (rawSet && escapedSet) {
      and.push({
        OR: [
          { setId: rawSet },
          { setName: { contains: escapedSet, mode: 'insensitive' } },
        ],
      });
    }
    const where: Prisma.MasterCardWhereInput = {
      ...(franchise ? { franchise } : {}),
      ...(and.length ? { AND: and } : {}),
    };

    const [total, cards] = await Promise.all([
      this.prisma.masterCard.count({ where }),
      this.prisma.masterCard.findMany({
        where,
        orderBy: [
          { marketPriceUsd: { sort: 'desc', nulls: 'last' } },
          { name: 'asc' },
          { id: 'asc' },
        ],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    // A34: a single aggregate for the whole page (no N+1); includes inactive
    // products and raw stock.
    const inventory = cards.length
      ? await this.prisma.product.groupBy({
          by: ['masterCardId'],
          where: { masterCardId: { in: cards.map((c) => c.id) } },
          _count: { _all: true },
          _sum: { stock: true },
        })
      : [];
    const byCard = new Map(
      inventory.map((g) => [
        g.masterCardId,
        { count: g._count._all, stock: g._sum.stock ?? 0 },
      ]),
    );

    return {
      data: cards.map((c) => {
        const inv = byCard.get(c.id);
        return {
          id: c.id,
          externalId: c.externalId,
          name: c.name,
          franchise: c.franchise,
          setId: c.setId,
          setName: c.setName,
          cardNumber: c.cardNumber,
          rarity: c.rarity,
          printing: c.printing,
          editionLanguage: c.editionLanguage,
          imageSmall: c.imageSmall,
          imageLarge: c.imageLarge,
          apiPriceUsd:
            c.marketPriceUsd === null ? null : Number(c.marketPriceUsd),
          alreadyInInventory: (inv?.count ?? 0) > 0,
          currentInventoryStock: inv?.stock ?? 0,
        };
      }),
      meta: buildPageMeta(page, limit, total),
    };
  }
}
