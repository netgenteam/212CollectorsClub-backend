import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  TCG_API_CLIENT,
  TcgApiRateLimitError,
} from './tcg-api-client.interface.js';
import type { TcgApiClient, TcgPage } from './tcg-api-client.interface.js';
import { MasterCardUpsertService } from './master-card-upsert.service.js';
import { TcgSyncRunService } from './tcg-sync-run.service.js';

export interface IngestOptions {
  games: string[];
  /** Set ids or slugs. `null` => the `setLimit` most recent sets per game. */
  sets: string[] | null;
  maxRequests: number;
  /** Stop when `rateLimit.remaining <= reserve`. */
  reserve: number;
  dryRun: boolean;
  refreshSets: boolean;
  /** Bound used when `sets` is not given (never walks a whole game). */
  setLimit: number;
}

export interface IngestSummary {
  created: number;
  updated: number;
  skipped: number;
  errors: number;
  requests: number;
  quotaExhausted: boolean;
}

export interface IngestPlanEntry {
  gameSlug: string;
  setId: string;
  setName: string;
  nextPage: number;
  /** Rough count of card requests still needed (needs `cardCount`). */
  estimatedRequests: number | null;
}

export interface IngestResult {
  alreadyRunning: boolean;
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'ALREADY_RUNNING';
  summary: IngestSummary;
  /** Last known `X-RateLimit-Remaining` (null before any request). */
  remainingQuota: number | null;
  setsCompleted: number;
  plan: IngestPlanEntry[];
  runId: string | null;
  errorSummary: string | null;
}

export const DEFAULT_INGEST_GAMES = ['pokemon'];
export const DEFAULT_MAX_REQUESTS = 60;
export const DEFAULT_REQUEST_RESERVE = 20;
/** Assumption [Dev, Story 15.4]: without `TCG_INGEST_SETS`, 5 newest sets. */
export const DEFAULT_SET_LIMIT = 5;
const PER_PAGE = 100;
const MAX_DISCOVERY_PAGES = 50;

interface CursorLike {
  id: string | null;
  gameSlug: string;
  setId: string;
  setName: string;
  setSlug: string | null;
  releaseDate: Date | null;
  cardCount: number | null;
  nextPage: number;
  status: 'PENDING' | 'IN_PROGRESS' | 'DONE';
}

/** Internal signal: budget/reserve reached before issuing a request. */
class QuotaStop extends Error {}

interface RunState {
  summary: IngestSummary;
  remaining: number | null;
  setsCompleted: number;
  plan: IngestPlanEntry[];
  discoveredGames: Set<string>;
}

function splitList(value: string | undefined | null): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function positiveInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Story 15.4 (AD-55, FR-67): configurable, batched, resumable ingestion of
 * master cards. The cursor of a set advances only after its page is stored.
 */
@Injectable()
export class TcgIngestService {
  private readonly logger = new Logger(TcgIngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly upsert: MasterCardUpsertService,
    private readonly syncRuns: TcgSyncRunService,
    @Inject(TCG_API_CLIENT) private readonly client: TcgApiClient,
  ) {}

  /** Explicit overrides win over the `TCG_*` envs, which win over defaults. */
  resolveOptions(overrides: Partial<IngestOptions> = {}): IngestOptions {
    const games = splitList(this.config.get<string>('TCG_INGEST_GAMES'));
    const sets = splitList(this.config.get<string>('TCG_INGEST_SETS'));
    return {
      games: overrides.games?.length
        ? overrides.games
        : games.length
          ? games
          : DEFAULT_INGEST_GAMES,
      sets: overrides.sets?.length ? overrides.sets : sets.length ? sets : null,
      maxRequests:
        overrides.maxRequests ??
        positiveInt(
          this.config.get('TCG_MAX_REQUESTS_PER_RUN'),
          DEFAULT_MAX_REQUESTS,
        ),
      reserve:
        overrides.reserve ??
        positiveInt(
          this.config.get('TCG_REQUEST_RESERVE'),
          DEFAULT_REQUEST_RESERVE,
        ),
      dryRun: overrides.dryRun ?? false,
      refreshSets: overrides.refreshSets ?? false,
      setLimit:
        overrides.setLimit ??
        positiveInt(
          this.config.get('TCG_INGEST_DEFAULT_SET_LIMIT'),
          DEFAULT_SET_LIMIT,
        ),
    };
  }

