import { HttpStatus } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { ApiException } from '../common/api-exception.js';
import { RequestContext } from '../common/request-context.js';
import {
  AuditEventError,
  AuditRoundTripError,
  AuditService,
} from './audit.service.js';
import { AuditPayloadError } from './audit-payload.js';
import { GENESIS_HASH, computeAuditHash } from './canonical-json.js';

type Call = { kind: 'exec' | 'query'; sql: string; values: unknown[] };

/** A fake transaction client that records every statement in order. */
function fakeTx(
  opts: {
    head?: { seq: bigint; hash: string };
    failOn?: RegExp;
    failWith?: unknown;
    /** Columns the "database" returns different from what was bound. */
    mutateStored?: Record<string, unknown>;
  } = {},
) {
  const calls: Call[] = [];
  const clock = new Date('2026-11-04T12:00:00.000Z');
  const run =
    (kind: Call['kind']) =>
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?').replace(/\s+/g, ' ');
      calls.push({ kind, sql, values });
      if (opts.failOn?.test(sql))
        return Promise.reject(
          opts.failWith instanceof Error ? opts.failWith : new Error('db down'),
        );
      if (/FROM "Audit_Events" ORDER BY "seq" DESC/.test(sql)) {
        return Promise.resolve(
          opts.head ? [{ ...opts.head, last: clock, now: clock }] : [],
        );
      }
      if (/clock_timestamp/.test(sql)) return Promise.resolve([{ now: clock }]);
      if (/audit_normalize_ip/.test(sql))
        return Promise.resolve([{ ip: String(values[0]).toLowerCase() }]);
      if (/^INSERT INTO "Audit_Events"/.test(sql.trim())) {
        // RETURNING: what Postgres would hand back for the values just bound.
        const [seq, at, actorType, actorId, action, entityType, entityId] =
          values;
        const json = (v: unknown): unknown =>
          typeof v === 'string' ? (JSON.parse(v) as unknown) : null;
        return Promise.resolve([
          {
            seq,
            occurredAt: at,
            actorType,
            actorId,
            action,
            entityType,
            entityId,
            before: json(values[7]),
            after: json(values[8]),
            reason: values[9],
            requestId: values[10],
            ip: values[11],
            ...(opts.mutateStored ?? {}),
          },
        ]);
      }
      return Promise.resolve([]);
    };
  return {
    calls,
    tx: { $executeRaw: run('exec'), $queryRaw: run('query') } as never,
  };
}

const svc = () => new AuditService({} as never);
const ev = {
  actorType: 'SYSTEM',
  action: 'AUDIT_VERIFIED',
  entityType: 'T',
  entityId: '1',
} as const;

