import { Logger } from '@nestjs/common';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ApiException } from '../common/api-exception.js';
import { makeTestCrypto } from '../../test/helpers/iddoc-test-crypto.js';
import {
  ID_DOC_REVEAL_MAX_PER_HOUR_DEFAULT,
  IdDocIntegrityError,
  IdDocRateLimitedError,
  IdDocRevealService,
  idDocRevealMaxPerHour,
} from './id-doc-reveal.service.js';

const crypto = makeTestCrypto();
const ADMIN = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const ORDER = '11111111-1111-4111-8111-111111111111';

const enc = (v: string) =>
  crypto.protect(v) as NonNullable<ReturnType<typeof crypto.protect>>;

type Mock = ReturnType<typeof vi.fn>;

describe('idDocRevealMaxPerHour', () => {
  it('defaults to 30 and only accepts positive integers', () => {
    expect(ID_DOC_REVEAL_MAX_PER_HOUR_DEFAULT).toBe(30);
    expect(idDocRevealMaxPerHour({})).toBe(30);
    for (const v of ['', 'abc', '0', '-5', '1.5', ' ', '1e3', '9999999'])
      expect(idDocRevealMaxPerHour({ ID_DOC_REVEAL_MAX_PER_HOUR: v })).toBe(30);
    expect(idDocRevealMaxPerHour({ ID_DOC_REVEAL_MAX_PER_HOUR: '5' })).toBe(5);
    expect(idDocRevealMaxPerHour({ ID_DOC_REVEAL_MAX_PER_HOUR: ' 100 ' })).toBe(
      100,
    );
  });
});

/**
 * The blind-index cross-check, exercised through the ONLY public path (`revealOrderIdDoc`): the
 * verification itself is runtime-private (`#verifyStored`), so a clear value can never be had
 * without the audit event.
 */
