import { describe, expect, it } from 'vitest';
import { ApiException } from './api-exception.js';
import { assertNoIdDocInQuery } from './id-doc-not-in-url.js';

const run = (q: Record<string, unknown> | undefined) =>
  assertNoIdDocInQuery(q, 'POST /x');

describe('assertNoIdDocInQuery (FR-124: a cedula never travels in a URL)', () => {
  it.each([
    { idDoc: 'V-12345678' },
    { idDoc: ['V-12345678'] }, // ?idDoc[]=
    { idDoc: { a: 'V-12345678' } }, // ?idDoc[a]=
    { idDoc: ['V-1', 'V-2'] },
    { IDDOC: 'x' },
    { id_doc: 'x' },
    { recipientIdDoc: 'x' },
    { buyerIdDoc: 'x' },
    { cedula: 'x' },
    { status: 'paid', idDoc: '' },
  ])('rejects %j with 400 and no echo of the value', (q) => {
    try {
      run(q);
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ApiException);
      const body = (e as ApiException).getResponse() as {
        statusCode: number;
        errorCode: string;
        message: string;
        details: unknown;
      };
      expect(body.statusCode).toBe(400);
      expect(body.errorCode).toBe('ID_DOC_IN_URL_NOT_ALLOWED');
      expect(body.details).toEqual({ reason: 'USE_POST_SEARCH' });
      expect(JSON.stringify(body)).not.toMatch(/V-1|12345678/);
    }
  });

  it.each([undefined, {}, { page: '1', status: 'paid', sortOrder: 'asc' }])(
    'lets %j through',
    (q) => {
      expect(() => run(q)).not.toThrow();
    },
  );
});