describe('AuditService.record (Story 20.1)', () => {
  it('order of statements: bounded lock wait via set_config, advisory lock, lift timeouts, head read, INSERT last', async () => {
    const { calls, tx } = fakeTx();
    await svc().record(tx, ev);
    const sqls = calls.map((c) => c.sql);
    const iArm = sqls.findIndex((s) => /set_config\('lock_timeout'/.test(s));
    const iLock = sqls.findIndex((s) => /pg_advisory_xact_lock/.test(s));
    const iRelease = sqls.findIndex(
      (s, i) => i > iLock && /set_config\('statement_timeout', '0'/.test(s),
    );
    const iHead = sqls.findIndex((s) =>
      /FROM "Audit_Events" ORDER BY "seq" DESC/.test(s),
    );
    const iInsert = sqls.findIndex((s) => /INSERT INTO "Audit_Events"/.test(s));
    expect([iArm, iLock, iRelease, iHead, iInsert].every((i) => i >= 0)).toBe(
      true,
    );
    expect(iArm).toBeLessThan(iLock);
    expect(iLock).toBeLessThan(iRelease);
    expect(iRelease).toBeLessThan(iHead);
    expect(iHead).toBeLessThan(iInsert);
    expect(iInsert).toBe(sqls.length - 1); // the INSERT is the last statement
    expect(calls[iLock].values).toEqual([2120001]);
    expect(sqls.some((s) => /SET LOCAL/i.test(s))).toBe(false); // never SET LOCAL: set_config
  });

  it('genesis: seq 1, prevHash zeros, hash recomputable from the stored values', async () => {
    const { calls, tx } = fakeTx();
    const out = await svc().record(tx, {
      ...ev,
      before: { a: 1 },
      after: { a: 2 },
      ip: null,
      requestId: null,
    });
    expect(out.seq).toBe(1);
    const ins = calls.find((c) => /INSERT INTO "Audit_Events"/.test(c.sql))!;
    const [
      seq,
      occurredAt,
      actorType,
      actorId,
      action,
      entityType,
      entityId,
      before,
      after,
      reason,
      requestId,
      ip,
      prevHash,
      hash,
    ] = ins.values;
    expect(prevHash).toBe(GENESIS_HASH);
    expect(hash).toBe(out.hash);
    expect(
      computeAuditHash(GENESIS_HASH, {
        seq: seq as number,
        occurredAt: occurredAt as Date,
        actorType: actorType as string,
        actorId: actorId as null,
        action: action as string,
        entityType: entityType as string,
        entityId: entityId as string,
        before: JSON.parse(before as string),
        after: JSON.parse(after as string),
        reason: reason as null,
        requestId: requestId as null,
        ip: ip as null,
      }),
    ).toBe(out.hash);
  });

  it('chains from the current head: seq + 1, prevHash = head.hash', async () => {
    const { calls, tx } = fakeTx({ head: { seq: 41n, hash: 'c'.repeat(64) } });
    const out = await svc().record(tx, ev);
    expect(out.seq).toBe(42);
    const ins = calls.find((c) => /INSERT INTO "Audit_Events"/.test(c.sql))!;
    expect(ins.values[12]).toBe('c'.repeat(64));
  });

  it('transaction collector: several events take ONE lock and consecutive seqs', async () => {
    const { calls, tx } = fakeTx({ head: { seq: 10n, hash: 'd'.repeat(64) } });
    const prisma = {
      $transaction: (fn: (t: never) => Promise<unknown>) => fn(tx),
    };
    const s = new AuditService(prisma as never);
    await s.transaction((_t, audit) => {
      audit.add(ev);
      audit.add({ ...ev, entityId: '2' });
      audit.add({ ...ev, entityId: '3' });
      return Promise.resolve();
    });
    expect(
      calls.filter((c) => /pg_advisory_xact_lock/.test(c.sql)),
    ).toHaveLength(1);
    const ins = calls.filter((c) => /INSERT INTO "Audit_Events"/.test(c.sql));
    expect(ins.map((c) => c.values[0])).toEqual([11, 12, 13]);
    expect(ins[1].values[12]).not.toBe(ins[0].values[12]); // chained, not repeated
  });

  it('no events => no lock and no SQL at all', async () => {
    const { calls, tx } = fakeTx();
    const prisma = {
      $transaction: (fn: (t: never) => Promise<unknown>) => fn(tx),
    };
    await new AuditService(prisma as never).transaction(() =>
      Promise.resolve(1),
    );
    expect(calls).toHaveLength(0);
  });

  it('defaults requestId and ip from RequestContext; an explicit null wins; a non-IP becomes NULL', async () => {
    const rid = '11111111-1111-4111-8111-111111111111';
    const run = async (extra: object) => {
      const { calls, tx } = fakeTx();
      await RequestContext.run({ requestId: rid, ip: '203.0.113.5' }, () =>
        svc().record(tx, { ...ev, ...extra }),
      );
      const ins = calls.find((c) => /INSERT INTO "Audit_Events"/.test(c.sql))!;
      return { requestId: ins.values[10], ip: ins.values[11] };
    };
    expect(await run({})).toEqual({ requestId: rid, ip: '203.0.113.5' });
    expect(await run({ requestId: null, ip: null })).toEqual({
      requestId: null,
      ip: null,
    });
    expect(await run({ ip: 'garbage' })).toEqual({ requestId: rid, ip: null });
  });

  it('fail-closed: a database error becomes ApiException 503 AUDIT_UNAVAILABLE (WRITE_FAILED), never swallowed', async () => {
    const { tx } = fakeTx({ failOn: /INSERT INTO "Audit_Events"/ });
    const e = await svc()
      .record(tx, ev)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiException);
    expect((e as ApiException).getStatus()).toBe(
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect((e as ApiException).getResponse()).toMatchObject({
      errorCode: 'AUDIT_UNAVAILABLE',
      details: { reason: 'WRITE_FAILED' },
    });
  });

  it('lock timeouts as the pg adapter reports them (P2010 + meta.driverAdapterError.cause.code 55P03 / 57014) are a 503 LOCK_TIMEOUT', async () => {
    for (const code of ['55P03', '57014']) {
      const err = Object.assign(new Error('Raw query failed'), {
        code: 'P2010',
        meta: { driverAdapterError: { cause: { code } } },
      });
      const { tx } = fakeTx({ failOn: /pg_advisory_xact_lock/, failWith: err });
      const e = await svc()
        .record(tx, ev)
        .catch((x: unknown) => x);
      expect((e as ApiException).getResponse()).toMatchObject({
        errorCode: 'AUDIT_UNAVAILABLE',
        details: { reason: 'LOCK_TIMEOUT' },
      });
    }
  });

  it('a Prisma transaction timeout (P2028) from transaction() is a 503 too', async () => {
    const { PrismaClientKnownRequestError } =
      await import('../generated/prisma/internal/prismaNamespace.js');
    const prisma = {
      $transaction: () =>
        Promise.reject(
          new PrismaClientKnownRequestError('Transaction already closed', {
            code: 'P2028',
            clientVersion: 'x',
          }),
        ),
    };
    const e = await new AuditService(prisma as never)
      .transaction(() => Promise.resolve(1))
      .catch((x: unknown) => x);
    expect((e as ApiException).getStatus()).toBe(503);
    expect((e as ApiException).getResponse()).toMatchObject({
      details: { reason: 'TX_TIMEOUT' },
    });
  });

  it('a malformed event is an AuditEventError (a bug => 500), before any SQL', async () => {
    const { calls, tx } = fakeTx();
    for (const bad of [
      { action: 'NOPE' },
      { actorType: 'ROOT' },
      { entityId: '' },
      { entityType: 'x'.repeat(65) },
      { actorId: 'zzz' },
      { before: { n: 0.5 } },
    ]) {
      await expect(
        svc().record(tx, { ...ev, ...bad } as never),
      ).rejects.toThrow();
    }
    await expect(
      svc().record(tx, { ...ev, action: 'NOPE' } as never),
    ).rejects.toBeInstanceOf(AuditEventError);
    expect(calls).toHaveLength(0);
  });
});

describe('AuditService: an unserializable payload in PRODUCTION never becomes a 500 (Story 20.5 follow-up)', () => {
  const insert = (calls: Call[]) =>
    calls.find((c) => /INSERT INTO "Audit_Events"/.test(c.sql))!;
  const bad = [
    ['a function', { f: () => 1 }],
    ['a symbol', { s: Symbol('x') }],
    [
      'nesting beyond the limit',
      JSON.parse('{"a":'.repeat(40) + '1' + '}'.repeat(40)),
    ],
  ] as const;
  const withMode = async (mode: 'true' | 'false', run: () => Promise<void>) => {
    const prev = process.env.AUDIT_PAYLOAD_STRICT;
    process.env.AUDIT_PAYLOAD_STRICT = mode;
    try {
      await run();
    } finally {
      if (prev === undefined) delete process.env.AUDIT_PAYLOAD_STRICT;
      else process.env.AUDIT_PAYLOAD_STRICT = prev;
    }
  };

  it.each(bad)(
    'lenient (production): %s is written as a marker, the action goes on and the bug is logged',
    async (_what, after) => {
      await withMode('false', async () => {
        const { calls, tx } = fakeTx();
        const service = svc();
        const err = vi
          .spyOn(
            (service as unknown as { logger: { error: () => void } }).logger,
            'error',
          )
          .mockImplementation(() => undefined);
        await expect(
          service.record(tx, { ...ev, after: after as never }),
        ).resolves.toMatchObject({ seq: 1 });
        expect(insert(calls).values[8]).toBe(
          '{"payloadError":"UNSERIALIZABLE"}',
        );
        expect(err).toHaveBeenCalledTimes(1);
      });
    },
  );

  it('lenient: a payload over the size cap is a marker too (a sale is not refused for a big payload)', async () => {
    await withMode('false', async () => {
      const { calls, tx } = fakeTx();
      const service = svc();
      vi.spyOn(
        (service as unknown as { logger: { error: () => void } }).logger,
        'error',
      ).mockImplementation(() => undefined);
      await service.record(tx, {
        ...ev,
        after: { items: Array.from({ length: 40 }, () => 'y '.repeat(4000)) },
      });
      expect(insert(calls).values[8]).toBe('{"payloadError":"UNSERIALIZABLE"}');
    });
  });

  it('a long unbroken string is cut BEFORE the value detectors run (they are quadratic: 150 000 characters blocked the loop for 11 s)', async () => {
    await withMode('false', async () => {
      const { calls, tx } = fakeTx();
      const service = svc();
      vi.spyOn(
        (service as unknown as { logger: { warn: () => void } }).logger,
        'warn',
      ).mockImplementation(() => undefined);
      const t0 = performance.now();
      await service.record(tx, { ...ev, after: { t: 'x'.repeat(300_000) } });
      expect(performance.now() - t0).toBeLessThan(1_000);
      const stored = JSON.parse(insert(calls).values[8] as string) as {
        t: string;
      };
      expect(stored.t).toHaveLength(8_000);
    });
    await withMode('true', async () => {
      const { tx } = fakeTx();
      await expect(
        svc().record(tx, { ...ev, after: { t: 'x'.repeat(300_000) } }),
      ).rejects.toBeInstanceOf(AuditPayloadError);
    });
  });

  it('strict (dev, tests): the same payloads throw AuditPayloadError before any SQL, so the test of the call site fails', async () => {
    await withMode('true', async () => {
      for (const [, after] of bad) {
        const { calls, tx } = fakeTx();
        await expect(
          svc().record(tx, { ...ev, after: after as never }),
        ).rejects.toBeInstanceOf(AuditPayloadError);
        expect(calls).toHaveLength(0);
      }
    });
  });

  it("the emitters' payload() helper follows the same rule", async () => {
    const { payload } = await import('./audit-events.js');
    await withMode('true', () => {
      expect(() => payload({ d: new Date('nope') })).toThrow(AuditPayloadError);
      return Promise.resolve();
    });
    await withMode('false', () => {
      expect(payload({ d: new Date('nope') })).toEqual({
        payloadError: 'UNSERIALIZABLE',
      });
      return Promise.resolve();
    });
  });
});

describe('AuditService: what is hashed is what is stored (Story 20.1, QA round 2)', () => {
  const insert = (calls: Call[]) =>
    calls.find((c) => /INSERT INTO "Audit_Events"/.test(c.sql))!;

  it('lone surrogates and NUL are replaced by U+FFFD in columns, reason and payload BEFORE hashing and inserting', async () => {
    const { calls, tx } = fakeTx();
    const out = await svc().record(tx, {
      ...ev,
      entityId: 'x\ud800y\u0000z',
      reason: 'emoji cut \ud83d',
      before: { 'k\ud800': 'v\u0000' },
      after: { n: -0 },
    });
    const v = insert(calls).values;
    expect(v[6]).toBe('x\ufffdy\ufffdz'); // entityId
    expect(v[9]).toBe('emoji cut \ufffd'); // reason
    expect(JSON.parse(v[7] as string)).toEqual({ 'k\ufffd': 'v\ufffd' });
    expect(v[8]).toBe('{"n":0}');
    expect(out.hash).toBe(v[13]);
  });

  it('reason is cut to 500 CODE POINTS (an astral char is never split), an empty one is NULL, PII in it is masked', async () => {
    const { calls, tx } = fakeTx();
    await svc().record(tx, { ...ev, reason: '😀'.repeat(900) });
    expect(insert(calls).values[9]).toBe('😀'.repeat(500));
    const again = fakeTx();
    await svc().record(again.tx, { ...ev, reason: '' });
    expect(insert(again.calls).values[9]).toBeNull();
    const pii = fakeTx();
    await svc().record(pii.tx, { ...ev, reason: 'cliente maria@example.com' });
    expect(insert(pii.calls).values[9]).toBe('cliente [REDACTED:EMAIL]');
  });

  it('entityType/entityId limits count characters like varchar(n), not UTF-16 units', async () => {
    const { tx } = fakeTx();
    await expect(
      svc().record(tx, { ...ev, entityId: '😀'.repeat(128) }),
    ).resolves.toBeDefined();
    await expect(
      svc().record(tx, { ...ev, entityId: '😀'.repeat(129) }),
    ).rejects.toBeInstanceOf(AuditEventError);
    await expect(
      svc().record(tx, { ...ev, entityType: 'é'.repeat(65) }),
    ).rejects.toBeInstanceOf(AuditEventError);
  });

  it('an IP that is not an inet (zone id, garbage) never reaches the database as an inet cast and never fails the action', async () => {
    for (const ip of [
      'fe80::1%eth0',
      'unknown',
      '1.2.3.4, 5.6.7.8',
      '[::1]:80',
    ]) {
      const { calls, tx } = fakeTx();
      await expect(svc().record(tx, { ...ev, ip })).resolves.toBeDefined();
      const norm = calls.filter((c) => /audit_normalize_ip/.test(c.sql));
      const stored = insert(calls).values[11];
      if (ip === 'fe80::1%eth0') expect(stored).toBe('fe80::1');
      if (ip === '[::1]:80') expect(stored).toBe('::1');
      if (ip === 'unknown' || ip.includes(',')) {
        expect(stored).toBeNull();
        expect(norm).toHaveLength(0);
      }
    }
  });

  it('occurredAt never goes before the previous row (a clock that stepped back)', async () => {
    const { calls, tx } = fakeTx({ head: { seq: 1n, hash: 'a'.repeat(64) } });
    // the fake head says last == clock; make the head later than the clock
    const later = new Date('2026-11-04T13:00:00.000Z');
    type Q = (
      s: TemplateStringsArray,
      ...v: unknown[]
    ) => Promise<Record<string, unknown>[]>;
    const inner = tx as unknown as { $executeRaw: unknown; $queryRaw: Q };
    const wrapped = {
      $executeRaw: inner.$executeRaw,
      $queryRaw: (s: TemplateStringsArray, ...v: unknown[]) =>
        inner
          .$queryRaw(s, ...v)
          .then((rows) =>
            /FROM "Audit_Events" ORDER BY "seq" DESC/.test(s.join('?'))
              ? rows.map((r) => ({ ...r, last: later }))
              : rows,
          ),
    };
    await svc().record(wrapped as never, ev);
    expect(insert(calls).values[1]).toEqual(later);
  });

  it('a stored row that does not hash to what was written aborts the action with AuditRoundTripError (never a chain that cannot verify)', async () => {
    const { tx } = fakeTx({ mutateStored: { entityId: 'something else' } });
    const e = await svc()
      .record(tx, ev)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AuditRoundTripError);
    expect(String(e)).toContain('entityId');
    expect(e).not.toBeInstanceOf(ApiException); // a bug (500), not an outage
  });

  it('payload guard: strict in the suite (throws AuditPayloadError), lenient in production (masks, the action goes on)', async () => {
    const saved = process.env.NODE_ENV;
    try {
      const { tx } = fakeTx();
      await expect(
        svc().record(tx, { ...ev, after: { note: 'maria@example.com' } }),
      ).rejects.toThrow(/Invalid audit payload/);
      process.env.NODE_ENV = 'production';
      const prod = fakeTx();
      await expect(
        svc().record(prod.tx, {
          ...ev,
          after: { note: 'maria@example.com', price: 1.5 },
        }),
      ).resolves.toBeDefined();
      expect(JSON.parse(insert(prod.calls).values[8] as string)).toEqual({
        note: '[REDACTED:EMAIL]',
        price: '1.5',
      });
    } finally {
      process.env.NODE_ENV = saved;
    }
  });
});
