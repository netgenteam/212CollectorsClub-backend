import { ApiException } from '../common/api-exception.js';
import {
  LegalMarkdownService,
  slugifyHeading,
  urlRejection,
} from './legal-markdown.service.js';
import { XSS_ACCEPT, XSS_REJECT } from './xss-corpus.js';

const svc = new LegalMarkdownService();

const issuesOf = (md: string) => {
  try {
    svc.validate(md);
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
  it.each(XSS_REJECT.map((c) => [c.name, c.md]))('rejects: %s', (_name, md) => {
    const body = issuesOf(md);
    expect(body).not.toBeNull();
    expect(body?.statusCode).toBe(400);
    expect(body?.errorCode).toBe('LEGAL_MARKDOWN_INVALID');
    expect(body?.details.issues.length).toBeGreaterThan(0);
    for (const i of body?.details.issues ?? []) {
      expect(i.line).toBeGreaterThanOrEqual(1);
      expect(i.reason.length).toBeGreaterThan(3);
    }
  });

  it.each(XSS_ACCEPT.map((c) => [c.name, c.md]))('accepts: %s', (_name, md) => {
    expect(issuesOf(md)).toBeNull();
  });

  it('reports the real 1-based line of each issue', () => {
    const body = issuesOf(
      'ok\n\n[a](javascript:1)\n\ntexto\n\n![](https://x.test/i.png)',
    );
    expect(body?.details.issues.map((i) => i.line)).toEqual([3, 7]);
  });

  it('reports every issue, not just the first', () => {
    const body = issuesOf('<b>a</b> [x](//e.test) ![i](https://e.test/i.png)');
    expect(body?.details.issues.length).toBeGreaterThanOrEqual(4);
  });

  it('is deterministic and does not mutate state between calls', () => {
    expect(issuesOf(XSS_REJECT[0].md)).toEqual(issuesOf(XSS_REJECT[0].md));
    expect(issuesOf('## ok')).toBeNull();
  });

  it('handles an empty document', () => {
    expect(svc.validate('')).toEqual({ toc: [] });
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
  it('only ## and ### with deterministic unique ids (-2, -3)', () => {
    const md = [
      '# Titulo H1',
      '## Datos',
      '### Datos',
      '## Datos',
      '#### cuarto nivel',
      '## Datos',
      '## Envío y devolución',
    ].join('\n\n');
    expect(svc.validate(md).toc).toEqual([
      { depth: 2, text: 'Datos', id: 'datos' },
      { depth: 3, text: 'Datos', id: 'datos-2' },
      { depth: 2, text: 'Datos', id: 'datos-3' },
      { depth: 2, text: 'Datos', id: 'datos-4' },
      { depth: 2, text: 'Envío y devolución', id: 'envio-y-devolucion' },
    ]);
    expect(svc.buildToc(md)).toEqual(svc.buildToc(md));
  });

  it('uses the plain text of headings with formatting and avoids collisions', () => {
    const toc = svc.buildToc(
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

  it('falls back for headings that slugify to nothing', () => {
    expect(svc.buildToc('## ???\n\n## !!!').map((t) => t.id)).toEqual([
      'seccion',
      'seccion-2',
    ]);
    expect(slugifyHeading('  Ñandú -- ¿Qué?  ')).toBe('nandu-que');
  });
});