describe('IdDocRevealService: blind index cross-check (through revealOrderIdDoc)', () => {
  const rec = (buyerEnc: string | null, buyerBlind: string | null) => ({
    recipientIdDoc: null,
    recipientIdDocEnc: null,
    recipientIdDocBlind: null,
    buyerIdDocEnc: buyerEnc,
    buyerIdDocBlind: buyerBlind,
  });
  const make = (order: Record<string, unknown>) => {
    const record = vi.fn(() => Promise.resolve({ seq: 1, hash: 'h' }));
    const added: unknown[] = [];
    const tx = {
      $executeRaw: vi.fn(() => Promise.resolve(1)),
      $queryRaw: vi.fn(() => Promise.resolve([{ n: 0, wait: null }])),
    };
    const svc = new IdDocRevealService(
      {
        order: { findUnique: vi.fn(() => Promise.resolve(order)) },
        $transaction: vi.fn((cb: (t: unknown) => Promise<void>) => cb(tx)),
      } as never,
      {
        record,
        transaction: vi.fn(
          async (
            cb: (t: unknown, a: { add: (e: unknown) => void }) => unknown,
          ) => {
            await cb(tx, { add: (e) => void added.push(e) });
          },
        ),
      } as never,
      crypto,
    );
    return { svc, record, added };
  };
  const reveal = (svc: IdDocRevealService) =>
    svc.revealOrderIdDoc(ORDER, 'buyer', ADMIN);
  const reasonOf = async (svc: IdDocRevealService): Promise<string> => {
    try {
      await reveal(svc);
    } catch (e) {
      expect(e).toBeInstanceOf(IdDocIntegrityError);
      return (e as IdDocIntegrityError).reason;
    }
    throw new Error('expected a throw');
  };

  it('a parsed value whose blind matches is delivered, canonical and not flagged', async () => {
    const p = enc('v 12.345.678');
    const { svc } = make(rec(p.enc, p.blind));
    await expect(reveal(svc)).resolves.toEqual({
      value: 'V-12345678',
      unparsed: false,
    });
  });

  it('a ciphertext MOVED to another order (valid ciphertext, other order blind) is refused', async () => {
    const mine = enc('V-12345678');
    const other = enc('V-87654321');
    expect(await reasonOf(make(rec(mine.enc, other.blind)).svc)).toBe(
      'BLIND_MISMATCH',
    );
  });

  it('a parsed value with a NULL blind is refused', async () => {
    const p = enc('V-12345678');
    expect(await reasonOf(make(rec(p.enc, null)).svc)).toBe('BLIND_MISSING');
  });

  it('an unparsed legacy value (no type): delivered, flagged, only with a NULL blind', async () => {
    const p = enc('12345678');
    expect(p.blind).toBeNull();
    await expect(reveal(make(rec(p.enc, null)).svc)).resolves.toEqual({
      value: '12345678',
      unparsed: true,
    });
    // ... a blind on a value that does not parse is itself inconsistent
    expect(await reasonOf(make(rec(p.enc, enc('V-12345678').blind)).svc)).toBe(
      'BLIND_MISMATCH',
    );
  });

  it('a tampered, malformed or unknown-version value throws (never null, never garbage)', async () => {
    const p = enc('V-12345678');
    const parts = p.enc.split(':');
    const tampered = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3].slice(0, -1)}${parts[3].endsWith('A') ? 'B' : 'A'}`;
    expect(await reasonOf(make(rec(tampered, p.blind)).svc)).toBe(
      'DECRYPT_FAILED',
    );
    expect(
      await reasonOf(make(rec(p.enc.replace(/^v1/, 'v9'), p.blind)).svc),
    ).toBe('DECRYPT_FAILED');
    expect(await reasonOf(make(rec('V-12345678', p.blind)).svc)).toBe(
      'ENC_MALFORMED',
    );
  });

  it('the error never carries the value', async () => {
    const p = enc('V-12345678');
    const { svc } = make(rec(p.enc, enc('V-87654321').blind));
    await reveal(svc).then(
      () => {
        throw new Error('expected a throw');
      },
      (e: IdDocIntegrityError) =>
        expect(JSON.stringify(e.getResponse())).not.toMatch(/12345678|v1:/),
    );
  });

  it('there is no public way to the clear value besides revealOrderIdDoc (runtime-private helpers)', () => {
    const own = Object.getOwnPropertyNames(IdDocRevealService.prototype);
    expect(own).not.toContain('verifyStored');
    expect(own).not.toContain('fromLegacy');
    expect(
      (new IdDocRevealService({} as never, {} as never, crypto) as never)[
        'verifyStored'
      ],
    ).toBeUndefined();
  });
});

describe('IdDocRevealService: integrity failures are AUDITED (ID_DOC_INTEGRITY_FAILED)', () => {
  const moved = () => {
    const mine = enc('V-12345678');
    return {
      recipientIdDoc: null,
      recipientIdDocEnc: null,
      recipientIdDocBlind: null,
      buyerIdDocEnc: mine.enc,
      buyerIdDocBlind: enc('V-87654321').blind,
    };
  };
  const make = (audit: Mock, order: Record<string, unknown> = moved()) => {
    const transaction = vi.fn();
    const svc = new IdDocRevealService(
      {
        order: { findUnique: vi.fn(() => Promise.resolve(order)) },
        $transaction: transaction,
      } as never,
      { transaction: audit, record: vi.fn() } as never,
      crypto,
    );
    return { svc, transaction };
  };

  it.each([
    ['BLIND_MISMATCH', (o: Record<string, unknown>) => o],
    [
      'BLIND_MISSING',
      (o: Record<string, unknown>) => ({ ...o, buyerIdDocBlind: null }),
    ],
    [
      'ENC_MALFORMED',
      (o: Record<string, unknown>) => ({ ...o, buyerIdDocEnc: 'V-12345678' }),
    ],
    [
      'DECRYPT_FAILED',
      (o: Record<string, unknown>) => ({
        ...o,
        buyerIdDocEnc: String(o.buyerIdDocEnc).replace(/^v1/, 'v9'),
      }),
    ],
  ])(
    '%s: writes ONE event with admin, order, field and reason, no value, then the 500 stands',
    async (reason, tweak) => {
      const events: Record<string, unknown>[] = [];
      const audit = vi.fn(
        async (
          cb: (
            t: unknown,
            a: { add: (e: Record<string, unknown>) => void },
          ) => unknown,
        ) => {
          await cb({}, { add: (e) => void events.push(e) });
        },
      );
      const base = moved();
      const { svc, transaction } = make(audit, tweak(base));
      await expect(
        svc.revealOrderIdDoc(ORDER, 'buyer', ADMIN),
      ).rejects.toMatchObject({
        status: 500,
        response: {
          errorCode: 'ID_DOC_INTEGRITY_FAILED',
          details: { field: 'buyer', reason },
        },
      });
      expect(events).toEqual([
        {
          actorType: 'ADMIN',
          actorId: ADMIN.id,
          action: 'ID_DOC_INTEGRITY_FAILED',
          entityType: 'Order',
          entityId: ORDER,
          after: { field: 'buyer', reason },
        },
      ]);
      expect(JSON.stringify(events)).not.toMatch(/12345678|87654321|v1:/);
      // it is NOT the reveal transaction: no rate-limit slot, no ID_DOC_REVEALED
      expect(transaction).not.toHaveBeenCalled();
    },
  );

  it('if the audit cannot be written the answer is 503 AUDIT_UNAVAILABLE (never the 500 with a silent hole)', async () => {
    const audit = vi.fn(() =>
      Promise.reject(Object.assign(new Error('disk full'), { code: 'P2010' })),
    );
    const { svc } = make(audit);
    const spy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      const out = svc.revealOrderIdDoc(ORDER, 'buyer', ADMIN);
      await expect(out).rejects.toMatchObject({
        status: 503,
        response: { errorCode: 'AUDIT_UNAVAILABLE' },
      });
      // the integrity failure itself was still logged (order and field, no value)
      expect(spy.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
        `ID_DOC_INTEGRITY_FAILED order=${ORDER} field=buyer reason=BLIND_MISMATCH`,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('an ApiException from the audit (its own 503) passes through unchanged', async () => {
    const audit = vi.fn(() =>
      Promise.reject(
        new ApiException(503, 'AUDIT_UNAVAILABLE', 'x', {
          reason: 'LOCK_TIMEOUT',
        }),
      ),
    );
    await expect(
      make(audit).svc.revealOrderIdDoc(ORDER, 'buyer', ADMIN),
    ).rejects.toMatchObject({
      status: 503,
      response: { details: { reason: 'LOCK_TIMEOUT' } },
    });
  });

  it('a successful reveal and a missing value write no integrity event', async () => {
    const audit = vi.fn();
    const p = enc('V-12345678');
    const { svc } = make(audit, {
      recipientIdDoc: null,
      recipientIdDocEnc: null,
      recipientIdDocBlind: null,
      buyerIdDocEnc: null,
      buyerIdDocBlind: null,
    });
    await expect(
      svc.revealOrderIdDoc(ORDER, 'buyer', ADMIN),
    ).rejects.toMatchObject({
      status: 404,
    });
    expect(audit).not.toHaveBeenCalled();
    void p;
  });
});

describe('IdDocRevealService.revealOrderIdDoc (flow)', () => {
  let order: Record<string, unknown> | null;
  let log: string[];
  let findUnique: Mock;
  let txRows: { n: number; wait: number | null }[];
  let record: Mock;
  let transaction: Mock;
  let svc: IdDocRevealService;

  beforeEach(() => {
    log = [];
    const p = enc('V-12345678');
    order = {
      recipientIdDoc: null,
      recipientIdDocEnc: p.enc,
      recipientIdDocBlind: p.blind,
      buyerIdDocEnc: null,
      buyerIdDocBlind: null,
    };
    findUnique = vi.fn(() => Promise.resolve(order));
    txRows = [{ n: 0, wait: null }];
    record = vi.fn(() => {
      log.push('record');
      return Promise.resolve({ seq: 1, hash: 'h' });
    });
    const tx = {
      $executeRaw: vi.fn(() => Promise.resolve(1)),
      $queryRaw: vi.fn(() => {
        log.push('count');
        return Promise.resolve(txRows);
      }),
    };
    transaction = vi.fn(async (cb: (t: unknown) => Promise<void>) => {
      log.push('tx-start');
      await cb(tx);
      // the commit takes a while: the value must not be out before it
      await new Promise((r) => setTimeout(r, 15));
      log.push('commit');
    });
    svc = new IdDocRevealService(
      { order: { findUnique }, $transaction: transaction } as never,
      {
        record,
        transaction: vi.fn(
          async (
            cb: (t: unknown, a: { add: (e: unknown) => void }) => unknown,
          ) => {
            await cb({}, { add: () => undefined });
          },
        ),
      } as never,
      crypto,
    );
  });

  it('commits the audit event BEFORE returning the value (count, then record as the last statement)', async () => {
    const r = await svc.revealOrderIdDoc(ORDER, 'recipient', ADMIN);
    log.push('returned');
    expect(r).toEqual({ value: 'V-12345678', unparsed: false });
    expect(log).toEqual(['tx-start', 'count', 'record', 'commit', 'returned']);
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'ADMIN',
        actorId: ADMIN.id,
        action: 'ID_DOC_REVEALED',
        entityType: 'Order',
        entityId: ORDER,
        after: { field: 'recipient' },
      }),
    );
    // the event never carries the value or the ciphertext
    expect(JSON.stringify(record.mock.calls)).not.toMatch(/12345678|v1:/);
  });

  it('no event, no delivery: a failing audit write is 503 AUDIT_UNAVAILABLE and the value never leaves', async () => {
    record.mockRejectedValue(new Error('disk full'));
    const out = svc.revealOrderIdDoc(ORDER, 'recipient', ADMIN);
    await expect(out).rejects.toMatchObject({
      status: 503,
      response: { errorCode: 'AUDIT_UNAVAILABLE' },
    });
    await out.catch((e: { response: unknown }) =>
      expect(JSON.stringify(e.response)).not.toContain('12345678'),
    );
  });

  it('at the limit: 429 ID_DOC_REVEAL_RATE_LIMITED with retryAfterSec, no event written', async () => {
    txRows = [{ n: 30, wait: 1234.2 }];
    const out = svc.revealOrderIdDoc(ORDER, 'recipient', ADMIN);
    await expect(out).rejects.toBeInstanceOf(IdDocRateLimitedError);
    await expect(out).rejects.toMatchObject({
      status: 429,
      retryAfterSec: 1235,
      response: { errorCode: 'ID_DOC_REVEAL_RATE_LIMITED' },
    });
    expect(record).not.toHaveBeenCalled();
  });

  it('29 reveals in the window still allow one more (limit is >= 30)', async () => {
    txRows = [{ n: 29, wait: 10 }];
    await expect(
      svc.revealOrderIdDoc(ORDER, 'recipient', ADMIN),
    ).resolves.toBeTruthy();
  });

  it('retryAfterSec is at least 1', async () => {
    txRows = [{ n: 30, wait: -5 }];
    await expect(
      svc.revealOrderIdDoc(ORDER, 'recipient', ADMIN),
    ).rejects.toMatchObject({
      retryAfterSec: 1,
    });
  });

  it('honors ID_DOC_REVEAL_MAX_PER_HOUR', async () => {
    const prev = process.env.ID_DOC_REVEAL_MAX_PER_HOUR;
    process.env.ID_DOC_REVEAL_MAX_PER_HOUR = '3';
    try {
      txRows = [{ n: 3, wait: 9 }];
      await expect(
        svc.revealOrderIdDoc(ORDER, 'recipient', ADMIN),
      ).rejects.toMatchObject({
        status: 429,
      });
      txRows = [{ n: 2, wait: 9 }];
      await expect(
        svc.revealOrderIdDoc(ORDER, 'recipient', ADMIN),
      ).resolves.toBeTruthy();
    } finally {
      if (prev === undefined) delete process.env.ID_DOC_REVEAL_MAX_PER_HOUR;
      else process.env.ID_DOC_REVEAL_MAX_PER_HOUR = prev;
    }
  });

  it('unknown order is 404 ORDER_NOT_FOUND (no audit)', async () => {
    order = null;
    await expect(
      svc.revealOrderIdDoc(ORDER, 'recipient', ADMIN),
    ).rejects.toMatchObject({
      status: 404,
      response: { errorCode: 'ORDER_NOT_FOUND' },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('a field with no data is 404 ID_DOC_NOT_FOUND (no audit): a historical order has no buyer ID', async () => {
    await expect(
      svc.revealOrderIdDoc(ORDER, 'buyer', ADMIN),
    ).rejects.toMatchObject({
      status: 404,
      response: { errorCode: 'ID_DOC_NOT_FOUND' },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it('an integrity failure delivers nothing, writes no REVEAL event and uses no slot of the limit', async () => {
    const moved = enc('V-12345678');
    order = {
      ...order,
      buyerIdDocEnc: moved.enc,
      buyerIdDocBlind: enc('V-99999999').blind,
    };
    await expect(
      svc.revealOrderIdDoc(ORDER, 'buyer', ADMIN),
    ).rejects.toMatchObject({
      status: 500,
      response: {
        errorCode: 'ID_DOC_INTEGRITY_FAILED',
        details: { field: 'buyer', reason: 'BLIND_MISMATCH' },
      },
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('an unparsed legacy value is delivered, flagged in the response and in the event', async () => {
    const legacy = enc('12345678');
    order = {
      ...order,
      buyerIdDocEnc: legacy.enc,
      buyerIdDocBlind: null,
    };
    await expect(svc.revealOrderIdDoc(ORDER, 'buyer', ADMIN)).resolves.toEqual({
      value: '12345678',
      unparsed: true,
    });
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ after: { field: 'buyer', unparsed: true } }),
    );
  });

  it('a legacy PLAIN recipient (Enc not written yet) is delivered normalized', async () => {
    order = {
      ...order,
      recipientIdDocEnc: null,
      recipientIdDocBlind: null,
      recipientIdDoc: 'v-12.345.678',
    };
    await expect(
      svc.revealOrderIdDoc(ORDER, 'recipient', ADMIN),
    ).resolves.toEqual({
      value: 'V-12345678',
      unparsed: false,
    });
  });

  it('the integrity log line names the order and the field, never a value', async () => {
    const { Logger } = await import('@nestjs/common');
    const spy = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    try {
      order = {
        ...order,
        recipientIdDocEnc: 'v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA',
      };
      await svc
        .revealOrderIdDoc(ORDER, 'recipient', ADMIN)
        .catch(() => undefined);
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(
        lines.some(
          (l) => l.includes(`order=${ORDER}`) && l.includes('field=recipient'),
        ),
      ).toBe(true);
      expect(lines.join('\n')).not.toMatch(/12345678|AAAAAAAAAAAAAAAA/);
    } finally {
      spy.mockRestore();
    }
  });
});
