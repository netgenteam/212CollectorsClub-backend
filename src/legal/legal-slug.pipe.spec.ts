import { ApiException } from '../common/api-exception.js';
import { LegalSlugPipe, parseVersionNumber } from './legal-slug.pipe.js';
import { LEGAL_SLUGS } from './legal-slugs.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    const r = (e as ApiException).getResponse() as {
      statusCode: number;
      errorCode: string;
    };
    return `${r.statusCode} ${r.errorCode}`;
  }
  return 'ok';
};

describe('LegalSlugPipe', () => {
  const pipe = new LegalSlugPipe();
  it.each([...LEGAL_SLUGS])('accepts %s', (s) => {
    expect(pipe.transform(s)).toBe(s);
  });
  it.each([
    '',
    'identity',
    'Terminos',
    'terminos ',
    '../x',
    'e2e-',
    'e2e-A',
    'x'.repeat(200),
  ])('404 for %j', (s) => {
    expect(code(() => pipe.transform(s))).toBe('404 LEGAL_DOCUMENT_NOT_FOUND');
  });
  it('lets sandbox-format slugs through (the DB decides)', () => {
    expect(pipe.transform('e2e-abc-123')).toBe('e2e-abc-123');
  });
  it('N1: sandbox slugs are 404 in production, the six real ones still pass', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      expect(code(() => pipe.transform('e2e-abc-123'))).toBe(
        '404 LEGAL_DOCUMENT_NOT_FOUND',
      );
      for (const s of LEGAL_SLUGS) expect(pipe.transform(s)).toBe(s);
    } finally {
      process.env.NODE_ENV = prev;
    }
    expect(pipe.transform('e2e-abc-123')).toBe('e2e-abc-123');
  });
});

describe('parseVersionNumber', () => {
  const pipe = { transform: parseVersionNumber };
  it('accepts positive ints', () => {
    expect(pipe.transform('1')).toBe(1);
    expect(pipe.transform('2147483647')).toBe(2147483647);
  });
  it.each([
    '0',
    '-1',
    'abc',
    '1.5',
    '1e3',
    ' 1',
    '',
    '2147483648',
    '99999999999999999999',
    '0x10',
  ])('400 for %j', (v) => {
    expect(code(() => pipe.transform(v))).toBe('400 LEGAL_VERSION_INVALID');
  });
});
