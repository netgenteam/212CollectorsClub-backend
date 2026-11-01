import { DolarApiProvider } from './dolar-api.provider.js';

const body = [
  {
    fuente: 'oficial',
    promedio: 889.26,
    fechaActualizacion: '2026-11-01T10:00:00.000Z',
  },
  {
    fuente: 'paralelo',
    promedio: 1000.5,
    fechaActualizacion: '2026-11-01T11:00:00.000Z',
  },
];
const json = (b: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(b), { status }));

function make(...responses: Array<() => Promise<Response>>) {
  const fetchFn = vi.fn();
  responses.forEach((r) => fetchFn.mockImplementationOnce(r));
  const sleep = vi.fn().mockResolvedValue(undefined);
  const p = new DolarApiProvider(
    'http://x.test/',
    1000,
    fetchFn as never,
    sleep,
  );
  return { p, fetchFn, sleep };
}

describe('DolarApiProvider (fetch mocked, no network)', () => {
  it('maps BCV_USD, PARALELO_USD, BCV_EUR to endpoint + fuente', async () => {
    const a = make(() => json(body));
    expect(await a.p.fetchRate('BCV_USD')).toEqual({
      ok: true,
      reading: {
        rate: 889.26,
        providerUpdatedAt: new Date('2026-11-01T10:00:00.000Z'),
      },
    });
    expect(a.fetchFn.mock.calls[0][0]).toBe('http://x.test/v1/dolares');
    expect((a.fetchFn.mock.calls[0][1] as RequestInit).signal).toBeInstanceOf(
      AbortSignal,
    );

    const b = make(() => json(body));
    const r = await b.p.fetchRate('PARALELO_USD');
    expect(r.ok && r.reading.rate).toBe(1000.5);

    const c = make(() =>
      json([
        {
          fuente: 'oficial',
          promedio: '1010.1',
          fechaActualizacion: '2026-11-01T10:00:00Z',
        },
      ]),
    );
    const e = await c.p.fetchRate('BCV_EUR');
    expect(e.ok && e.reading.rate).toBe(1010.1);
    expect(c.fetchFn.mock.calls[0][0]).toBe('http://x.test/v1/euros');
  });

  it('retries once after 500 ms on 5xx, network and timeout', async () => {
    const a = make(
      () => json({}, 503),
      () => json(body),
    );
    expect((await a.p.fetchRate('BCV_USD')).ok).toBe(true);
    expect(a.fetchFn).toHaveBeenCalledTimes(2);
    expect(a.sleep).toHaveBeenCalledWith(500);

    const b = make(
      () => Promise.reject(new TypeError('fetch failed')),
      () => json(body),
    );
    expect((await b.p.fetchRate('BCV_USD')).ok).toBe(true);

    const tErr = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const c = make(
      () => Promise.reject(tErr),
      () => Promise.reject(tErr),
    );
    const r = await c.p.fetchRate('BCV_USD');
    expect(r).toEqual({ ok: false, error: 'provider timeout' });
    expect(c.fetchFn).toHaveBeenCalledTimes(2);
  });

  it('does not retry on 4xx', async () => {
    const a = make(() => json({}, 404));
    expect(await a.p.fetchRate('BCV_USD')).toEqual({
      ok: false,
      error: 'provider HTTP 404',
    });
    expect(a.fetchFn).toHaveBeenCalledTimes(1);
    expect(a.sleep).not.toHaveBeenCalled();
  });

  it.each([
    ['not an array', { fuente: 'oficial' }],
    [
      'source missing',
      [
        {
          fuente: 'bcv',
          promedio: 1,
          fechaActualizacion: '2026-11-01T10:00:00Z',
        },
      ],
    ],
    [
      'promedio not numeric',
      [
        {
          fuente: 'oficial',
          promedio: 'abc',
          fechaActualizacion: '2026-11-01T10:00:00Z',
        },
      ],
    ],
    [
      'promedio absent',
      [{ fuente: 'oficial', fechaActualizacion: '2026-11-01T10:00:00Z' }],
    ],
    [
      'bad date',
      [{ fuente: 'oficial', promedio: 1, fechaActualizacion: 'nope' }],
    ],
  ])(
    'unexpected shape (%s) is a provider error, not an exception',
    async (_n, b) => {
      const a = make(() => json(b));
      const r = await a.p.fetchRate('BCV_USD');
      expect(r.ok).toBe(false);
      expect(a.fetchFn).toHaveBeenCalledTimes(1);
    },
  );
});