  async run(overrides: Partial<IngestOptions> = {}): Promise<IngestResult> {
    const opts = this.resolveOptions(overrides);
    const state: RunState = {
      summary: {
        created: 0,
        updated: 0,
        skipped: 0,
        errors: 0,
        requests: 0,
        quotaExhausted: false,
      },
      remaining: null,
      setsCompleted: 0,
      plan: [],
      discoveredGames: new Set(),
    };

    let runId: string | null = null;
    if (!opts.dryRun) {
      const row = await this.syncRuns.tryStart('INGEST');
      if (!row) {
        this.logger.warn('Another sync run is already running — exiting.');
        return {
          alreadyRunning: true,
          status: 'ALREADY_RUNNING',
          summary: state.summary,
          remainingQuota: null,
          setsCompleted: 0,
          plan: [],
          runId: null,
          errorSummary: null,
        };
      }
      runId = row.id;
    }

    let errorSummary: string | null = null;
    try {
      for (const game of opts.games) {
        await this.processGame(game, opts, state);
      }
    } catch (err) {
      if (err instanceof QuotaStop || err instanceof TcgApiRateLimitError) {
        state.summary.quotaExhausted = true;
        this.logger.warn(
          err instanceof QuotaStop
            ? `Stopping cleanly: ${err.message}`
            : 'Stopping cleanly: tcgapi.dev answered HTTP 429',
        );
      } else {
        state.summary.errors += 1;
        errorSummary = (
          err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        ).slice(0, 500);
        this.logger.error(`Ingestion aborted — ${errorSummary}`);
      }
    }

    const status =
      state.summary.errors > 0
        ? 'FAILED'
        : state.summary.quotaExhausted
          ? 'PARTIAL'
          : 'SUCCEEDED';

    if (runId) {
      await this.syncRuns.finish(runId, {
        status,
        requestsUsed: state.summary.requests,
        cardsSynced: state.summary.created + state.summary.updated,
        errorCount: state.summary.errors,
        errorSummary,
        quotaExhausted: state.summary.quotaExhausted,
        summary: { ...state.summary },
      });
    }

    return {
      alreadyRunning: false,
      status,
      summary: state.summary,
      remainingQuota: state.remaining,
      setsCompleted: state.setsCompleted,
      plan: state.plan,
      runId,
      errorSummary,
    };
  }

  private async processGame(
    game: string,
    opts: IngestOptions,
    state: RunState,
  ): Promise<void> {
    let cursors: CursorLike[] = await this.prisma.tcgIngestCursor.findMany({
      where: { gameSlug: game },
    });
    if (cursors.length === 0 || opts.refreshSets) {
      cursors = await this.discoverSets(game, opts, state);
    }

    let selected = this.selectCursors(cursors, opts);
    if (opts.sets && !state.discoveredGames.has(game)) {
      // A requested set may be newer than the stored discovery.
      const missing = opts.sets.filter(
        (s) => !cursors.some((c) => this.matchesSet(c, s)),
      );
      if (missing.length > 0) {
        cursors = await this.discoverSets(game, opts, state);
        selected = this.selectCursors(cursors, opts);
      }
    }
    if (opts.sets) {
      const unknown = opts.sets.filter(
        (s) => !cursors.some((c) => this.matchesSet(c, s)),
      );
      if (unknown.length > 0) {
        this.logger.warn(
          `Sets not found for game "${game}": ${unknown.join(', ')}`,
        );
      }
    }

    for (const cursor of selected) {
      if (cursor.status === 'DONE') continue;
      await this.ingestSet(cursor, opts, state);
    }
  }

  private matchesSet(cursor: CursorLike, wanted: string): boolean {
    const w = wanted.toLowerCase();
    return cursor.setId === wanted || cursor.setSlug?.toLowerCase() === w;
  }

  private selectCursors(
    cursors: CursorLike[],
    opts: IngestOptions,
  ): CursorLike[] {
    const sorted = [...cursors].sort((a, b) => {
      const ta = a.releaseDate?.getTime() ?? -Infinity;
      const tb = b.releaseDate?.getTime() ?? -Infinity;
      return tb - ta || a.setId.localeCompare(b.setId);
    });
    if (opts.sets) {
      return sorted.filter((c) =>
        opts.sets!.some((s) => this.matchesSet(c, s)),
      );
    }
    return sorted.slice(0, opts.setLimit);
  }

