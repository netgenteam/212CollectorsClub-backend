import { ApiException } from '../common/api-exception.js';
import {
  LEGAL_MD_LIMITS,
  LegalMarkdownService,
  slugifyHeading,
  urlRejection,
} from './legal-markdown.service.js';
import { PoolFailure } from './legal-markdown-pool.js';
import { XSS_ACCEPT, XSS_REJECT } from './xss-corpus.js';

const svc = new LegalMarkdownService();
afterAll(() => svc.onModuleDestroy());

const issuesOf = async (md: string) => {
  try {
    await svc.validate(md);
  } catch (e) {
    const body = (e as ApiException).getResponse() as {
      statusCode: number;
      errorCode: string;
      details: { issues: { line: number; reason: string }[] };
    };
    return body;
  }
  return null;
};

describe('LegalMarkdownService.validate (XSS corpus)', () => {
  it.each(XSS_REJECT.map((c) => [c.name, c.md]))(
    'rejects: %s',
    async (_name, md) => {
      const body = await issuesOf(md);
      expect(body).not.toBeNull();
      expect(body?.statusCode).toBe(400);
      expect(body?.errorCode).toBe('LEGAL_MARKDOWN_INVALID');
      expect(body?.details.issues.length).toBeGreaterThan(0);
      for (const i of body?.details.issues ?? []) {
        expect(i.line).toBeGreaterThanOrEqual(1);
        expect(i.reason.length).toBeGreaterThan(3);
      }
    },
  );

  it.each(XSS_ACCEPT.map((c) => [c.name, c.md]))(
    'accepts: %s',
    async (_name, md) => {
      expect(await issuesOf(md)).toBeNull();
    },
  );

  it('reports the real 1-based line of each issue', async () => {
    const body = await issuesOf(
      'ok\n\n[a](javascript:1)\n\ntexto\n\n![](https://x.test/i.png)',
    );
    expect(body?.details.issues.map((i) => i.line)).toEqual([3, 7]);
  });

  it('reports every issue, not just the first', async () => {
    const body = await issuesOf(
      '<b>a</b> [x](//e.test) ![i](https://e.test/i.png)',
    );
    expect(body?.details.issues.length).toBeGreaterThanOrEqual(4);
  });

  it('is deterministic and does not mutate state between calls', async () => {
    expect(await issuesOf(XSS_REJECT[0].md)).toEqual(
      await issuesOf(XSS_REJECT[0].md),
    );
    expect(await issuesOf('## ok')).toBeNull();
  });

  it('handles an empty document', async () => {
    expect(await svc.validate('')).toEqual({ toc: [] });
  });
});

describe('urlRejection', () => {
  it.each([
    ['https://a.test', null],
    ['HTTPS://A.TEST', null],
    ['mailto:a@b.test', null],
    ['tel:+58412', null],
    ['#x', null],
    ['/x', null],
    ['/', null],
    ['//x', 'x'],
    ['/\\x', 'x'],
    ['', 'x'],
    ['#', 'x'],
    ['http://a.test', 'x'],
    ['javascript:1', 'x'],
    ['a b', 'x'],
    ['x\ny', 'x'],
    ['x', 'x'],
  ])('%j', (url, rejected) => {
    expect(urlRejection(url) === null).toBe(rejected === null);
  });
});

describe('LegalMarkdownService toc', () => {
  it('only ## and ### with deterministic unique ids (-2, -3)', async () => {
    const md = [
      '# Titulo H1',
      '## Datos',
      '### Datos',
      '## Datos',
      '#### cuarto nivel',
      '## Datos',
      '## Envío y devolución',
    ].join('\n\n');
    expect((await svc.validate(md)).toc).toEqual([
      { depth: 2, text: 'Datos', id: 'datos' },
      { depth: 3, text: 'Datos', id: 'datos-2' },
      { depth: 2, text: 'Datos', id: 'datos-3' },
      { depth: 2, text: 'Datos', id: 'datos-4' },
      { depth: 2, text: 'Envío y devolución', id: 'envio-y-devolucion' },
    ]);
    expect(await svc.buildToc(md)).toEqual(await svc.buildToc(md));
  });

  it('uses the plain text of headings with formatting and avoids collisions', async () => {
    const toc = await svc.buildToc(
      '## A **b** `c`\n\n## a b c\n\n## A\n\n## A-2\n\n## A',
    );
    expect(toc.map((t) => t.id)).toEqual([
      'a-b-c',
      'a-b-c-2',
      'a',
      'a-2',
      'a-3',
    ]);
    expect(toc[0].text).toBe('A b c');
  });

  it('falls back for headings that slugify to nothing', async () => {
    expect((await svc.buildToc('## ???\n\n## !!!')).map((t) => t.id)).toEqual([
      'seccion',
      'seccion-2',
    ]);
    expect(slugifyHeading('  Ñandú -- ¿Qué?  ')).toBe('nandu-que');
  });
});

