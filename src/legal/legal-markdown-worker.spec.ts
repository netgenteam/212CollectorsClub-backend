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

const services: LegalMarkdownService[] = [];
const make = (opts?: LegalMarkdownOptions) => {
  const s = new LegalMarkdownService(opts);
  services.push(s);
  return s;
};
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.onModuleDestroy()));
});

/** Samples the event loop every 10 ms and keeps the worst extra delay. */
function loopMonitor() {
  let last = performance.now();
  let max = 0;
  const iv = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - 10);
    last = now;
  }, 10);
  return { stop: () => (clearInterval(iv), max) };
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
  it('the QA vector (177 KB) is a 400 at the hard deadline, the worker is terminated and the loop stays responsive', async () => {
    const svc = make(); // production defaults (timeout 3 s)
    expect(QA_VECTOR.length).toBeGreaterThan(170_000);
    const mon = loopMonitor();
    const t = performance.now();
    const res = await body(svc.validate(QA_VECTOR));
    const ms = performance.now() - t;
    const maxDelay = mon.stop();
    console.log(
      `[19.1 D1] QA vector: validate ${ms.toFixed(0)} ms -> ${res?.statusCode}, max event-loop delay ${maxDelay.toFixed(1)} ms`,
    );
    expect(res?.statusCode).toBe(400);
    expect(res?.errorCode).toBe('LEGAL_MARKDOWN_INVALID');
    expect(res?.details?.issues[0].reason).toMatch(/too long to analyze/);
    expect(ms).toBeGreaterThanOrEqual(2_900);
    expect(ms).toBeLessThan(5_000);
    expect(maxDelay).toBeLessThan(250);
    expect(svc.poolStats()).toMatchObject({ alive: 0, terminated: 1 });
    // The service is healthy afterwards (a fresh worker is created lazily).
    expect((await svc.validate('## Ok\n\ntexto')).toc).toHaveLength(1);
  }, 20_000);

  it('the toc read path does not block the loop either, and a failed analysis is cached', async () => {
    const svc = make({ timeoutMs: 600 });
    const mon = loopMonitor();
    const first = await svc.buildToc(QA_VECTOR);
    const spawnedAfterFirst = svc.poolStats().spawned;
    const t = performance.now();
    // 5 concurrent reads of the same stored body, all answered from the cache
    const rest = await Promise.all(
      [1, 2, 3, 4, 5].map(() => svc.buildToc(QA_VECTOR)),
    );
    const again = performance.now() - t;
    const maxDelay = mon.stop();
    console.log(
      `[19.1 D1] buildToc on the QA vector: [] after timeout; repeat reads ${again.toFixed(1)} ms; max loop delay ${maxDelay.toFixed(1)} ms`,
    );
    expect(first).toEqual([]);
    expect(rest.every((r) => r.length === 0)).toBe(true);
    expect(again).toBeLessThan(100);
    expect(svc.poolStats().spawned).toBe(spawnedAfterFirst);
    expect(maxDelay).toBeLessThan(250);
  }, 20_000);

  it('concurrent misses of the same body share ONE job; normal reads hit the cache', async () => {
    const svc = make();
    const md = '## A\n\ntexto\n\n### B\n\nmás';
    const rs = await Promise.all(
      Array.from({ length: 8 }, () => svc.buildToc(md)),
    );
    expect(rs.every((r) => r.length === 2)).toBe(true);
    expect(svc.poolStats().spawned).toBe(1);
    const t = performance.now();
    await svc.buildToc(md);
    expect(performance.now() - t).toBeLessThan(20);
  });

  it('validate primes the toc cache (the first read after publishing needs no parse)', async () => {
    const svc = make();
    const md = '## Uno\n\n### Dos';
    const { toc } = await svc.validate(md);
    const before = svc.poolStats().spawned;
    expect(await svc.buildToc(md)).toEqual(toc);
    expect(svc.poolStats().spawned).toBe(before);
  });

  it('realistic legal text of normal size is accepted well inside the timeout', async () => {
    const svc = make();
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
      const mon = loopMonitor();
      const t = performance.now();
      await svc.validate(doc);
      const ms = performance.now() - t;
      const d = mon.stop();
      console.log(
        `[19.1 D1] realistic ${Math.round(doc.length / 1024)} KB accepted in ${ms.toFixed(0)} ms, max loop delay ${d.toFixed(1)} ms`,
      );
      expect(ms).toBeLessThan(2_000);
      expect(d).toBeLessThan(250);
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
    const t = performance.now();
    const results = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const r = await body(svc.validate(QA_VECTOR));
        return { r, at: performance.now() - t };
      }),
    );
    clearInterval(iv);
    const busy = results.filter((x) => x.r?.statusCode === 503);
    const invalid = results.filter((x) => x.r?.statusCode === 400);
    console.log(
      `[19.1 D1] 12 concurrent: ${invalid.length}x400, ${busy.length}x503 (max ${Math.max(...busy.map((b) => b.at)).toFixed(0)} ms), peak threads ${peak}`,
    );
    expect(peak).toBeLessThanOrEqual(2);
    expect(invalid).toHaveLength(5);
    expect(busy).toHaveLength(7);
    expect(busy.every((b) => b.r?.errorCode === 'LEGAL_MARKDOWN_BUSY')).toBe(
      true,
    );
    expect(Math.max(...busy.map((b) => b.at))).toBeLessThan(300); // rejected at once
    expect(svc.poolStats()).toMatchObject({ alive: 0, busy: 0, queued: 0 });
  }, 30_000);
});

describe('Markdown worker: failures never take the process down', () => {
  const bad = (extra: LegalMarkdownOptions = {}) =>
    make({ workerUrl: MISBEHAVING, timeoutMs: 400, ...extra });

  it.each([
    ['uncaught exception', 'throw'],
    ['process.exit inside the worker', 'exit'],
  ])('%s: 400, worker discarded, pool recovers', async (_n, md) => {
    const svc = bad();
    const res = await body(svc.validate(md));
    expect(res?.statusCode).toBe(400);
    expect(res?.details?.issues[0].reason).toMatch(/too complex/);
    expect(svc.poolStats().alive).toBe(0);
    expect((await svc.validate('ok')).toc).toHaveLength(1); // fresh worker
    expect(svc.poolStats().spawned).toBe(2);
  });

  it('infinite loop: killed at the deadline (real thread termination)', async () => {
    const svc = bad({ timeoutMs: 300 });
    const mon = loopMonitor();
    const t = performance.now();
    const res = await body(svc.validate('hang'));
    const ms = performance.now() - t;
    expect(res?.statusCode).toBe(400);
    expect(res?.details?.issues[0].reason).toMatch(/too long/);
    expect(ms).toBeGreaterThanOrEqual(280);
    expect(ms).toBeLessThan(1_500);
    expect(mon.stop()).toBeLessThan(250);
    expect(svc.poolStats()).toMatchObject({ alive: 0, terminated: 1 });
    // The terminated thread really freed the CPU: the next job is fast.
    const t2 = performance.now();
    await svc.validate('ok');
    expect(performance.now() - t2).toBeLessThan(300);
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
    expect(svc.poolStats()).toMatchObject({ alive: 0, busy: 0, queued: 0 });
    // After close it refuses cleanly instead of spawning.
    expect((await body(svc.validate('ok')))?.statusCode).toBe(503);
    expect(svc.poolStats().alive).toBe(0);
    await svc.onModuleDestroy(); // idempotent
  });
});
