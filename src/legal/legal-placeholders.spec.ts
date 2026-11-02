import { detectPlaceholders } from './legal-placeholders.js';

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

  it('lower-case or malformed tokens do not count (no false positives)', () => {
    expect(
      detectPlaceholders('[[x]] [[Rif]] [[A]] [[1ABC]] [RIF] [[ RIF ]] [[RIF]'),
    ).toEqual([]);
    expect(detectPlaceholders('[[A_]]')).toEqual([
      { token: '[[A_]]', line: 1 },
    ]);
    expect(detectPlaceholders(`[[${'A'.repeat(42)}]]`)).toEqual([]);
    expect(detectPlaceholders(`[[${'A'.repeat(41)}]]`)).toHaveLength(1);
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
});