describe('LegalMarkdownService.validate (bounded, QA D1)', () => {
  // Generous for CI (the target on a dev machine is < 500 ms); the unbounded
  // versions took 4 s to > 30 s, so this still catches any regression.
  const MAX_MS = 1500;
  const nest = (n: number) =>
    Array.from({ length: n }, (_, i) => `${' '.repeat(2 * i)}- x`).join('\n');

  const vectors: [string, string][] = [
    ['5000 quotes (RangeError)', '>'.repeat(5000) + ' x'],
    ['5000 list markers', '- '.repeat(5000)],
    ['50000 list markers', '- '.repeat(50000)],
    ['stacked markers x lines', '- - - x\n'.repeat(1000)],
    ['500 nested levels', nest(500)],
    ['1000 nested levels', nest(1000)],
    ['15000 headings', '## A\n'.repeat(15000)],
    ['30000 headings', '## A\n'.repeat(30000)],
    ['setext x 50000', 'a\n=\n'.repeat(50000)],
    ['100000 "a." (GFM autolink)', 'a.'.repeat(100000)],
    ['30000 "[a]("', '[a]('.repeat(30000)],
    ['nested emphasis', '**a_'.repeat(30000)],
    ['nested emphasis with spaces', '*a **b '.repeat(20000)],
    ['backtick runs', '`a``'.repeat(50000)],
    ['100000 "["', '['.repeat(100000)],
    ['refs and definitions', '[r1]: https://x.com\n[r1] [r1]\n'.repeat(4000)],
    ['table of 25000 rows', `|a|b|\n|-|-|\n${'|1|2|\n'.repeat(25000)}`],
    ['wide table', `|${'a|'.repeat(20000)}\n|${'-|'.repeat(20000)}\n`],
    ['blank-separated items', '- a\n\n'.repeat(30000)],
    ['more than 200 KB', 'palabra '.repeat(30000)],
    [
      'dense inline markup, many blocks',
      '`a` '.repeat(2000).concat('\n\n').repeat(30),
    ],
  ];

  it.each(vectors)('400 LEGAL_MARKDOWN_INVALID, fast: %s', async (_n, md) => {
    const t = performance.now();
    const body = await issuesOf(md);
    const ms = performance.now() - t;
    expect(body?.statusCode).toBe(400);
    expect(body?.errorCode).toBe('LEGAL_MARKDOWN_INVALID');
    expect(body?.details.issues.length).toBeGreaterThan(0);
    expect(body?.details.issues[0].line).toBeGreaterThanOrEqual(1);
    expect(ms).toBeLessThan(MAX_MS);
  });

  // Inputs that PASS the prefilter at (just under) each limit still finish fast.
  const atLimit: [string, string][] = [
    ['5999 flat list items', '- a\n'.repeat(5999)],
    ['800 nested items', '* a\n  * b\n'.repeat(400)],
    ['4 stacked markers x 266 lines', '- - - - x\n'.repeat(266)],
    ['500 headings', '## Título\n\n'.repeat(250) + '### Sub\n\n'.repeat(249)],
    ['58 KB table', '| a | b |\n| - | - |\n' + '| 1 | 2 |\n'.repeat(6000)],
    ['20000 literal links', 'www.a. '.repeat(2800)],
  ];
  it.each(atLimit)(
    'under the limits it still ends quickly: %s',
    async (_n, md) => {
      const t = performance.now();
      await issuesOf(md);
      expect(performance.now() - t).toBeLessThan(MAX_MS);
    },
  );

  it('does not reject realistic legal documents (~100 KB, 3-4 level lists, tables, links)', async () => {
    const clause = (i: number) =>
      [
        `## Cláusula ${i}. Condiciones`,
        `El comprador acepta **estos** términos y la [política de privacidad](/privacidad) (ver https://212collectorsclub.com/envios). `.repeat(
          4,
        ),
        '- Primero\n  - Segundo nivel\n    - Tercer nivel\n      - Cuarto nivel\n- Otro punto',
        '### Detalle\n\n| Concepto | Plazo |\n| - | - |\n| Envío | 5 días |\n| Devolución | 15 días |',
        '> Nota: consulte el [[RIF]] del vendedor.',
      ].join('\n\n');
    const md = Array.from({ length: 180 }, (_, i) => clause(i)).join('\n\n');
    expect(md.length).toBeGreaterThan(90_000);
    expect(md.length).toBeLessThan(LEGAL_MD_LIMITS.maxBytes);
    const t = performance.now();
    const r = await svc.validate(md);
    expect(performance.now() - t).toBeLessThan(MAX_MS);
    expect(r.toc.length).toBe(360);
    expect(new Set(r.toc.map((x) => x.id)).size).toBe(360);
  });

  it('accepts a 190 KB prose document', async () => {
    const md = Array.from(
      { length: 1050 },
      (_, i) =>
        `Párrafo ${i}: el comprador acepta estos términos y **condiciones** de uso del sitio, sin perjuicio de la ley. Lorem ipsum dolor sit amet consectetur adipiscing elit.`,
    ).join('\n\n');
    expect(Buffer.byteLength(md)).toBeGreaterThan(150_000);
    expect(await issuesOf(md)).toBeNull();
  });

  it('toc ids are unique and O(n): 500 equal headings, previous ids preserved', async () => {
    const toc = await svc.buildToc('## A\n\n'.repeat(500));
    expect(toc[0].id).toBe('a');
    expect(toc[1].id).toBe('a-2');
    expect(toc[499].id).toBe('a-500');
    expect(new Set(toc.map((t) => t.id)).size).toBe(500);
    // A-2 after a-2 already exists: 'a-2-2' (same as the old algorithm).
    expect(
      (await svc.buildToc('## a\n\n## a\n\n## A-2\n\n## a\n')).map((t) => t.id),
    ).toEqual(['a', 'a-2', 'a-2-2', 'a-3']);
  });

  it('N2: a literal www./http:// link gives a clear message with line and the fix', async () => {
    const body = await issuesOf(
      'Hola\n\nVisite www.ejemplo.com hoy y http://x.com',
    );
    const reasons = body!.details.issues;
    expect(reasons.map((i) => i.line)).toEqual([3, 3]);
    expect(reasons[0].reason).toContain('Line 3');
    expect(reasons[0].reason).toContain('www.ejemplo.com');
    expect(reasons[0].reason).toContain('https://');
    expect(reasons[1].reason).toContain('http://x.com');
    expect(reasons[1].reason).toContain('https://x.com');
    // an explicit link with a bad scheme keeps the plain reason
    expect(
      (await issuesOf('[a](http://x.com)'))!.details.issues[0].reason,
    ).toMatch(/scheme "http:"/);
  });
});

