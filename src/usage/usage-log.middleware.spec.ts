import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import {
  buildUsageRow,
  cleanIp,
  cleanUserAgent,
  createUsageLogMiddleware,
} from './usage-log.middleware.js';
import type { UsageLogRow } from './usage-log.types.js';

const RID = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const USER = '44444444-4444-4444-8444-444444444444';
const CUST = '55555555-5555-4555-8555-555555555555';

function fake(over: Record<string, unknown> = {}) {
  const req = {
    method: 'GET',
    originalUrl:
      '/api/v1/orders/lookup/SECRET-TOKEN?idDoc=V-12345678&token=abc&next=/x',
    url: '/api/v1/orders/lookup/SECRET-TOKEN?idDoc=V-12345678',
    route: { path: '/api/v1/orders/lookup/:token' },
    ip: '203.0.113.7',
    headers: {
      'user-agent': 'Mozilla/5.0 (X11; Linux x86_64)',
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.aaaaaaaa.bbbbbbbb',
      cookie: 'cc_session=SESSIONSECRET; cartId=CARTSECRET',
    },
    body: { password: 'hunter2hunter2', idDoc: 'V-12345678' },
    query: { idDoc: 'V-12345678' },
    params: { token: 'SECRET-TOKEN' },
    ...over,
  };
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    getHeader: (h: string) =>
      h.toLowerCase() === 'x-request-id' ? RID : undefined,
  });
  return { req, res };
}

describe('buildUsageRow (Story 20.7, AC2/AC3/AC7)', () => {
  it('records the template and the clean fields, and NOTHING of the URL, headers or body', () => {
    const { req, res } = fake();
    const row = buildUsageRow(
      req as never,
      res as never,
      process.hrtime.bigint(),
    );
    expect(row).toMatchObject({
      method: 'GET',
      route: '/api/v1/orders/lookup/:token',
      status: 200,
      actorType: 'ANON',
      actorId: null,
      ip: '203.0.113.7',
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
      requestId: RID,
    });
    // the sentinel sweep: no value of the request is anywhere in the row
    const json = JSON.stringify(row);
    for (const s of [
      'SECRET-TOKEN',
      'V-12345678',
      '12345678',
      'SESSIONSECRET',
      'CARTSECRET',
      'eyJhbGci',
      'hunter2',
      'token=abc',
      'next=',
    ]) {
      expect(json).not.toContain(s);
    }
    expect(Object.keys(row!).sort()).toEqual(
      [
        'actorId',
        'actorType',
        'durationMs',
        'ip',
        'method',
        'requestId',
        'route',
        'status',
        'ts',
        'userAgent',
      ].sort(),
    );
  });

  it('a 404 is __unmatched__ (no template, so no path at all)', () => {
    const { req, res } = fake({
      route: undefined,
      originalUrl: '/api/v1/orders/lookup/SECRET?x=V12345678',
    });
    res.statusCode = 404;
    const row = buildUsageRow(
      req as never,
      res as never,
      process.hrtime.bigint(),
    );
    expect(row).toMatchObject({ route: '__unmatched__', status: 404 });
    expect(JSON.stringify(row)).not.toContain('SECRET');
  });

  it('actor: an admin, a customer, or nobody (an admin wins)', () => {
    const a = fake({ user: { id: USER } });
    expect(buildUsageRow(a.req as never, a.res as never, 0n)).toMatchObject({
      actorType: 'ADMIN',
      actorId: USER,
    });
    const c = fake({ customer: { id: CUST } });
    expect(buildUsageRow(c.req as never, c.res as never, 0n)).toMatchObject({
      actorType: 'CUSTOMER',
      actorId: CUST,
    });
    const both = fake({ user: { id: USER }, customer: { id: CUST } });
    expect(
      buildUsageRow(both.req as never, both.res as never, 0n),
    ).toMatchObject({ actorType: 'ADMIN' });
    const bad = fake({ customer: { id: "not-a-uuid'; DROP TABLE" } });
    expect(buildUsageRow(bad.req as never, bad.res as never, 0n)).toMatchObject(
      { actorType: 'ANON', actorId: null },
    );
  });

  it.each([
    '/api/v1/health',
    '/uploads/public/products/x.png',
    '/api/docs',
    '/api/v1/admin/audit/usage?x=1',
  ])('%s is not recorded', (url) => {
    const { req, res } = fake({ originalUrl: url, route: undefined });
    expect(buildUsageRow(req as never, res as never, 0n)).toBeNull();
  });

  it('the Stripe webhook is recorded without its body', () => {
    const { req, res } = fake({
      method: 'POST',
      originalUrl: '/api/v1/payments/stripe/webhook',
      route: { path: '/api/v1/payments/stripe/webhook' },
      rawBody: Buffer.from('{"data":{"object":{"customer_email":"x@y.co"}}}'),
      body: { data: { object: { customer_email: 'x@y.co' } } },
    });
    const row = buildUsageRow(req as never, res as never, 0n);
    expect(row).toMatchObject({
      method: 'POST',
      route: '/api/v1/payments/stripe/webhook',
    });
    expect(JSON.stringify(row)).not.toContain('x@y.co');
  });

  it('a weird method or status cannot poison a batch', () => {
    const { req, res } = fake({ method: 'GET; DROP' });
    res.statusCode = 99999;
    expect(buildUsageRow(req as never, res as never, 0n)).toMatchObject({
      method: 'OTHER',
      status: 0,
    });
  });

  it('durationMs is a non-negative integer', () => {
    const { req, res } = fake();
    const r = buildUsageRow(
      req as never,
      res as never,
      process.hrtime.bigint() - 5_000_000n,
    )!;
    expect(Number.isInteger(r.durationMs)).toBe(true);
    expect(r.durationMs).toBeGreaterThanOrEqual(5);
  });
});

