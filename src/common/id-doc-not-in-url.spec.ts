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
    // Story 20.6: the holes of the first version
    { 'id-doc': 'x' },
    { 'id.doc': 'x' },
    { 'id doc': 'x' },
    { id_document: 'x' },
    { idDocument: 'x' },
    { rif: 'J-123456789' },
    { RIF: 'x' },
    { documento: 'x' },
    { ci: 'x' },
    { CI: 'x' },
    { dni: 'x' },
    { 'filter[idDoc]': 'x' },
    { filter: { idDoc: 'x' } },
    { filter: [{ ci: 'x' }] },
    { cédula: 'x' },
    { 'national-id': 'x' },
    // ... and a value with the SHAPE of a cedula under any key
    { q: 'V12345678' },
    { q: 'v-12.345.678' },
    { q: 'V 12 345 678' },
    { q: 'J-123456789-5' },
    { q: '12.345.678' },
    { q: 'cedula 12345678' },
    { q: 'C.I. 12345678' },
    { q: 'juan perez V12345678' },
    { q: ['ana', 'E-1234567'] },
    { search: 'g-200123456' },
    { whatever: { deep: ['x', 'P-12345678'] } },
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

  it.each([
    undefined,
    {},
    { page: '1', status: 'paid', sortOrder: 'asc' },
    // Story 20.6: no false positives
    { q: 'ana' },
    { q: 'ana@example.com' },
    { q: 'v12345678@gmail.com' }, // an email whose local part looks like a cedula is still an email
    { q: 'pedro perez' },
    { q: '04141234567' },
    { q: '12345678' }, // a bare number is not flagged: a phone fragment or an order number
    { q: 'v1234' },
    { q: 'ORD-2026-11-03' },
    { q: 'e1234567-89ab-4cde-8f01-234567890abc' }, // first segment of a UUID
    { orderId: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d' },
    { customerId: 'e1234567-89ab-4cde-8f01-234567890abc' },
    { cursor: 'eyJjcmVhdGVkQXQiOiJWMTIzNDU2NzgifQ' },
    { cursor: 'V12345678' }, // opaque value, never scanned
    {
      circuit: '1',
      rifle: '2',
      docs: '3',
      document: 'terminos',
      decision: 'x',
    },
    { 'order-id': '1', cursorId: '2', pedido: '3' },
    { amount: '1.234.567,89' },
  ])('lets %j through', (q) => {
    expect(() => run(q)).not.toThrow();
  });
});
