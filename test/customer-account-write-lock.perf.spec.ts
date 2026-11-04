import { randomUUID } from 'node:crypto';
import { bootHarness, type Harness } from './helpers/account-write-race.js';

/**
 * Story 20.6 (D1): the RANDOM version of `customer-account-write-lock.e2e-spec.ts`, repeated. QA saw
 * 8 of 30 rounds leave data without the lock; with it, all of them must come out clean. Not part of
 * `pnpm test:e2e` because of its length (it is a probabilistic proof, the deterministic one is the
 * e2e); `pnpm test:perf` runs it one worker at a time.
 */
const TAG = `t${randomUUID().replace(/-/g, '').slice(0, 7)}`;
const ROUNDS = 60;

describe('Account writes vs anonymization: random rounds (Story 20.6 D1)', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await bootHarness(TAG);
  }, 120_000);
  afterAll(async () => {
    await h.close();
  }, 120_000);

  it(`${ROUNDS} random rounds of 5 parallel writes vs anonymize: clean accounts, no 5xx, no deadlock`, async () => {
    const outcomes: Record<string, number> = {};
    for (let i = 0; i < ROUNDS; i++) {
      const { anon, results, left } = await h.randomRound(70_000 + i, 5, 40);
      const ctx = JSON.stringify({ round: i, anon: anon.status, results });
      expect(anon.status, ctx).toBe(200);
      for (const r of results) {
        expect([200, 201, 401], ctx).toContain(r.status);
        outcomes[`${r.status}`] = (outcomes[`${r.status}`] ?? 0) + 1;
      }
      expect(left, ctx).toEqual(h.CLEAN);
    }
    process.stdout.write(
      `[20.6 perf] random write-vs-anonymize rounds=${ROUNDS} statuses=${JSON.stringify(outcomes)}\n`,
    );
  }, 600_000);
});