  /**
   * `GET /sets?game=` (paginated). Cursors are written only once every page
   * was read, and existing ones keep their status/nextPage.
   */
  private async discoverSets(
    game: string,
    opts: IngestOptions,
    state: RunState,
  ): Promise<CursorLike[]> {
    state.discoveredGames.add(game);
    const found = new Map<string, CursorLike>();
    for (let page = 1; page <= MAX_DISCOVERY_PAGES; page++) {
      const res = await this.request(opts, state, () =>
        this.client.listSets(game, page),
      );
      for (const s of res.items) {
        found.set(s.externalId, {
          id: null,
          gameSlug: game,
          setId: s.externalId,
          setName: s.name,
          setSlug: s.slug,
          releaseDate: s.releaseDate ? new Date(s.releaseDate) : null,
          cardCount: s.cardCount,
          nextPage: 1,
          status: 'PENDING',
        });
      }
      if (!res.hasMore || res.items.length === 0) break;
    }

    if (opts.dryRun) {
      const existing = await this.prisma.tcgIngestCursor.findMany({
        where: { gameSlug: game },
      });
      for (const c of existing) found.set(c.setId, c);
      return [...found.values()];
    }

    await this.prisma.$transaction(
      [...found.values()].map((c) =>
        this.prisma.tcgIngestCursor.upsert({
          where: { gameSlug_setId: { gameSlug: game, setId: c.setId } },
          create: {
            gameSlug: game,
            setId: c.setId,
            setName: c.setName,
            setSlug: c.setSlug,
            releaseDate: c.releaseDate,
            cardCount: c.cardCount,
          },
          update: {
            setName: c.setName,
            setSlug: c.setSlug,
            releaseDate: c.releaseDate,
            cardCount: c.cardCount,
          },
        }),
      ),
    );
    return this.prisma.tcgIngestCursor.findMany({ where: { gameSlug: game } });
  }

  private async ingestSet(
    cursor: CursorLike,
    opts: IngestOptions,
    state: RunState,
  ): Promise<void> {
    if (opts.dryRun) {
      const remainingCards =
        cursor.cardCount === null
          ? null
          : Math.max(
              0,
              Math.ceil(cursor.cardCount / PER_PAGE) - (cursor.nextPage - 1),
            );
      state.plan.push({
        gameSlug: cursor.gameSlug,
        setId: cursor.setId,
        setName: cursor.setName,
        nextPage: cursor.nextPage,
        estimatedRequests: remainingCards,
      });
      return;
    }

    let page = cursor.nextPage;
    for (;;) {
      const res = await this.request(opts, state, () =>
        this.client.listSetCards(cursor.setId, page, {
          setName: cursor.setName,
          gameSlug: cursor.gameSlug,
        }),
      );
      const stored = await this.upsert.upsertPage(res.items, {
        provider: this.client.provider,
        gameSlug: cursor.gameSlug,
        setName: cursor.setName,
      });
      state.summary.created += stored.created;
      state.summary.updated += stored.updated;
      state.summary.skipped += stored.skipped;

      // Empty page with has_more=true would loop forever: treat as the end.
      const done = !res.hasMore || res.items.length === 0;
      // Cursor advances only now that the page is stored.
      await this.prisma.tcgIngestCursor.update({
        where: {
          gameSlug_setId: { gameSlug: cursor.gameSlug, setId: cursor.setId },
        },
        data: done
          ? { nextPage: page + 1, status: 'DONE', lastPriceSyncAt: new Date() }
          : { nextPage: page + 1, status: 'IN_PROGRESS' },
      });
      page += 1;
      if (done) {
        state.setsCompleted += 1;
        return;
      }
    }
  }

  /** Quota guard + request counter around every tcgapi.dev call. */
  private async request<T>(
    opts: IngestOptions,
    state: RunState,
    fn: () => Promise<TcgPage<T>>,
  ): Promise<TcgPage<T>> {
    if (state.summary.requests >= opts.maxRequests) {
      throw new QuotaStop(`request budget reached (${opts.maxRequests})`);
    }
    if (state.remaining !== null && state.remaining <= opts.reserve) {
      throw new QuotaStop(
        `remaining quota (${state.remaining}) reached the reserve (${opts.reserve})`,
      );
    }
    state.summary.requests += 1;
    const res = await fn();
    if (res.rateLimit.remaining !== null) {
      state.remaining = res.rateLimit.remaining;
    }
    return res;
  }
}
