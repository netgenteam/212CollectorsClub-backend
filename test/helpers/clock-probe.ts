import pg from 'pg';

/**
 * Story 20.1 (QA round 4): diagnostic for `fx-lock-budget`. While a request waits on a lock
 * held by the test, a separate connection samples, every `everyMs`, THREE clocks:
 *   - `mono`: Node `performance.now()` (monotonic),
 *   - `wall`: Node `Date.now()` (wall clock of the host),
 *   - `pg`:   Postgres `clock_timestamp()` (wall clock of the database server),
 * plus `qs`, the `query_start` Postgres reports for the backend that is waiting on a lock.
 * Comparing the increments tells whether a wall clock stepped (WSL2 does) and whether the
 * database timers followed the monotonic or the wall clock.
 */
export interface ClockSample {
  mono: number;
  wall: number;
  pg: number;
  /** query_start (epoch ms) of the oldest backend waiting on a lock, or null. */
  qs: number | null;
}

export interface ClockSummary {
  samples: number;
  /** last - first, in ms, on each clock. */
  monoSpan: number;
  wallSpan: number;
  pgSpan: number;
  /** Largest |Δpg - Δmono| and |Δwall - Δmono| between two consecutive samples, in ms. */
  maxStepPg: number;
  maxStepWall: number;
  /** Postgres' own measure of the wait: last sample that still saw the waiter minus its query_start. */
  pgSeenWait: number | null;
}

export interface ClockProbe {
  stop: () => Promise<{ samples: ClockSample[]; summary: ClockSummary }>;
}

export function summarize(samples: ClockSample[]): ClockSummary {
  const first = samples[0];
  const last = samples[samples.length - 1];
  let maxStepPg = 0;
  let maxStepWall = 0;
  for (let i = 1; i < samples.length; i++) {
    const dm = samples[i].mono - samples[i - 1].mono;
    maxStepPg = Math.max(
      maxStepPg,
      Math.abs(samples[i].pg - samples[i - 1].pg - dm),
    );
    maxStepWall = Math.max(
      maxStepWall,
      Math.abs(samples[i].wall - samples[i - 1].wall - dm),
    );
  }
  const seen = samples.filter((s) => s.qs !== null);
  const lastSeen = seen[seen.length - 1];
  const r = (n: number) => Math.round(n * 10) / 10;
  return {
    samples: samples.length,
    monoSpan: r(last.mono - first.mono),
    wallSpan: r(last.wall - first.wall),
    pgSpan: r(last.pg - first.pg),
    maxStepPg: r(maxStepPg),
    maxStepWall: r(maxStepWall),
    pgSeenWait: lastSeen ? r(lastSeen.pg - (seen[0].qs as number)) : null,
  };
}

export async function startClockProbe(
  connectionString: string,
  everyMs = 250,
): Promise<ClockProbe> {
  const c = new pg.Client({ connectionString });
  await c.connect();
  const samples: ClockSample[] = [];
  let busy: Promise<void> = Promise.resolve();
  const sample = (): Promise<void> => {
    const mono = performance.now();
    const wall = Date.now();
    return c
      .query<{ pg: string; qs: string | null }>(
        `SELECT extract(epoch FROM clock_timestamp()) * 1000 AS pg,
                (SELECT min(extract(epoch FROM query_start) * 1000)
                   FROM pg_stat_activity
                  WHERE datname = current_database() AND wait_event_type = 'Lock'
                    AND pid <> pg_backend_pid()) AS qs`,
      )
      .then((r) => {
        samples.push({
          mono,
          wall,
          pg: Number(r.rows[0].pg),
          qs: r.rows[0].qs === null ? null : Number(r.rows[0].qs),
        });
      })
      .catch(() => undefined);
  };
  busy = sample();
  const timer = setInterval(() => {
    busy = busy.then(sample);
  }, everyMs);
  return {
    stop: async () => {
      clearInterval(timer);
      await busy;
      await sample();
      await c.end().catch(() => undefined);
      return { samples, summary: summarize(samples) };
    },
  };
}
