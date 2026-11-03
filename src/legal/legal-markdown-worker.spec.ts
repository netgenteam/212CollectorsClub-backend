import { Worker } from 'node:worker_threads';
import { ApiException } from '../common/api-exception.js';
import {
  LegalMarkdownService,
  type LegalMarkdownOptions,
} from './legal-markdown.service.js';

/**
 * Story 19.1, attempt 3 (QA D1): the Markdown analysis never runs on the API
 * event loop. These tests run the REAL worker (`legal-markdown.worker.mjs`,
 * plain JS shared by src/vitest and dist) plus a misbehaving test double.
 */
// QA vector: 177 KB, an unclosed `[` followed by a long block of plain text
// (quadratic in the parser: 13 s of event loop when parsed in-process).
const QA_VECTOR = ('[' + ('a '.repeat(40) + '\n').repeat(740) + '\n').repeat(3);
const MISBEHAVING = new URL(
  './fixtures/misbehaving-worker.mjs',
  import.meta.url,
);

/**
 * Story 19.3b: `pnpm test` checks CORRECTNESS only. Whatever must answer with a
 * real worker gets this roomy deadline (a test option; the product default
 * stays 3 s) so a loaded machine cannot turn a valid parse into a TIMEOUT.
 * Time and event-loop-delay assertions live in
 * `legal-markdown-worker.perf.spec.ts` (`pnpm test:perf`).
 */
const ROOMY = 30_000;

const services: LegalMarkdownService[] = [];
const make = (opts?: LegalMarkdownOptions) => {
  const s = new LegalMarkdownService(opts);
  services.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.onModuleDestroy()));
});

/** Waits until every thread of the pool is really gone (dying ones count as alive). */
async function settled(svc: LegalMarkdownService) {
  for (let i = 0; i < 200 && svc.poolStats().alive > 0; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

const body = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as ApiException).getResponse() as {
      statusCode: number;
      errorCode: string;
      details?: { issues: { line: number; reason: string }[] };
    };
  }
};

describe('Markdown worker: event loop never blocked (QA D1)', () => {
  it('the QA vector (177 KB) is a 400 at the hard deadline and the worker is terminated', async () => {
    const svc = make({ timeoutMs: 1_000 });
    expect(QA_VECTOR.length).toBeGreaterThan(170_000);
    const res = await body(svc.validate(QA_VECTOR));
    expect(res?.statusCode).toBe(400);
    expect(res?.errorCode).toBe('LEGAL_MARKDOWN_INVALID');
    expect(res?.details?.issues[0].reason).toMatch(
      /could not analyze it in time/,
    );
    await settled(svc);
    expect(svc.poolStats()).toMatchObject({ alive: 0, terminated: 1 });
  }, 20_000);

  it('the toc read path does not block the loop either, and a failed analysis is cached', async () => {
    const svc = make({ timeoutMs: 600 });
    const first = await svc.buildToc(QA_VECTOR);
    const spawnedAfterFirst = svc.poolStats().spawned;
    // 5 concurrent reads of the same stored body, all answered from the cache
    const rest = await Promise.all(
      [1, 2, 3, 4, 5].map(() => svc.buildToc(QA_VECTOR)),
    );
    expect(first).toEqual([]);
    expect(rest.every((r) => r.length === 0)).toBe(true);
    expect(svc.poolStats().spawned).toBe(spawnedAfterFirst);
  }, 20_000);

  it('concurrent misses of the same body share ONE job; normal reads hit the cache', async () => {
    const svc = make({ timeoutMs: ROOMY });
    const md = '## A\n\ntexto\n\n### B\n\nmás';
    const rs = await Promise.all(
      Array.from({ length: 8 }, () => svc.buildToc(md)),
    );
    expect(rs.every((r) => r.length === 2)).toBe(true);
    expect(svc.poolStats().spawned).toBe(1);
    await svc.buildToc(md); // cache hit: no new job
    expect(svc.poolStats().spawned).toBe(1);
  });

  it('validate primes the toc cache (the first read after publishing needs no parse)', async () => {
    const svc = make({ timeoutMs: ROOMY });
    const md = '## Uno\n\n### Dos';
    const { toc } = await svc.validate(md);
    const before = svc.poolStats().spawned;
    expect(await svc.buildToc(md)).toEqual(toc);
    expect(svc.poolStats().spawned).toBe(before);
  });

  it('realistic legal text of normal size is accepted (no thread terminated)', async () => {
    const svc = make({ timeoutMs: ROOMY });
    const clause = (i: number) =>
      [
        `## Cláusula ${i}. Condiciones`,
        `El comprador acepta **estos** términos y la [política de privacidad](/privacidad) (ver https://212collectorsclub.com/envios). `.repeat(
          4,
        ),
        '- Primero\n  - Segundo nivel\n    - Tercer nivel\n- Otro punto',
        '### Detalle\n\n| Concepto | Plazo |\n| - | - |\n| Envío | 5 días |',
        '> Nota: consulte el [[RIF]] del vendedor.',
      ].join('\n\n');
    const md = Array.from({ length: 180 }, (_, i) => clause(i)).join('\n\n');
    const prose = Array.from(
      { length: 1050 },
      (_, i) =>
        `Párrafo ${i}: el comprador acepta estos términos y **condiciones** de uso del sitio, sin perjuicio de la ley. Lorem ipsum dolor sit amet consectetur adipiscing elit.`,
    ).join('\n\n');
    for (const doc of [md, prose]) {
      await svc.validate(doc);
    }
    expect(svc.poolStats().terminated).toBe(0);
  }, 20_000);
});