describe('LegalMarkdownService.buildToc race with validate (QA 19.1, Story 19.2)', () => {
  it('a failing toc job never overwrites the positive entry written by validate() meanwhile', async () => {
    const s = new LegalMarkdownService({ negativeTtlMs: 60_000 });
    const md = '## Alcance\n\nTexto.\n';
    let failFirst!: (e: unknown) => void;
    let calls = 0;
    // First pool call (the toc job) hangs until released and then times out;
    // the second (validate) answers right away.
    (s as unknown as { pool: unknown }).pool = {
      run: (): Promise<unknown[]> =>
        ++calls === 1
          ? new Promise((_res, rej) => {
              failFirst = rej;
            })
          : Promise.resolve([['h', 2, 'Alcance', 1]]),
      close: () => Promise.resolve(),
      stats: () => ({}),
    };
    const tocJob = s.buildToc(md); // in flight
    await s.validate(md); // primes the cache with the positive toc
    failFirst(new PoolFailure('TIMEOUT'));
    const fromJob = await tocJob;
    expect(fromJob).toEqual([{ depth: 2, text: 'Alcance', id: 'alcance' }]);
    // The cache still holds the positive entry: no new pool call is needed.
    expect(await s.buildToc(md)).toEqual(fromJob);
    expect(calls).toBe(2);
  });

  it('a TIMEOUT with nothing cached is still remembered as a negative entry', async () => {
    const s = new LegalMarkdownService({ negativeTtlMs: 60_000 });
    let calls = 0;
    (s as unknown as { pool: unknown }).pool = {
      run: (): Promise<unknown[]> => {
        calls++;
        return Promise.reject(new PoolFailure('TIMEOUT'));
      },
      close: () => Promise.resolve(),
      stats: () => ({}),
    };
    expect(await s.buildToc('## A\n')).toEqual([]);
    expect(await s.buildToc('## A\n')).toEqual([]);
    expect(calls).toBe(1);
  });
});
