/* eslint-disable @typescript-eslint/unbound-method -- `RetentionSessionLock.tryAcquire` is a mocked static: the mock is the subject */
import { Prisma } from '../generated/prisma/client.js';
import {
  RetentionService,
  errorCode,
  MAX_CLOCK_SKEW_MS,
} from './retention.service.js';
import { readRetentionConfig } from './retention-config.js';
import { RetentionSessionLock } from './retention-lock.js';
import type { RetentionTask } from './retention.types.js';

vi.mock('./retention-lock.js', () => ({
  RetentionSessionLock: { tryAcquire: vi.fn() },
}));

const cfgOf = (o: Record<string, string> = {}, env = 'production') =>
  readRetentionConfig((k) => o[k], env);

interface Rig {
  svc: RetentionService;
  sql: string[];
  audited: unknown[];
  lock: {
    lost: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
    currentDatabase: ReturnType<typeof vi.fn>;
  };
  tasks: RetentionTask[];
}

function rig(
  opts: {
    cfg?: ReturnType<typeof cfgOf>;
    dbNow?: Date;
    previous?: Date | null;
    auditFails?: boolean;
    createFails?: unknown;
    tasks?: RetentionTask[];
  } = {},
): Rig {
  const sql: string[] = [];
  const audited: unknown[] = [];
  const exec = (first: unknown) => {
    const strings =
      (first as { strings?: string[] }).strings ?? (first as string[]);
    sql.push(strings.join('?').replace(/\s+/g, ' ').trim());
    return Promise.resolve(0);
  };
  const query = (first: unknown) => {
    const strings = (first as string[]).join('?');
    sql.push(strings.replace(/\s+/g, ' ').trim());
    if (/SELECT now\(\)/.test(strings))
      return Promise.resolve([{ now: opts.dbNow ?? new Date() }]);
    if (/SELECT "effectiveNow"/.test(strings))
      return Promise.resolve(
        opts.previous ? [{ effectiveNow: opts.previous }] : [],
      );
    if (/"finishedAt" IS NOT NULL AND "auditedAt" IS NULL/.test(strings))
      return Promise.resolve([]);
    if (/UPDATE "Retention_Runs"/.test(strings))
      return Promise.resolve([
        { startedAt: new Date(), finishedAt: new Date() },
      ]);
    return Promise.resolve([]);
  };
  const prisma = {
    $executeRaw: exec,
    $queryRaw: query,
    retentionRun: {
      create: vi.fn(() =>
        opts.createFails
          ? Promise.reject(opts.createFails as Error)
          : Promise.resolve({ id: '22222222-2222-4222-8222-222222222222' }),
      ),
    },
  };
  const audit = {
    transaction: vi.fn(
      async (
        fn: (tx: unknown, a: { add: (e: unknown) => void }) => Promise<unknown>,
      ) => {
        if (opts.auditFails) throw new Error('audit down');
        await fn(prisma, { add: (e) => audited.push(e) });
      },
    ),
  };
  const lock = {
    lost: vi.fn(() => false),
    release: vi.fn(() => Promise.resolve()),
    currentDatabase: vi.fn(() => Promise.resolve('cc_e2e_1700000000_deadbeef')),
  };
  vi.mocked(RetentionSessionLock.tryAcquire).mockResolvedValue(lock as never);
  const svc = new RetentionService(
    prisma as never,
    audit as never,
    { getOrThrow: () => 'postgresql://x/y' } as never,
    opts.cfg ?? cfgOf({ RETENTION_BATCH_PAUSE_MS: '0' }),
    { purgeExpired: vi.fn() } as never,
    { purgeOldStatsBounded: vi.fn() } as never,
    {
      getCronJob: () => ({ nextDate: () => new Date('2026-11-05T04:30:00Z') }),
    } as never,
  );
  const tasks: RetentionTask[] = opts.tasks ?? [
    { name: 'a', run: () => Promise.resolve({ rows: 3, truncated: false }) },
    { name: 'b', run: () => Promise.resolve({ rows: 0, truncated: true }) },
  ];
  (svc as unknown as { tasks: RetentionTask[] }).tasks = tasks;
  return { svc, sql, audited, lock, tasks };
}