describe('Markdown worker: bounded concurrency', () => {
  it('12 simultaneous slow POSTs: at most 2 threads, 2 running + 3 queued, the rest 503 immediately', async () => {
    const svc = make({ maxWorkers: 2, maxQueue: 3, timeoutMs: 700 });
    let peak = 0;
    const iv = setInterval(() => {
      peak = Math.max(peak, svc.poolStats().alive);
    }, 5);
    const results = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const r = await body(svc.validate(QA_VECTOR));
        return { r };
      }),
    );
    clearInterval(iv);
    const busy = results.filter((x) => x.r?.statusCode === 503);
    const invalid = results.filter((x) => x.r?.statusCode === 400);
    expect(peak).toBeLessThanOrEqual(2);
    expect(invalid).toHaveLength(5);
    expect(busy).toHaveLength(7);
    expect(busy.every((b) => b.r?.errorCode === 'LEGAL_MARKDOWN_BUSY')).toBe(
      true,
    );
    await settled(svc);
    expect(svc.poolStats()).toMatchObject({ alive: 0, busy: 0, queued: 0 });
  }, 30_000);
});

describe('Markdown worker: failures never take the process down', () => {
  const bad = (extra: LegalMarkdownOptions = {}) =>
    make({ workerUrl: MISBEHAVING, timeoutMs: ROOMY, ...extra });

  it.each([
    ['uncaught exception', 'throw'],
    ['process.exit inside the worker', 'exit'],
  ])('%s: 400, worker discarded, pool recovers', async (_n, md) => {
    const svc = bad();
    const res = await body(svc.validate(md));
    expect(res?.statusCode).toBe(400);
    expect(res?.details?.issues[0].reason).toMatch(/too complex/);
    await settled(svc);
    expect(svc.poolStats().alive).toBe(0);
    expect((await svc.validate('ok')).toc).toHaveLength(1); // fresh worker
    expect(svc.poolStats().spawned).toBe(2);
  });

  it('infinite loop: killed at the deadline (real thread termination)', async () => {
    const svc = bad({ timeoutMs: 300 });
    const t = performance.now();
    const res = await body(svc.validate('hang'));
    const ms = performance.now() - t;
    expect(res?.statusCode).toBe(400);
    expect(res?.details?.issues[0].reason).toMatch(
      /could not analyze it in time/,
    );
    expect(ms).toBeGreaterThanOrEqual(280); // never cut earlier than the deadline
    await settled(svc);
    expect(svc.poolStats()).toMatchObject({ alive: 0, terminated: 1 });
  });

  it('out of memory (resourceLimits): that worker dies, the process and the pool survive', async () => {
    const svc = bad({
      timeoutMs: 10_000,
      resourceLimits: {
        maxOldGenerationSizeMb: 24,
        maxYoungGenerationSizeMb: 8,
      },
    });
    const rss0 = process.memoryUsage().rss;
    const res = await body(svc.validate('oom'));
    expect(res?.statusCode).toBe(400);
    expect(res?.details?.issues[0].reason).toMatch(/too complex/);
    expect(svc.poolStats().alive).toBe(0);
    expect(process.memoryUsage().rss - rss0).toBeLessThan(400 * 1024 * 1024);
    expect((await svc.validate('ok')).toc).toHaveLength(1);
  }, 30_000);
});

