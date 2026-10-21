import { parseIngestArgs } from './cli/ingest-args.js';
import {
  TcgIngestService,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_REQUEST_RESERVE,
  DEFAULT_SET_LIMIT,
} from './tcg-ingest.service.js';
import { toTcgCard } from './tcg-card.normalizer.js';
import { MasterCardUpsertService } from './master-card-upsert.service.js';

describe('parseIngestArgs (Story 15.4)', () => {
  it('parses flags, lists and the = form', () => {
    expect(
      parseIngestArgs([
        '--games',
        'pokemon, magic',
        '--sets=a,b',
        '--max-requests',
        '10',
        '--dry-run',
        '--refresh-sets',
        '--set-limit=3',
      ]),
    ).toEqual({
      games: ['pokemon', 'magic'],
      sets: ['a', 'b'],
      maxRequests: 10,
      dryRun: true,
      refreshSets: true,
      setLimit: 3,
    });
    expect(parseIngestArgs([])).toEqual({});
  });

  it('rejects unknown flags, missing values and bad numbers', () => {
    expect(() => parseIngestArgs(['--nope'])).toThrow('Unknown');
    expect(() => parseIngestArgs(['--games'])).toThrow('requires a value');
    expect(() => parseIngestArgs(['--max-requests', 'abc'])).toThrow(
      'positive integer',
    );
  });
});

describe('TcgIngestService.resolveOptions (Story 15.4)', () => {
  const make = (env: Record<string, string>) =>
    new TcgIngestService(
      {} as never,
      { get: (k: string) => env[k] } as never,
      {} as never,
      {} as never,
      {} as never,
    );

  it('defaults to pokemon, bounded sets and budget', () => {
    expect(make({}).resolveOptions()).toEqual({
      games: ['pokemon'],
      sets: null,
      maxRequests: DEFAULT_MAX_REQUESTS,
      reserve: DEFAULT_REQUEST_RESERVE,
      dryRun: false,
      refreshSets: false,
      setLimit: DEFAULT_SET_LIMIT,
    });
  });

  it('reads envs and lets explicit overrides win', () => {
    const svc = make({
      TCG_INGEST_GAMES: 'magic,yugioh',
      TCG_INGEST_SETS: 'x,y',
      TCG_MAX_REQUESTS_PER_RUN: '7',
      TCG_REQUEST_RESERVE: '3',
    });
    expect(svc.resolveOptions()).toMatchObject({
      games: ['magic', 'yugioh'],
      sets: ['x', 'y'],
      maxRequests: 7,
      reserve: 3,
    });
    expect(
      svc.resolveOptions({ games: ['pokemon'], maxRequests: 2 }),
    ).toMatchObject({ games: ['pokemon'], maxRequests: 2, sets: ['x', 'y'] });
  });
});

describe('MasterCardUpsertService (Story 15.4)', () => {
  const card = (id: string, skip: boolean) => ({
    ...toTcgCard(
      { id, name: 'N', product_type: skip ? 'Sealed Products' : 'Cards' },
      '1',
    ),
  });

  it('skips sealed items, dedupes and issues one statement per page', async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValue([{ inserted: true }, { inserted: false }]);
    const svc = new MasterCardUpsertService({ $queryRaw: queryRaw } as never);
    const res = await svc.upsertPage(
      [card('1', false), card('1', false), card('2', false), card('3', true)],
      { provider: 'FAKE', gameSlug: 'pokemon', setName: 'S' },
    );
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ created: 1, updated: 1, skipped: 1 });
  });

  it('does not touch the DB when the page only has sealed products', async () => {
    const queryRaw = vi.fn();
    const svc = new MasterCardUpsertService({ $queryRaw: queryRaw } as never);
    const res = await svc.upsertPage([card('9', true)], {
      provider: 'FAKE',
      gameSlug: 'pokemon',
      setName: 'S',
    });
    expect(queryRaw).not.toHaveBeenCalled();
    expect(res).toEqual({ created: 0, updated: 0, skipped: 1 });
  });
});
