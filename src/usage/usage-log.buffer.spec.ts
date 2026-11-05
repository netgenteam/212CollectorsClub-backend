import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_BACKOFF_MS,
  SHUTDOWN_FLUSH_MS,
  UsageLogBuffer,
  sqlStateOf,
} from './usage-log.buffer.js';
import type { UsageLogConfig } from './usage-config.js';
import type { UsageLogRow, UsageLogWriter } from './usage-log.types.js';

const CFG: UsageLogConfig = {
  enabled: true,
  bufferMax: 10,
  flushMs: 1_000,
  flushBatch: 4,
  purgeDays: 7,
};

let n = 0;
const row = (over: Partial<UsageLogRow> = {}): UsageLogRow => ({
  ts: 1_700_000_000_000 + n,
  method: 'GET',
  route: `/r/${n++}`,
  status: 200,
  durationMs: 3,
  actorType: 'ANON',
  actorId: null,
  ip: '203.0.113.9',
  userAgent: 'ua',
  requestId: '11111111-1111-4111-8111-111111111111',
  ...over,
});

function writerOf(impl?: (rows: readonly UsageLogRow[]) => Promise<void>) {
  const batches: UsageLogRow[][] = [];
  const w: UsageLogWriter & {
    calls: number;
    running: number;
    maxRunning: number;
  } = {
    calls: 0,
    running: 0,
    maxRunning: 0,
    async insert(rows) {
      w.calls += 1;
      w.running += 1;
      w.maxRunning = Math.max(w.maxRunning, w.running);
      try {
        if (impl) await impl(rows);
        batches.push([...rows]);
      } finally {
        w.running -= 1;
      }
    },
  };
  return { w, batches };
}