describe('Markdown worker: shutdown', () => {
  it('onModuleDestroy terminates running workers, fails queued jobs and leaves no thread', async () => {
    const svc = make({
      workerUrl: MISBEHAVING,
      maxWorkers: 1,
      maxQueue: 5,
      timeoutMs: 10_000,
    });
    const running = body(svc.validate('hang'));
    const queued = body(svc.validate('hang'));
    await new Promise((r) => setTimeout(r, 100));
    expect(svc.poolStats()).toMatchObject({ alive: 1, busy: 1, queued: 1 });
    await svc.onModuleDestroy();
    expect((await running)?.statusCode).toBe(503); // shutting down
    expect((await queued)?.statusCode).toBe(503);
    await settled(svc);
    expect(svc.poolStats()).toMatchObject({ alive: 0, busy: 0, queued: 0 });
    // After close it refuses cleanly instead of spawning.
    expect((await body(svc.validate('ok')))?.statusCode).toBe(503);
    expect(svc.poolStats().alive).toBe(0);
    await svc.onModuleDestroy(); // idempotent
  });
});

/**
 * Story 19.1, attempt 4 (QA A): the pool never has more than `maxWorkers`
 * threads alive at once, dying ones included. `maxAlive` is measured at the
 * source: +1 when the factory creates a Worker, -1 when its 'exit' event
 * fires (the thread is really gone), independently of the pool's own counters.
 */
describe('Markdown worker: thread cap holds under churn (QA A)', () => {
  function counting(url?: URL) {
    const c = { alive: 0, max: 0, created: 0 };
    const createWorker: NonNullable<LegalMarkdownOptions['createWorker']> = (
      o,
    ) => {
      const w = new Worker(url ?? o.workerUrl, {
        resourceLimits: o.resourceLimits,
        execArgv: [],
      });
      c.created++;
      c.alive++;
      c.max = Math.max(c.max, c.alive);
      w.on('exit', () => c.alive--);
      return w;
    };
    return { c, createWorker };
  }

  async function churn(svc: LegalMarkdownService, ms: number, cap: number) {
    const d1 = ('[' + ('a '.repeat(40) + '\n').repeat(740) + '\n').repeat(3);
    let peakSlots = 0;
    const pending: Promise<unknown>[] = [];
    const end = Date.now() + ms;
    for (let i = 0; Date.now() < end; i++) {
      pending.push(body(svc.validate(d1 + ' x'.repeat(i))));
      peakSlots = Math.max(peakSlots, svc.poolStats().alive);
      await new Promise((r) => setTimeout(r, 3));
    }
    await Promise.all(pending);
    expect(peakSlots).toBeLessThanOrEqual(cap);
  }

  it('default options: never more than 2 live threads while jobs time out and are replaced', async () => {
    const { c, createWorker } = counting();
    const svc = make({ createWorker });
    await churn(svc, 8_000, 2);
    console.log(`[19.1 A] default: maxAlive=${c.max}, created=${c.created}`);
    expect(c.created).toBeGreaterThan(2); // workers really were replaced
    expect(c.max).toBeLessThanOrEqual(2);
    await svc.onModuleDestroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(c.alive).toBe(0);
  }, 40_000);

  it('short timeout (150 ms): constant kill/refill, still never more than 2 live threads', async () => {
    const { c, createWorker } = counting();
    const svc = make({ createWorker, timeoutMs: 150 });
    await churn(svc, 5_000, 2);
    console.log(
      `[19.1 A] timeout 150: maxAlive=${c.max}, created=${c.created}`,
    );
    expect(c.created).toBeGreaterThan(10);
    expect(c.max).toBeLessThanOrEqual(2);
    await svc.onModuleDestroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(c.alive).toBe(0);
  }, 40_000);

  it('maxWorkers 1 with the misbehaving worker (hang/throw/exit mix) never exceeds 1', async () => {
    const { c, createWorker } = counting(MISBEHAVING);
    const svc = make({
      createWorker,
      maxWorkers: 1,
      maxQueue: 50,
      timeoutMs: 60,
    });
    const kinds = ['hang', 'throw', 'exit', 'ok'];
    const rs = await Promise.all(
      Array.from({ length: 40 }, (_, i) => body(svc.validate(kinds[i % 4]))),
    );
    expect(rs.length).toBe(40);
    expect(c.max).toBeLessThanOrEqual(1);
    expect(svc.poolStats().alive).toBeLessThanOrEqual(1); // an idle one may stay
    await svc.onModuleDestroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(c.alive).toBe(0);
  }, 30_000);

  describe('spawn() that throws', () => {
    let unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    beforeEach(() => {
      unhandled = [];
      process.on('unhandledRejection', onUnhandled);
    });
    afterEach(() => {
      process.off('unhandledRejection', onUnhandled);
    });

    it(
      'fails the affected jobs cleanly (no unhandled rejection), does not wedge the queue, recovers',
      async () => {
        let broken = false;
        const svc = make({
          workerUrl: MISBEHAVING,
          maxWorkers: 1,
          maxQueue: 5,
          timeoutMs: 1_500,
          createWorker: (o) => {
            if (broken) throw new Error('EAGAIN: cannot create thread');
            return new Worker(o.workerUrl, { execArgv: [] });
          },
        });
        const a = body(svc.validate('hang')); // takes the only worker
        const b = body(svc.validate('ok')); // queued
        const c2 = body(svc.validate('ok')); // queued
        await new Promise((r) => setTimeout(r, 20));
        broken = true; // from now on the refill after A's kill throws
        const [ra, rb, rc] = await Promise.all([a, b, c2]);
        expect(ra?.statusCode).toBe(400); // timeout
        expect(rb?.statusCode).toBe(400); // spawn failed: clean "too complex"
        expect(rb?.details?.issues[0].reason).toMatch(/too complex/);
        expect(rc?.statusCode).toBe(400);
        await settled(svc);
        expect(svc.poolStats()).toMatchObject({ alive: 0, busy: 0, queued: 0 });
        // First spawn from a run() that throws: same clean failure.
        const d = await body(svc.validate('ok'));
        expect(d?.statusCode).toBe(400);
        await settled(svc);
        expect(svc.poolStats()).toMatchObject({ alive: 0, queued: 0 });
        broken = false; // not wedged: the pool works again
        expect((await svc.validate('ok')).toc).toHaveLength(1);
        await new Promise((r) => setTimeout(r, 50));
        expect(unhandled).toEqual([]);
      },
      ROOMY,
    );
  });
});

