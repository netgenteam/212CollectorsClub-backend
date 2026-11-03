import {
  detectPlaceholders,
  findTemplateNotice,
  LEGAL_TEMPLATE_NOTICE,
  MAX_PLACEHOLDER_LENGTH,
} from './legal-placeholders.js';

describe('detectPlaceholders', () => {
  it('finds several per line, in order, with the right line', () => {
    expect(
      detectPlaceholders(
        'uno [[RIF]] y [[RAZON_SOCIAL]]\n\nlinea 3 [[TELEFONO]]',
      ),
    ).toEqual([
      { token: '[[RIF]]', line: 1 },
      { token: '[[RAZON_SOCIAL]]', line: 1 },
      { token: '[[TELEFONO]]', line: 3 },
    ]);
  });

  // Story 19.3a DECISION: `detectPlaceholders` stays strict on purpose: it
  // counts only well-formed KNOWN-style tokens (the `PUT draft` counter).
  // That `[[Rif]]`, `[[ RIF ]]` or `[[RIF]` are "not placeholders" here does
  // NOT make them publishable: `publish` also rejects any `[[`/`]]` left in
  // the normalized visible text (see legal-residual.spec.ts and the e2e).
  it('lower-case or malformed tokens are not COUNTED as tokens (publish still rejects them, 19.3a)', () => {
    expect(
      detectPlaceholders('[[x]] [[Rif]] [[A]] [[1ABC]] [RIF] [[ RIF ]] [[RIF]'),
    ).toEqual([]);
    expect(detectPlaceholders('[[A_]]')).toEqual([
      { token: '[[A_]]', line: 1 },
    ]);
    expect(
      detectPlaceholders(`[[${'A'.repeat(MAX_PLACEHOLDER_LENGTH + 1)}]]`),
    ).toEqual([]);
    expect(
      detectPlaceholders(`[[${'A'.repeat(MAX_PLACEHOLDER_LENGTH)}]]`),
    ).toHaveLength(1);
  });

  it('also inside code (conservative)', () => {
    const md = 'texto\n```\n[[DOMICILIO_FISCAL]]\n```\n`[[EMAIL_CONTACTO]]`';
    expect(detectPlaceholders(md)).toEqual([
      { token: '[[DOMICILIO_FISCAL]]', line: 3 },
      { token: '[[EMAIL_CONTACTO]]', line: 5 },
    ]);
  });

  it('counts CRLF and lone CR as line breaks', () => {
    expect(detectPlaceholders('a\r\nb\r\n[[RIF]]\r[[RIF]]')).toEqual([
      { token: '[[RIF]]', line: 3 },
      { token: '[[RIF]]', line: 4 },
    ]);
  });

  it('is stateless across calls and handles empty input', () => {
    expect(detectPlaceholders('')).toEqual([]);
    expect(detectPlaceholders('[[RIF]]')).toHaveLength(1);
    expect(detectPlaceholders('[[RIF]]')).toHaveLength(1);
  });

  it('N3: accented / Unicode upper-case names are placeholders too', () => {
    const md =
      'a [[RAZÓN_SOCIAL]] b\n[[DIRECCIÓN]] [[AÑO_2026]] [[RAZO\u0301N]]';
    expect(detectPlaceholders(md).map((p) => p.token)).toEqual([
      '[[RAZÓN_SOCIAL]]',
      '[[DIRECCIÓN]]',
      '[[AÑO_2026]]',
      '[[RAZO\u0301N]]',
    ]);
    expect(detectPlaceholders(md)[1].line).toBe(2);
    expect(detectPlaceholders('[[razón_social]] [[Razón]] [[ó]]')).toEqual([]);
  });
});

describe('detectPlaceholders: long, formatted and embedded tokens (Story 19.3 fix)', () => {
  it('a 42+ character descriptive token is detected (it was silently skipped at >41)', () => {
    const long = '[[CONFIRMAR_CIFRADO_Y_RETENCION_IMPLEMENTADOS]]';
    expect(long.length - 4).toBeGreaterThan(41);
    expect(detectPlaceholders(`texto ${long}.`)).toEqual([
      { token: long, line: 1 },
    ]);
  });

  it.each([
    ['digits', '[[PLAZO_30_DIAS]]'],
    ['bold', '**[[RIF]]**'],
    ['italic', '_[[RIF]]_'],
    ['link text', '[ver [[RIF]]](/aviso-legal)'],
    ['link target', '[x](/a/[[RIF]])'],
    ['inline code', '`[[RIF]]`'],
    ['fenced code', '```\n[[RIF]]\n```'],
    ['table cell', '| a | [[RIF]] |'],
    ['heading', '## [[RIF]]'],
    ['blockquote', '> [[RIF]]'],
    ['accents', '[[DIRECCIÓN_FISCAL]]'],
  ])('%s: detected', (_n, md) => {
    expect(detectPlaceholders(md)).toHaveLength(1);
  });

  it('every [[ in a real-looking template is accounted for (grep parity)', () => {
    const md = '[[A_B]] **[[C_D]]** `[[E_F]]` [[G_H]][[I_J]]';
    expect(detectPlaceholders(md)).toHaveLength(
      (md.match(/\[\[/g) ?? []).length,
    );
  });
});

describe('findTemplateNotice (Story 19.3 G)', () => {
  it('finds the template phrase and reports its line', () => {
    expect(
      findTemplateNotice(`# Hola\n\n> **${LEGAL_TEMPLATE_NOTICE}.** x`),
    ).toBe(3);
  });

  it.each([
    ['upper case', LEGAL_TEMPLATE_NOTICE.toUpperCase()],
    [
      'extra spaces',
      'Plantilla  —   revisar con un abogado   antes de publicar',
    ],
    ['hyphen', 'Plantilla - revisar con un abogado antes de publicar'],
    ['en dash', 'Plantilla – revisar con un abogado antes de publicar'],
    [
      'markdown emphasis',
      '**Plantilla** — _revisar_ con un `abogado` antes de publicar',
    ],
    ['line break', 'Plantilla — revisar con un\nabogado antes de publicar'],
    ['nbsp', 'Plantilla\u00a0—\u00a0revisar con un abogado antes de publicar'],
  ])('%s: still found', (_n, md) => {
    expect(findTemplateNotice(md)).not.toBeNull();
  });

  it('absent in ordinary text', () => {
    expect(
      findTemplateNotice('Esta plantilla de cartas es otra cosa.'),
    ).toBeNull();
    expect(findTemplateNotice('')).toBeNull();
  });
});
