import { findResiduals } from './legal-residual.core.mjs';
import {
  LegalMarkdownService,
  type LegalResidual,
} from './legal-markdown.service.js';
import { LEGAL_TEMPLATE_NOTICE } from './legal-placeholders.js';

/**
 * Story 19.3a (AD-90): what is left of a marker or of the template notice in
 * the text the PUBLIC reads. Runs the REAL worker, so the AST normalization
 * (entities, escapes, quote prefixes, emphasis, links) is the one in production.
 */
const svc = new LegalMarkdownService();
afterAll(() => svc.onModuleDestroy());
const residuals = async (md: string): Promise<LegalResidual[]> =>
  (await svc.validate(md)).residuals;
const Z = '​';
const N = ' ';
const SHY = '­';

describe('residual markers ([[ / ]]) in the visible text', () => {
  it.each([
    ['[[rif]]'],
    ['[[ RIF ]]'],
    ['[[RIF ]]'],
    ['[[RIF]'],
    ['[[Rif]]'],
    ['[[X]]'],
    ['[[1ABC]]'],
    [`[[${'A'.repeat(81)}]]`],
    ['antes [[ despues'],
    ['[[RAZON-SOCIAL]]'],
    ['[[RAZON.SOCIAL]]'],
    ['[[**RIF**]]'],
    [`[[R${Z}IF]]`],
    [`[[${N}RIF${N}]]`],
    ['［［RIF］］'],
    ['[[RI\nF]]'],
    ['&#91;&#91;RIF]]'],
    ['\\[\\[RIF]]'],
    ['[*[*RIF]]'],
    ['`[[RIF]]`'],
    ['```\n[[RIF]]\n```'],
    ['sobra ]] cierre'],
    ['| a | b |\n|---|---|\n| [[RIF]] | x |'],
    ['> cita [[RIF]]'],
  ])('rejects %j', async (md) => {
    const r = await residuals(md);
    expect(r.length).toBeGreaterThanOrEqual(1);
    expect(r.every((i) => typeof i.token === 'string' && i.line >= 1)).toBe(
      true,
    );
  });

  it('reports the ORIGINAL line, once per marker, with the visible token', async () => {
    expect(
      await residuals('uno\n\n> dos\n> tres [[ **RIF** ]] fin\n\nx'),
    ).toEqual([{ token: '[[ RIF ]]', line: 4 }]);
    expect(await residuals('a\n\n```\nx\n[[RIF]]\n```')).toEqual([
      { token: '[[RIF]]', line: 5 },
    ]);
    expect(await residuals('a\n\n| a | b |\n|---|---|\n| [[X]] | y |')).toEqual(
      [{ token: '[[X]]', line: 5 }],
    );
  });

  it('DECISION: harmless brackets and normal link syntax still pass', async () => {
    for (const md of [
      'ver [1] y [2]',
      'un [corchete] simple',
      '[texto](https://e.test) normal',
      '[a][b]\n\n[b]: https://e.test',
      '[sin definir][ref]',
      'lista [a] [b] [c]',
      '![no](https://e.test/i.png)'.replace('!', ''),
      'plantilla de correo; consulte a un abogado',
    ]) {
      expect(await residuals(md)).toEqual([]);
    }
  });

  it('DECISION: `[[a](b)]` (a bracketed link, visible "[a]") passes; a stray `]]` does not', async () => {
    expect(await residuals('[[a](https://e.test)]')).toEqual([]);
    expect(await residuals('[a [b](https://e.test)] texto')).toEqual([]);
    expect(await residuals('[a](https://e.test)]]')).toEqual([
      { token: ']]', line: 1 },
    ]);
  });
});

describe('template notice in the visible text', () => {
  const notice = { token: LEGAL_TEMPLATE_NOTICE, line: 1 };
  it.each([
    ['plain', 'Plantilla — revisar con un abogado antes de publicar'],
    ['--', 'Plantilla -- revisar con un abogado antes de publicar'],
    [
      'em dash, no spaces',
      'Plantilla—revisar con un abogado antes de publicar',
    ],
    [
      'zero-width space',
      `Plantilla —${Z} revisar con un abogado antes de publicar`,
    ],
    [
      'soft hyphen',
      `Plan${SHY}tilla — revisar con un abogado antes de publicar`,
    ],
    ['&mdash;', 'Plantilla &mdash; revisar con un abogado antes de publicar'],
    ['&#8212;', 'Plantilla &#8212; revisar con un abogado antes de publicar'],
    [
      'full-width dash',
      'Plantilla － revisar con un abogado antes de publicar',
    ],
    [
      'Cyrillic homoglyph',
      'Plаntilla — revisar con un abogado antes de publicar',
    ],
    [
      'homoglyph in the other words',
      'Plantilla — revіsar con un abogadо antes de publicar',
    ],
    [
      'emphasis',
      '**Plantilla** _—_ *revisar con un abogado* antes de publicar',
    ],
    [
      'wrapped blockquote',
      '> Plantilla — revisar con un\n> abogado antes de publicar',
    ],
    [
      'link in the middle',
      'Plantilla [—](https://e.test) revisar con un abogado antes de publicar',
    ],
    [
      'link wraps words',
      'Plantilla — [revisar con un abogado](https://e.test) antes de publicar',
    ],
    [
      'split table',
      '| Plantilla — revisar | con un abogado |\n|---|---|\n| antes de | publicar |',
    ],
    [
      'upper case + accents',
      'PLANTÍLLA — REVISAR CON UN ABOGADO ANTES DE PUBLICAR',
    ],
    ['only the partial phrase', 'Revisar con un abogado antes de publicar.'],
  ])('rejects: %s', async (_n, md) => {
    expect(await residuals(md)).toEqual([notice]);
  });

  it('reports the line where the notice starts', async () => {
    expect(
      await residuals(
        'a\n\n> Plantilla —\n> revisar con un\n> abogado antes de publicar',
      ),
    ).toEqual([{ token: LEGAL_TEMPLATE_NOTICE, line: 3 }]);
  });

  it('no false positives with "plantilla" or "revisar con un abogado" alone', async () => {
    for (const md of [
      'Usamos una plantilla de correo para avisarte.',
      'Puedes revisar con un abogado tus derechos.',
      'Plantilla: la factura. Revisar con un abogado es opcional. Antes de publicar nada, avisamos.',
      'revisar con un abogado antes de firmar',
    ]) {
      expect(await residuals(md)).toEqual([]);
    }
  });
});

describe('large input', () => {
  // No timing threshold on purpose (it would be load-dependent); the cost
  // (~1-10 ms for 200 KB, inside the worker) is measured and reported in 19.3a.
  it('200 KB of clean text yields no residual and keeps the right line of a late one', () => {
    const para =
      'Texto legal con énfasis, enlaces y acentos: garantía, devolución, envío. — ';
    const big = para.repeat(Math.ceil(190_000 / para.length));
    expect(findResiduals([[big, 1]])).toEqual([]);
    expect(
      findResiduals([
        [big, 1],
        ['\n\n[[RIF]]', 7],
      ]),
    ).toEqual([['marker', '[[RIF]]', 9]]);
  });
});