describe('toc cache: transient failures are not permanent (QA B)', () => {
  const MISBEHAVING_JS = MISBEHAVING;
  const DOC = 'hang\n\n## Real\n\ntexto'; // bad worker hangs on it; the real one answers
  // Same, but the bad worker throws at once: a FAILED instead of a TIMEOUT, no
  // waiting for a deadline (the negative-cache rules are the same for both).
  const DOC_FAST = 'throw\n\n## Real\n\ntexto';

  function setup(extra: LegalMarkdownOptions = {}) {
    const clock = { t: 1_000_000 };
    const state = { bad: true };
    const svc = make({
      timeoutMs: ROOMY / 6, // 5 s: the real worker must answer inside it
      now: () => clock.t,
      createWorker: (o) =>
        new Worker(state.bad ? MISBEHAVING_JS : o.workerUrl, {
          resourceLimits: o.resourceLimits,
          execArgv: [],
        }),
      ...extra,
    });
    return { clock, state, svc };
  }

  it(
    'a timeout degrades to [], is not relaunched inside the TTL, and is retried after it',
    async () => {
      const { clock, state, svc } = setup({ negativeTtlMs: 60_000 });
      expect(await svc.buildToc(DOC)).toEqual([]);
      const spawned = svc.poolStats().spawned;
      clock.t += 59_999;
      state.bad = false; // the cause went away, but the TTL has not expired
      expect(await svc.buildToc(DOC)).toEqual([]);
      expect(svc.poolStats().spawned).toBe(spawned); // no worker launched
      clock.t += 2; // TTL expired
      const toc = await svc.buildToc(DOC);
      expect(toc.map((e) => e.text)).toEqual(['Real']); // index recovered
      expect(svc.poolStats().spawned).toBe(spawned + 1);
      // The positive result is permanent: no expiry, no new job.
      clock.t += 10 * 60_000;
      expect(await svc.buildToc(DOC)).toEqual(toc);
      expect(svc.poolStats().spawned).toBe(spawned + 1);
    },
    ROOMY,
  );

  it('a still-failing body is retried once per TTL, not on every read', async () => {
    const { clock, svc } = setup({ negativeTtlMs: 1_000 });
    await svc.buildToc(DOC_FAST);
    const s1 = svc.poolStats().terminated;
    for (let i = 0; i < 5; i++) await svc.buildToc(DOC_FAST);
    expect(svc.poolStats().terminated).toBe(s1);
    clock.t += 1_001;
    await svc.buildToc(DOC_FAST);
    expect(svc.poolStats().terminated).toBe(s1 + 1);
  });

  it('concurrent failing reads of the same body share ONE job', async () => {
    const { svc } = setup();
    const rs = await Promise.all(
      Array.from({ length: 6 }, () => svc.buildToc(DOC_FAST)),
    );
    expect(rs.every((r) => r.length === 0)).toBe(true);
    expect(svc.poolStats().spawned).toBe(1);
  });

  it('validate() success replaces a negative entry with the permanent one', async () => {
    const { clock, state, svc } = setup();
    expect(await svc.buildToc(DOC_FAST)).toEqual([]);
    state.bad = false;
    clock.t += 1; // inside the TTL
    await svc.validate(DOC_FAST);
    const spawned = svc.poolStats().spawned;
    expect((await svc.buildToc(DOC_FAST)).map((e) => e.text)).toEqual(['Real']);
    expect(svc.poolStats().spawned).toBe(spawned);
  });
});

