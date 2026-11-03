import { ApiException } from '../common/api-exception.js';
import {
  LEGAL_MD_LIMITS,
  LegalMarkdownService,
} from './legal-markdown.service.js';

/**
 * Story 19.3b: PERFORMANCE assertions of the Markdown validator, moved out of
 * `legal-markdown.service.spec.ts` (their functional twins stay there). Run
 * with `pnpm test:perf` on a quiet machine, single thread. Product deadline
 * (3 s) is the default here on purpose.
 */
const svc = new LegalMarkdownService();
afterAll(() => svc.onModuleDestroy());

const issuesOf = async (md: string) => {
  try {
    await svc.validate(md);
  } catch (e) {
    return (e as ApiException).getResponse() as {
      statusCode: number;
      errorCode: string;
      details: { issues: { line: number; reason: string }[] };
    };
  }
  return null;
};

describe('LegalMarkdownService.validate (bounded time, QA D1)', () => {
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
    expect(ms).toBeLessThan(MAX_MS);
  });

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

  it('realistic legal document (~100 KB, 3-4 level lists, tables, links) validates quickly', async () => {
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
    expect(md.length).toBeLessThan(LEGAL_MD_LIMITS.maxBytes);
    const t = performance.now();
    await svc.validate(md);
    expect(performance.now() - t).toBeLessThan(MAX_MS);
  });
});
