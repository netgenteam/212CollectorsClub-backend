import { describe, expect, it, vi } from 'vitest';
import { RequestContext } from './request-context.js';
import { requestIdMiddleware } from './request-id.middleware.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('requestIdMiddleware (Story 20.1, AD-100)', () => {
  it('generates a v4 uuid, IGNORES the client X-Request-Id, sets the header and opens the context', async () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) };
    const req = {
      ip: '203.0.113.9',
      headers: { 'x-request-id': 'attacker-chosen' },
    };
    let seen: ReturnType<typeof RequestContext.get>;
    const next = vi.fn(() => {
      void new Promise((r) => setTimeout(r, 1)).then(() => {
        seen = RequestContext.get();
      });
    });

    requestIdMiddleware(req as never, res as never, next);
    await new Promise((r) => setTimeout(r, 10));
    expect(headers['X-Request-Id']).toMatch(UUID_V4);
    expect(headers['X-Request-Id']).not.toBe('attacker-chosen');
    expect(seen).toEqual({
      requestId: headers['X-Request-Id'],
      ip: '203.0.113.9',
    });
    expect(RequestContext.get()).toBeUndefined(); // no leak outside the request
  });

  it('two requests never share an id', () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      requestIdMiddleware(
        { ip: undefined } as never,
        { setHeader: (_k: string, v: string) => ids.push(v) } as never,
        () => undefined,
      );
    }
    expect(ids[0]).not.toBe(ids[1]);
  });
});