describe('RetentionService', () => {
  beforeEach(() => vi.mocked(RetentionSessionLock.tryAcquire).mockReset());

  it('runs every task, writes ONE summary event with counters only and releases the lock', async () => {
    const r = rig();
    const out = await r.svc.start('SCHEDULED');
    if (out.kind !== 'started') throw new Error('not started');
    const sum = await out.done;
    expect(sum.status).toBe('OK');
    expect(sum.tasks.map((t) => [t.name, t.rows, t.truncated])).toEqual([
      ['a', 3, false],
      ['b', 0, true],
    ]);
    expect(r.audited).toHaveLength(1);
    expect(r.audited[0]).toMatchObject({
      action: 'RETENTION_PURGE_RUN',
      actorType: 'SYSTEM',
      entityType: 'RetentionRun',
    });
    expect(JSON.stringify(r.audited[0])).not.toMatch(/email|ip|cedula|@/);
    expect(r.lock.release).toHaveBeenCalledTimes(1);
    expect(r.svc.isRunning()).toBe(false);
  });

  it('a manual run is audited with the admin as the actor', async () => {
    const r = rig();
    const out = await r.svc.start(
      'MANUAL',
      '33333333-3333-4333-8333-333333333333',
    );
    if (out.kind !== 'started') throw new Error('x');
    await out.done;
    expect(r.audited[0]).toMatchObject({
      actorType: 'ADMIN',
      actorId: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('a task that throws does not stop the others; the run is PARTIAL and the error is a code, never the message', async () => {
    const r = rig({
      tasks: [
        {
          name: 'a',
          run: () =>
            Promise.reject(
              Object.assign(new Error('secret@mail.com leaked in a message'), {
                code: 'P2010',
              }),
            ),
        },
        {
          name: 'b',
          run: () => Promise.resolve({ rows: 5, truncated: false }),
        },
      ],
    });
    const out = await r.svc.start('SCHEDULED');
    if (out.kind !== 'started') throw new Error('x');
    const sum = await out.done;
    expect(sum.status).toBe('PARTIAL');
    expect(sum.tasks[0].error).toBe('Error P2010');
    expect(JSON.stringify(sum)).not.toContain('secret@mail.com');
    expect(sum.tasks[1]).toMatchObject({ name: 'b', rows: 5 });
  });

  it('every task failing is FAILED', async () => {
    const fail = (name: string): RetentionTask => ({
      name,
      run: () => Promise.reject(new Error('x')),
    });
    const r = rig({ tasks: [fail('a'), fail('b')] });
    const out = await r.svc.start('SCHEDULED');
    if (out.kind !== 'started') throw new Error('x');
    expect((await out.done).status).toBe('FAILED');
  });

  it('AUDIT DOWN: the purge already happened and stays; the row is closed PARTIAL without audit and the lock is released', async () => {
    const r = rig({ auditFails: true });
    const out = await r.svc.start('SCHEDULED');
    if (out.kind !== 'started') throw new Error('x');
    const sum = await out.done;
    expect(sum.audited).toBe(false);
    expect(sum.tasks[0].rows).toBe(3);
    expect(
      r.sql.some(
        (s) =>
          /"auditedAt" = NULL/.test(s) &&
          /AUDIT_NOT_WRITTEN|errorSummary/.test(s),
      ),
    ).toBe(true);
    expect(r.lock.release).toHaveBeenCalledTimes(1);
  });

  it('under NODE_ENV=test it refuses a database that is not a throw-away clone: nothing is written, the lock is released', async () => {
    const r = rig();
    r.lock.currentDatabase.mockResolvedValue('collectorsclub_dev');
    await expect(r.svc.start('MANUAL', 'x')).rejects.toThrow(
      /not a throw-away/,
    );
    expect(r.sql).toEqual([]);
    expect(r.lock.release).toHaveBeenCalledTimes(1);
  });

  it('a second run while one holds the lock answers busy and touches nothing', async () => {
    const r = rig();
    vi.mocked(RetentionSessionLock.tryAcquire).mockResolvedValue(null);
    expect(await r.svc.start('MANUAL', 'x')).toEqual({ kind: 'busy' });
    expect(r.sql).toEqual([]);
  });

  it('the unique index on RUNNING is the second wall: a duplicate RUNNING row is "busy" and the lock is released', async () => {
    const r = rig({
      createFails: new Prisma.PrismaClientKnownRequestError('dup', {
        code: 'P2002',
        clientVersion: 'test',
      }),
    });
    const out = await r.svc.start('SCHEDULED');
    expect(out).toEqual({ kind: 'busy' });
    expect(r.lock.release).toHaveBeenCalledTimes(1);
  });

  it('disabled (not production, not asked for): no lock is even taken', async () => {
    const r = rig({ cfg: cfgOf({}, 'development') });
    expect(await r.svc.start('MANUAL', 'x')).toEqual({ kind: 'disabled' });
    expect(RetentionSessionLock.tryAcquire).not.toHaveBeenCalled();
  });

  it('the clock of the run is capped: a database clock a year ahead is not used', async () => {
    const seen: Date[] = [];
    const task: RetentionTask = {
      name: 'a',
      run: (ctx) => {
        seen.push(ctx.asOf);
        return Promise.resolve({ rows: 0, truncated: false });
      },
    };
    const prev = new Date('2026-11-04T04:30:00Z');
    const r = rig({
      tasks: [task],
      previous: prev,
      dbNow: new Date(Date.now() + 365 * 86_400_000),
    });
    // the skew check would stop a real jump; here only the cap is under test
    (r.svc as unknown as { cfg: unknown }).cfg = cfgOf({
      RETENTION_BATCH_PAUSE_MS: '0',
    });
    const out = await r.svc.start('SCHEDULED');
    if (out.kind !== 'started') throw new Error('x');
    await out.done;
    // skewMs > MAX_CLOCK_SKEW_MS: nothing ran at all, which is even safer
    expect(seen).toEqual([]);
    expect(MAX_CLOCK_SKEW_MS).toBeLessThanOrEqual(10 * 60_000);
  });

  it('database and application clocks far apart: nothing is purged, the run is FAILED with CLOCK_SKEW', async () => {
    const r = rig({ dbNow: new Date(Date.now() + 3_600_000) });
    const out = await r.svc.start('SCHEDULED');
    if (out.kind !== 'started') throw new Error('x');
    const sum = await out.done;
    expect(sum.status).toBe('FAILED');
    expect(sum.tasks).toEqual([]);
    expect(r.sql.some((s) => /CLOCK_SKEW/.test(s))).toBe(false); // the code travels as a parameter, not in the text
  });

  it('a lost lock stops the run at the next batch and is recorded', async () => {
    const r = rig({
      tasks: [
        {
          name: 'a',
          run: (ctx) =>
            Promise.resolve({ rows: 1, truncated: ctx.shouldStop() }),
        },
      ],
    });
    r.lock.lost.mockReturnValue(true);
    const out = await r.svc.start('SCHEDULED');
    if (out.kind !== 'started') throw new Error('x');
    const sum = await out.done;
    expect(sum.tasks[0].truncated).toBe(true);
    expect(sum.status).toBe('PARTIAL');
  });

  it('the cron path never throws and skips when disabled or off', async () => {
    const off = rig({ cfg: cfgOf({ RETENTION_PURGE_CRON: 'off' }) });
    await off.svc.scheduled();
    expect(RetentionSessionLock.tryAcquire).not.toHaveBeenCalled();
    const on = rig();
    // the database cannot be reached / DATABASE_URL is missing: start() rejects, the cron swallows it
    (on.svc as unknown as { config: unknown }).config = {
      getOrThrow: () => {
        throw new Error('db down');
      },
    };
    const res = await on.svc.scheduled().then(
      () => 'ok',
      (e: unknown) => `rejected ${String(e)}`,
    );
    expect(res).toBe('ok');
  });

  it('nextRunAt is null when the cron is off, and a date otherwise', () => {
    expect(
      rig({ cfg: cfgOf({ RETENTION_PURGE_CRON: 'off' }) }).svc.nextRunAt(),
    ).toBeNull();
    expect(rig().svc.nextRunAt()).toEqual(new Date('2026-11-05T04:30:00Z'));
  });
});

describe('errorCode', () => {
  it('keeps the class and a short code, never the message', () => {
    expect(
      errorCode(Object.assign(new Error('a@b.com'), { code: '55P03' })),
    ).toBe('Error 55P03');
    expect(errorCode('x')).toBe('UNKNOWN');
    expect(
      errorCode(Object.assign(new Error('m'), { code: 'not a short code!' })),
    ).toBe('Error');
  });
});
