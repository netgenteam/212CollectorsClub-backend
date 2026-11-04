import { HttpStatus } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ApiException } from '../common/api-exception.js';
import { RequestContext } from '../common/request-context.js';
import { AuditEventError, AuditService } from './audit.service.js';
import { GENESIS_HASH, computeAuditHash } from './canonical-json.js';

type Call = { kind: 'exec' | 'query'; sql: string; values: unknown[] };

/** A fake transaction client that records every statement in order. */
function fakeTx(
  opts: {
    head?: { seq: bigint; hash: string };
    failOn?: RegExp;
    failWith?: unknown;
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
        return Promise.resolve(opts.head ? [{ ...opts.head, now: clock }] : []);
      }
      if (/clock_timestamp/.test(sql)) return Promise.resolve([{ now: clock }]);
      if (/host\(/.test(sql))
        return Promise.resolve([{ ip: String(values[0]).toLowerCase() }]);
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
