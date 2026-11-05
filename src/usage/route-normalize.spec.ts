import { describe, expect, it } from 'vitest';
import {
  UNMATCHED_ROUTE,
  isExcludedRequest,
  normalizeRoute,
  pathnameOf,
} from './route-normalize.js';

describe('normalizeRoute (Story 20.7, AC3)', () => {
  it('is the matched TEMPLATE, never the value of a parameter', () => {
    expect(
      normalizeRoute({ route: { path: '/api/v1/orders/lookup/:token' } }),
    ).toBe('/api/v1/orders/lookup/:token');
    expect(
      normalizeRoute({ route: { path: '/api/v1/admin/orders/:orderId' } }),
    ).toBe('/api/v1/admin/orders/:orderId');
  });

  it('a 404 (no route) is __unmatched__, whatever the URL was', () => {
    expect(normalizeRoute({})).toBe(UNMATCHED_ROUTE);
    expect(normalizeRoute({ route: undefined })).toBe('__unmatched__');
  });

  it('a route that is not a plain string template (RegExp, array, empty) is __unmatched__', () => {
    expect(normalizeRoute({ route: { path: /^\/x/ } })).toBe(UNMATCHED_ROUTE);
    expect(normalizeRoute({ route: { path: ['/a', '/b'] } })).toBe(
      UNMATCHED_ROUTE,
    );
    expect(normalizeRoute({ route: { path: '' } })).toBe(UNMATCHED_ROUTE);
    expect(normalizeRoute({ route: { path: 'no-slash' } })).toBe(
      UNMATCHED_ROUTE,
    );
  });

  it('the query is ignored: the function never sees the URL, and a "?" in a template is cut', () => {
    expect(
      normalizeRoute({ route: { path: '/api/v1/catalog/products?idDoc=V1' } }),
    ).toBe('/api/v1/catalog/products');
    expect(normalizeRoute({ route: { path: '/x#frag' } })).toBe('/x');
  });

  it('is at most 200 characters and has no control characters', () => {
    const long = `/${'a'.repeat(400)}`;
    expect(normalizeRoute({ route: { path: long } })).toHaveLength(200);
    expect(normalizeRoute({ route: { path: '/a\u0000b\nc' } })).toBe('/abc');
  });
});

describe('isExcludedRequest (AC2)', () => {
  const none = {};
  it.each([
    '/api/v1/health',
    '/api/v1/health?x=1',
    '/uploads/public/products/a.png',
    '/api/docs',
    '/api/docs-json',
    '/api/docs/swagger-ui.css',
    '/api/v1/admin/audit/usage',
    '/api/v1/admin/audit/usage/stats?x=1',
    // Express routes case-insensitively and collapses nothing: the exclusion must not depend on either
    '/API/V1/HEALTH',
    '/Uploads/x',
    '//api//v1//admin//audit//usage',
  ])('%s is not recorded', (url) => {
    expect(isExcludedRequest(none, url)).toBe(true);
  });

  it('is decided by the matched template too', () => {
    expect(
      isExcludedRequest(
        { route: { path: '/api/v1/admin/audit/usage' } },
        '/whatever',
      ),
    ).toBe(true);
  });

  it.each([
    '/api/v1/orders/lookup/abc',
    '/api/v1/admin/audit/events',
    '/api/v1/catalog/products?next=/api/v1/health',
    '/api/v1/auth/login',
    '/uploads',
  ])('%s is recorded', (url) => {
    expect(isExcludedRequest(none, url)).toBe(false);
  });

  it('pathnameOf drops the query and fragment', () => {
    expect(pathnameOf('/A/b?q=/api/docs#x')).toBe('/a/b');
  });
});
