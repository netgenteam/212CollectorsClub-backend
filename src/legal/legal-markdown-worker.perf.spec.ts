import { ApiException } from '../common/api-exception.js';
import {
  LegalMarkdownService,
  type LegalMarkdownOptions,
} from './legal-markdown.service.js';

/**
 * Story 19.3b: the TIME and EVENT-LOOP-DELAY assertions of the worker pool,
 * moved out of `legal-markdown-worker.spec.ts` (whose functional twins stay
 * there, with a roomy deadline). They need a quiet machine: `pnpm test:perf`
 * runs them one file at a time on one thread. Production defaults (3 s
 * deadline) are used on purpose wherever the original test used them.
 */
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

describe('Markdown worker: event loop never blocked, timings (QA D1)', () => {
  it('the QA vector (177 KB) is a 400 at the 3 s deadline, loop responsive, service healthy afterwards', async () => {
    const svc = make(); // production defaults (timeout 3 s)
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
    expect(res?.details?.issues[0].reason).toMatch(
      /could not analyze it in time/,
    );
    expect(ms).toBeGreaterThanOrEqual(2_900);
    expect(ms).toBeLessThan(5_000);
    expect(maxDelay).toBeLessThan(250);
    await settled(svc);
    expect(svc.poolStats()).toMatchObject({ alive: 0, terminated: 1 });
    expect((await svc.validate('## Ok\n\ntexto')).toc).toHaveLength(1);
  }, 20_000);

  it('the toc read path does not block the loop, repeat reads come from the cache', async () => {
    const svc = make({ timeoutMs: 600 });
    const mon = loopMonitor();
    await svc.buildToc(QA_VECTOR);
    const t = performance.now();
    await Promise.all([1, 2, 3, 4, 5].map(() => svc.buildToc(QA_VECTOR)));
    const again = performance.now() - t;
    const maxDelay = mon.stop();
    expect(again).toBeLessThan(100);
    expect(maxDelay).toBeLessThan(250);
  }, 20_000);

  it('a cached toc read takes < 20 ms', async () => {
    const svc = make();
    const md = '## A\n\ntexto\n\n### B\n\nmás';
    await svc.buildToc(md);
    const t = performance.now();
    await svc.buildToc(md);
    expect(performance.now() - t).toBeLessThan(20);
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

  it('12 simultaneous slow POSTs: the 503s are answered immediately', async () => {
    const svc = make({ maxWorkers: 2, maxQueue: 3, timeoutMs: 700 });
    const t = performance.now();
    const results = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const r = await body(svc.validate(QA_VECTOR));
        return { r, at: performance.now() - t };
      }),
    );
    const busy = results.filter((x) => x.r?.statusCode === 503);
    expect(busy).toHaveLength(7);
    expect(Math.max(...busy.map((b) => b.at))).toBeLessThan(300); // rejected at once
    await settled(svc);
  }, 30_000);

  it('infinite loop: killed at the deadline, loop responsive, the CPU is free for the next job', async () => {
    const svc = make({ workerUrl: MISBEHAVING, timeoutMs: 300 });
    const mon = loopMonitor();
    const t = performance.now();
    const res = await body(svc.validate('hang'));
    const ms = performance.now() - t;
    expect(res?.statusCode).toBe(400);
    expect(ms).toBeGreaterThanOrEqual(280);
    expect(ms).toBeLessThan(1_500);
    expect(mon.stop()).toBeLessThan(250);
    await settled(svc);
    expect(svc.poolStats()).toMatchObject({ alive: 0, terminated: 1 });
    const t2 = performance.now();
    await svc.validate('ok');
    expect(performance.now() - t2).toBeLessThan(300);
  });

  it('the diff QA vector does not block the event loop (max delay measured)', async () => {
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
    const svc = make();
    const mon = loopMonitor();
    const t = performance.now();
    const d = await svc.diff(diffVector('a'), diffVector('b'));
    const ms = performance.now() - t;
    const maxDelay = mon.stop();
    console.log(
      `[19.2 D1] diff of the QA vector: ${ms.toFixed(0)} ms, max event-loop delay ${maxDelay.toFixed(1)} ms`,
    );
    expect(d.stats).toEqual({ added: 5984, removed: 5984 });
    expect(maxDelay).toBeLessThan(250);
  }, 30_000);
});