describe('UsageLogBuffer (Story 20.7, AC4)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('push is synchronous, does no I/O and queues', () => {
    const { w } = writerOf();
    const b = new UsageLogBuffer(CFG, w);
    b.push(row());
    expect(b.size()).toBe(1);
    expect(w.calls).toBe(0);
    expect(b.stats()).toMatchObject({ buffered: 1, droppedSinceBoot: 0 });
  });

  it('never throws, even for a hostile row', () => {
    const { w } = writerOf();
    const b = new UsageLogBuffer(CFG, w);
    expect(() => b.push(null as never)).not.toThrow();
    expect(() => b.push(undefined as never)).not.toThrow();
  });

  it('past the cap the OLDEST rows go and the drop is counted', () => {
    const { w } = writerOf();
    const b = new UsageLogBuffer(
      { ...CFG, flushBatch: 100, bufferMax: 100 },
      w,
    );
    const rows = Array.from({ length: 130 }, () => row());
    for (const r of rows) b.push(r);
    expect(b.size()).toBe(100);
    expect(b.stats().droppedSinceBoot).toBe(30);
  });

  it('writes on the timer, everything pending, in batches of flushBatch', async () => {
    const { w, batches } = writerOf();
    const b = new UsageLogBuffer({ ...CFG, flushBatch: 100 }, w);
    b.start();
    for (let i = 0; i < 6; i++) b.push(row());
    await vi.advanceTimersByTimeAsync(1_000);
    expect(batches.flat()).toHaveLength(6);
    expect(b.size()).toBe(0);
    expect(b.stats().writtenSinceBoot).toBe(6);
    expect(b.stats().lastFlushAt).not.toBeNull();
    await b.onModuleDestroy();
  });

  it('reaching flushBatch writes early (off the caller stack) and only full batches', async () => {
    const { w, batches } = writerOf();
    const b = new UsageLogBuffer(CFG, w);
    for (let i = 0; i < 9; i++) b.push(row());
    expect(w.calls).toBe(0); // push never wrote
    await vi.advanceTimersByTimeAsync(5);
    expect(batches.map((x) => x.length)).toEqual([4, 4]);
    expect(b.size()).toBe(1); // the partial batch waits for the timer
  });

  it('single flight: never two writes at once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const { w } = writerOf(() => gate);
    const b = new UsageLogBuffer(CFG, w);
    for (let i = 0; i < 20; i++) b.push(row());
    await vi.advanceTimersByTimeAsync(5);
    void b.flush(true);
    void b.flush(true);
    await vi.advanceTimersByTimeAsync(5);
    expect(w.calls).toBe(1);
    expect(w.maxRunning).toBe(1);
    release();
    await vi.advanceTimersByTimeAsync(50);
    expect(w.maxRunning).toBe(1);
  });

  it('a failed write puts the rows back at the FRONT, keeps the error and backs off', async () => {
    let fail = true;
    const { w, batches } = writerOf(() =>
      fail
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve(),
    );
    const b = new UsageLogBuffer(
      { ...CFG, flushBatch: 100, bufferMax: 100 },
      w,
    );
    const first = row({ route: '/first' });
    b.push(first);
    b.push(row());
    await b.flush(true);
    expect(b.size()).toBe(2);
    expect(b.stats().lastFlushError).toBe('connection refused');
    expect(b.stats().lastFlushAt).toBeNull();
    // inside the back-off the timer does not hammer the database
    const calls = w.calls;
    await b.flush(true);
    expect(w.calls).toBe(calls);
    // after it, and with the database back, the rows go in their original order
    fail = false;
    await vi.advanceTimersByTimeAsync(1_100);
    await b.flush(true);
    expect(batches.flat()[0].route).toBe('/first');
    expect(b.stats().lastFlushError).toBeNull();
    expect(b.size()).toBe(0);
  });

  it('the back-off doubles up to a ceiling', async () => {
    const { w } = writerOf(() => Promise.reject(new Error('down')));
    const b = new UsageLogBuffer(
      { ...CFG, flushBatch: 100, bufferMax: 100 },
      w,
    );
    b.push(row());
    let last = 0;
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(MAX_BACKOFF_MS + 10);
      await b.flush(true);
      last = w.calls;
    }
    expect(last).toBe(12);
  });

  it('with the database down the memory stays bounded and the drops are counted', async () => {
    const { w } = writerOf(() => Promise.reject(new Error('down')));
    const b = new UsageLogBuffer(
      { ...CFG, bufferMax: 1_000, flushBatch: 200 },
      w,
    );
    for (let i = 0; i < 50_000; i++) b.push(row());
    await vi.advanceTimersByTimeAsync(10);
    expect(b.size()).toBeLessThanOrEqual(1_000);
    const s = b.stats();
    expect(s.buffered + s.droppedSinceBoot).toBeGreaterThanOrEqual(
      50_000 - 200,
    );
    expect(s.droppedSinceBoot).toBeGreaterThanOrEqual(48_800);
  });

  it('a batch the database refuses for ever (data/constraint error) is discarded, not retried', async () => {
    let first = true;
    const { w, batches } = writerOf(() => {
      if (!first) return Promise.resolve();
      first = false;
      return Promise.reject(Object.assign(new Error('bad'), { code: '22P02' }));
    });
    const b = new UsageLogBuffer({ ...CFG, flushBatch: 2, bufferMax: 100 }, w);
    b.push(row());
    b.push(row());
    b.push(row());
    await vi.advanceTimersByTimeAsync(5);
    expect(b.stats().droppedSinceBoot).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await b.flush(true);
    expect(batches.flat()).toHaveLength(1); // the third row got through behind the poison batch
  });

  it('sqlStateOf reads the code however Prisma wraps it', () => {
    expect(sqlStateOf(Object.assign(new Error('x'), { code: '23505' }))).toBe(
      '23505',
    );
    expect(
      sqlStateOf(
        Object.assign(new Error('x'), {
          meta: { driverAdapterError: { cause: { code: '22007' } } },
        }),
      ),
    ).toBe('22007');
    expect(
      sqlStateOf(new Error('Raw query failed. Code: `22P02`. Message: x')),
    ).toBe('22P02');
    expect(sqlStateOf(new Error('ECONNREFUSED'))).toBeNull();
  });

  it('final flush on close writes what is pending', async () => {
    const { w, batches } = writerOf();
    const b = new UsageLogBuffer({ ...CFG, flushBatch: 100 }, w);
    b.start();
    for (let i = 0; i < 7; i++) b.push(row());
    await b.onModuleDestroy();
    expect(batches.flat()).toHaveLength(7);
    expect(b.size()).toBe(0);
  });

  it('final flush gives up after 2 s when the database does not answer', async () => {
    const { w } = writerOf(() => new Promise<void>(() => undefined));
    const b = new UsageLogBuffer({ ...CFG, flushBatch: 100 }, w);
    b.push(row());
    const done = b.onModuleDestroy();
    await vi.advanceTimersByTimeAsync(SHUTDOWN_FLUSH_MS + 100);
    await expect(done).resolves.toBeUndefined();
  });

  it('final flush ignores the back-off of an earlier failure', async () => {
    let fail = true;
    const { w, batches } = writerOf(() =>
      fail ? Promise.reject(new Error('down')) : Promise.resolve(),
    );
    const b = new UsageLogBuffer({ ...CFG, flushBatch: 100 }, w);
    b.push(row());
    await b.flush(true);
    expect(b.size()).toBe(1);
    fail = false; // the database is back, but the 1 s back-off has not elapsed
    await b.onModuleDestroy();
    expect(batches.flat()).toHaveLength(1);
  });

  it('disabled: nothing is queued, no timer', () => {
    const { w } = writerOf();
    const b = new UsageLogBuffer({ ...CFG, enabled: false }, w);
    b.start();
    b.push(row());
    expect(b.size()).toBe(0);
  });

  describe('anonymization (dropActor)', () => {
    const ID = '22222222-2222-4222-8222-222222222222';
    it('removes the pending rows of the customer, keeps the rest, and refuses the late ones', () => {
      const { w } = writerOf();
      const b = new UsageLogBuffer(
        { ...CFG, flushBatch: 100, bufferMax: 100 },
        w,
      );
      b.push(row({ actorType: 'CUSTOMER', actorId: ID }));
      b.push(row({ actorType: 'CUSTOMER', actorId: ID }));
      b.push(row());
      b.push(
        row({
          actorType: 'CUSTOMER',
          actorId: '33333333-3333-4333-8333-333333333333',
        }),
      );
      expect(b.dropActor(ID)).toBe(2);
      expect(b.size()).toBe(2);
      b.push(row({ actorType: 'CUSTOMER', actorId: ID })); // a request that finished after the commit
      expect(b.size()).toBe(2);
      expect(b.stats().droppedSinceBoot).toBe(0); // not a drop: it was never meant to be kept
    });

    it('settle waits for the write in flight', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      const { w } = writerOf(() => gate);
      const b = new UsageLogBuffer(CFG, w);
      for (let i = 0; i < 4; i++) b.push(row());
      await vi.advanceTimersByTimeAsync(5);
      let settled = false;
      void b.settle(10_000).then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);
      release();
      await vi.advanceTimersByTimeAsync(5);
      expect(settled).toBe(true);
    });
  });
});
