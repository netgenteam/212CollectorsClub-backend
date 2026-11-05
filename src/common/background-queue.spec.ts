import { describe, expect, it } from 'vitest';
import { BackgroundQueue } from './background-queue.js';

const deferred = () => {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
};

describe('BackgroundQueue (Story 20.6a round 2)', () => {
  it('runs `concurrency` at a time, queues, drops past maxQueued, and runs everything it accepted', async () => {
    const q = new BackgroundQueue(2, 2);
    let running = 0;
    let peak = 0;
    let done = 0;
    const gates = Array.from({ length: 6 }, () => deferred());
    const outcomes = gates.map((g) =>
      q.run(null, async () => {
        running += 1;
        peak = Math.max(peak, running);
        await g.p;
        running -= 1;
        done += 1;
      }),
    );
    expect(outcomes).toEqual([
      'started',
      'started',
      'queued',
      'queued',
      'dropped',
      'dropped',
    ]);
    expect(q.droppedTotal).toBe(2);
    for (const g of gates) g.resolve();
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(4);
    expect(peak).toBe(2);
    expect(q.pending).toBe(0);
  });

  it('a key already queued or running is not started twice, and is free again afterwards', async () => {
    const q = new BackgroundQueue(1, 5);
    const g = deferred();
    expect(q.run('a', () => g.p)).toBe('started');
    expect(q.run('a', () => Promise.resolve())).toBe('duplicate');
    g.resolve();
    await new Promise((r) => setTimeout(r, 10));
    expect(q.run('a', () => Promise.resolve())).toBe('started');
  });

  it('a job that throws (sync or async) never breaks the queue', async () => {
    const q = new BackgroundQueue(1, 5);
    q.run(null, () => {
      throw new Error('sync');
    });
    q.run(null, () => Promise.reject(new Error('async')));
    let ran = false;
    q.run(null, () => {
      ran = true;
      return Promise.resolve();
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(ran).toBe(true);
  });
});
