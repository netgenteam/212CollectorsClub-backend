import { describe, expect, it } from 'vitest';
import { escapeLike, parseUsageQuery } from './usage-read.service.js';

const code = (q: Record<string, unknown>) => {
  try {
    parseUsageQuery(q);
    return 'ok';
  } catch (e) {
    return (e as { response: { errorCode: string } }).response.errorCode;
  }
};

describe('parseUsageQuery (Story 20.7, AC6)', () => {
  it('accepts every filter', () => {
    const f = parseUsageQuery({
      from: '2026-11-01',
      to: '2026-11-03',
      actorType: 'customer',
      actorId: '55555555-5555-4555-8555-555555555555',
      route: '/api/v1/orders',
      status: '404',
      ip: '203.0.113.0/24',
      requestId: '0A0A0A0A-0A0A-4A0A-8A0A-0A0A0A0A0A0A',
      cursor: '12345',
    });
    expect(f.actorType).toBe('CUSTOMER');
    expect(f.routePrefix).toBe('/api/v1/orders');
    expect(f.status).toBe(404);
    expect(f.toExclusive?.toISOString()).toBe('2026-11-04T00:00:00.000Z');
    expect(f.requestId).toBe('0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a');
    expect(parseUsageQuery({ statusClass: '5xx' }).statusRange).toEqual([
      500, 599,
    ]);
    expect(parseUsageQuery({ ip: '2001:db8::/32' }).ip).toBe('2001:db8::/32');
  });

  it.each([
    [{ from: 'yesterday' }],
    [{ from: '2026-02-30' }],
    [{ from: '2026-11-03', to: '2026-11-01' }],
    [{ actorType: 'root' }],
    [{ actorId: 'abc' }],
    [{ requestId: '1' }],
    [{ route: 'api/v1' }],
    [{ route: `/${'a'.repeat(200)}` }],
    [{ route: '/a\u0000b' }],
    [{ status: '99' }],
    [{ status: '600' }],
    [{ status: 'abc' }],
    [{ statusClass: '6xx' }],
    [{ status: '200', statusClass: '2xx' }],
    [{ ip: 'not-an-ip' }],
    [{ ip: '1.2.3.4/99' }],
    [{ cursor: '0' }],
    [{ cursor: '-5' }],
    [{ cursor: '99999999999999999999' }],
    [{ cursor: 'abc' }],
    [{ status: ['200', '404'] }],
    [{ from: '' }],
  ])('%j -> 400 USAGE_FILTER_INVALID', (q) => {
    expect(code(q)).toBe('USAGE_FILTER_INVALID');
  });

  it('a cedula in the URL is refused before anything else (no value is echoed)', () => {
    for (const q of [
      { idDoc: 'V-12345678' },
      { route: '/orders/V-12345678' },
      { ip: 'V-12345678' },
      { cedula: '1' },
      { 'idDoc[]': 'V1' },
    ]) {
      expect(code(q)).toBe('ID_DOC_IN_URL_NOT_ALLOWED');
    }
  });

  it('escapes LIKE wildcards in the route prefix', () => {
    expect(escapeLike('/a_b%c\\d')).toBe('/a\\_b\\%c\\\\d');
    expect(parseUsageQuery({ route: '/api/v1/%' }).routePrefix).toBe(
      '/api/v1/\\%',
    );
  });
});