describe('cleanIp', () => {
  it.each([
    ['203.0.113.7', '203.0.113.7'],
    ['::1', '::1'],
    ['2001:db8::1', '2001:db8::1'],
    ['::ffff:203.0.113.7', '::ffff:203.0.113.7'],
    ['fe80::1%eth0', 'fe80::1'],
  ])('%s', (raw, out) => {
    expect(cleanIp(raw)).toBe(out);
  });
  it.each([
    undefined,
    null,
    '',
    'not an ip',
    '999.1.1.1',
    "1.1.1.1'; --",
    'x'.repeat(100),
    42,
  ])('%j is null', (raw) => {
    expect(cleanIp(raw)).toBeNull();
  });
});

describe('cleanUserAgent', () => {
  it('is cut to 200 code points (never in the middle of a pair) and has no control characters', () => {
    const ua = `A\u0000B\r\n${'😀'.repeat(300)}`;
    const out = cleanUserAgent(ua)!;
    expect(Array.from(out).length).toBeLessThanOrEqual(200);
    // eslint-disable-next-line no-control-regex
    expect(out).not.toMatch(/[\u0000-\u001f]/);
    expect(out.startsWith('A B')).toBe(true);
    // a valid string: no lone surrogate
    expect(out).toBe(out.normalize());
    expect(() => encodeURIComponent(out)).not.toThrow();
  });
  it('masks a contact e-mail, a cedula, a token', () => {
    const out = cleanUserAgent(
      'Bot/1.0 (+contact: webmaster@example.com; V-12345678) token=abcdef123456',
    )!;
    expect(out).not.toContain('webmaster@example.com');
    expect(out).not.toContain('12345678');
    expect(out).not.toContain('abcdef123456');
  });
  it('a normal browser string is kept as is', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    expect(cleanUserAgent(ua)).toBe(ua);
  });
  it.each([undefined, null, '', '   ', 5, ['a']])('%j is null', (raw) => {
    expect(cleanUserAgent(raw)).toBeNull();
  });
});

describe('createUsageLogMiddleware', () => {
  it('queues ONE row on finish, synchronously, and calls next first', () => {
    const rows: UsageLogRow[] = [];
    const mw = createUsageLogMiddleware({
      push: (r: UsageLogRow) => rows.push(r),
    } as never);
    const { req, res } = fake();
    let nexted = false;
    mw(req as never, res as never, () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(rows).toHaveLength(0);
    res.emit('finish');
    res.emit('finish');
    expect(rows).toHaveLength(1);
  });

  it('Story 20.7 round 2: a connection that closes WITHOUT finishing is recorded once, as 499, with the route if the router got there', () => {
    const rows: UsageLogRow[] = [];
    const mw = createUsageLogMiddleware({
      push: (r: UsageLogRow) => rows.push(r),
    } as never);
    const { req, res } = fake({ user: { id: USER } });
    Object.assign(res, { writableFinished: false });
    mw(req as never, res as never, () => undefined);
    res.emit('close');
    res.emit('close');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      status: 499,
      route: '/api/v1/orders/lookup/:token',
      actorType: 'ADMIN',
      actorId: USER,
    });
    expect(rows[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it('cut before the router matched anything (still reading the body): __unmatched__ + 499, anonymous', () => {
    const rows: UsageLogRow[] = [];
    const mw = createUsageLogMiddleware({
      push: (r: UsageLogRow) => rows.push(r),
    } as never);
    const { req, res } = fake({
      route: undefined,
      originalUrl: '/api/v1/auth/login',
    });
    Object.assign(res, { writableFinished: false });
    mw(req as never, res as never, () => undefined);
    res.emit('close');
    expect(rows).toEqual([
      expect.objectContaining({
        status: 499,
        route: '__unmatched__',
        actorType: 'ANON',
      }),
    ]);
  });

  it('finish then close (every normal response, and every keep-alive request) is ONE row with the real status', () => {
    const rows: UsageLogRow[] = [];
    const mw = createUsageLogMiddleware({
      push: (r: UsageLogRow) => rows.push(r),
    } as never);
    const { req, res } = fake();
    res.statusCode = 201;
    Object.assign(res, { writableFinished: true });
    mw(req as never, res as never, () => undefined);
    res.emit('finish');
    res.emit('close');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(201);
  });

  it('a close after a completed response never turns into a 499 (writableFinished)', () => {
    const rows: UsageLogRow[] = [];
    const mw = createUsageLogMiddleware({
      push: (r: UsageLogRow) => rows.push(r),
    } as never);
    const { req, res } = fake();
    Object.assign(res, { writableFinished: true });
    mw(req as never, res as never, () => undefined);
    res.emit('close'); // without a preceding `finish` event in this double
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe(200);
  });

  it('an error inside never reaches the response', () => {
    const mw = createUsageLogMiddleware({
      push: () => {
        throw new Error('boom');
      },
    } as never);
    const { req, res } = fake();
    mw(req as never, res as never, () => undefined);
    expect(() => res.emit('finish')).not.toThrow();
  });
});