describe('validate(): bounded error response (QA C)', () => {
  it('19 900 autolinks give 50 issues plus the omitted count, in a small body', async () => {
    const svc = make();
    const md = ('www.a.com '.repeat(190) + '\n\n').repeat(105);
    const res = await body(svc.validate(md));
    expect(res?.statusCode).toBe(400);
    expect(res?.details?.issues).toHaveLength(50);
    const details = res?.details as unknown as { omitted: number };
    expect(details.omitted).toBeGreaterThan(19_000);
    expect(JSON.stringify(res).length).toBeLessThan(20_000);
  }, 20_000);

  it('a normal rejection keeps the format: issues and the cause (Story 19.9), no omitted', async () => {
    const svc = make();
    const res = await body(
      svc.validate('<script>x</script>\n\n![a](https://x.y/z.png)'),
    );
    expect(res?.details?.issues.length).toBeGreaterThan(0);
    expect(Object.keys(res?.details ?? {}).sort()).toEqual([
      'issues',
      'reason',
    ]);
    expect((res?.details as { reason?: string }).reason).toBe(
      'FORBIDDEN_CONSTRUCTS',
    );
  });
});

/**
 * Story 19.2 (QA D1): the line diff runs in the same pool. Vector: two valid
 * versions of ~196 KB (5990 lines of 33 characters, one blank every 900, every
 * line different): 3.8 s of event loop when jsdiff ran on the API thread.
 */
const diffVector = (seed: string) => {
  const out: string[] = [];
  for (let i = 0; out.length < 5990; i++) {
    out.push(
      i % 900 === 899
        ? ''
        : `${seed}${i} lorem ipsum dolor sit amet`.slice(0, 33),
    );
  }
  return out.join('\n');
};

describe('Legal diff in the worker pool (QA D1, Story 19.2)', () => {
  it('a normal diff is correct in content (changed line + 3 lines of context)', async () => {
    const svc = make({ diffTimeoutMs: ROOMY });
    const a = Array.from({ length: 20 }, (_, i) => `l${i + 1}`);
    const b = [...a];
    b[9] = 'l10 CAMBIADA';
    const d = await svc.diff(a.join('\n') + '\n', b.join('\n') + '\n');
    expect(d.stats).toEqual({ added: 1, removed: 1 });
    expect(
      d.hunks.map((h) => [h.type, h.lines, h.oldStart, h.newStart]),
    ).toEqual([
      ['context', ['l7', 'l8', 'l9'], 7, 7],
      ['removed', ['l10'], 10, 10],
      ['added', ['l10 CAMBIADA'], 11, 10],
      ['context', ['l11', 'l12', 'l13'], 11, 11],
    ]);
  });

  it(
    'the QA vector diff is complete',
    async () => {
      const svc = make({ diffTimeoutMs: ROOMY });
      const A = diffVector('a');
      const B = diffVector('b');
      expect(A.length).toBeGreaterThan(190_000);
      const d = await svc.diff(A, B);
      // the 6 blank separators are the only lines the two texts share
      expect(d.stats).toEqual({ added: 5984, removed: 5984 });
    },
    ROOMY,
  );

  it('a diff over its hard deadline is a TIMEOUT and the worker is terminated', async () => {
    const svc = make({ workerUrl: MISBEHAVING, diffTimeoutMs: 300 });
    await expect(svc.diff('hang', 'x')).rejects.toMatchObject({
      kind: 'TIMEOUT',
    });
    await settled(svc);
    expect(svc.poolStats()).toMatchObject({ alive: 0, terminated: 1 });
  });

  it('a full pool answers BUSY at once for a diff too', async () => {
    const svc = make({
      workerUrl: MISBEHAVING,
      diffTimeoutMs: 400,
      maxWorkers: 1,
      maxQueue: 1,
    });
    const first = svc.diff('hang', 'x').catch((e: unknown) => e);
    const second = svc.diff('hang', 'x').catch((e: unknown) => e);
    await expect(svc.diff('hang', 'x')).rejects.toMatchObject({ kind: 'BUSY' });
    await first;
    await second;
  });
});
