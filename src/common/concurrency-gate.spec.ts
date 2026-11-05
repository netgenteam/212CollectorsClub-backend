import { describe, expect, it } from 'vitest';
import { ConcurrencyGate, GateRejected } from './concurrency-gate.js';

const deferred = () => {
  let resolve!: () => void;
  const p = new Promise<void>((r) => (resolve = r));
  return { p, resolve };
};

describe('ConcurrencyGate (Story 20.7 round 2)', () => {
  it('never runs more than `limit` at once, queues up to maxWaiting, refuses the rest at once', async () => {
    const gate = new ConcurrencyGate(2, 3, 1_000);
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 8 }, () => deferred());
    const calls = gates.map((g, i) =>
      gate
        .run(async () => {
          running += 1;
          peak = Math.max(peak, running);
          await g.p;
          running -= 1;
          return i;
        })
        .then(
          (v) => ({ ok: v }),
          (e: unknown) => ({ err: e }),
        ),
    );
    await new Promise((r) => setTimeout(r, 10));
    // 2 running + 3 waiting; the other 3 were refused at once
    expect(running).toBe(2);
    const refused = (await Promise.all(calls.slice(5))).every(
      (r) => 'err' in r && r.err instanceof GateRejected,
    );
    expect(refused).toBe(true);
    for (const g of gates) g.resolve();
    const results = await Promise.all(calls);
    expect(results.filter((r) => 'ok' in r)).toHaveLength(5);
    expect(peak).toBe(2);
    expect(gate.running).toBe(0);
  });

  it('a waiter that does not get its turn in time is refused, and frees nothing it never held', async () => {
    const gate = new ConcurrencyGate(1, 5, 30);
    const hold = deferred();
    const first = gate.run(() => hold.p);
    await expect(gate.run(() => Promise.resolve(1))).rejects.toBeInstanceOf(
      GateRejected,
    );
    hold.resolve();
    await first;
    expect(gate.running).toBe(0);
    await expect(gate.run(() => Promise.resolve(7))).resolves.toBe(7);
  });

  it('an error in a call frees its slot', async () => {
    const gate = new ConcurrencyGate(1, 0, 10);
    await expect(
      gate.run(() => Promise.reject(new Error('x'))),
    ).rejects.toThrow('x');
    await expect(gate.run(() => Promise.resolve(1))).resolves.toBe(1);
  });
});
