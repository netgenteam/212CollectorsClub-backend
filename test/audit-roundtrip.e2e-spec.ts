/* eslint-disable @typescript-eslint/require-await -- audit callbacks must return a Promise by signature */
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { AUDIT_ACTIONS } from './../src/audit/audit-actions.js';
import { AuditChainVerifier } from './../src/audit/audit-chain-verifier.js';
import type { SqlRunner } from './../src/audit/audit-chain-verifier.js';
import { codePointLength } from './../src/audit/audit-normalize.js';
import { AuditReadService } from './../src/audit/audit-read.service.js';
import { AuditVerifyService } from './../src/audit/audit-verify.service.js';
import { AuditService } from './../src/audit/audit.service.js';
import type { AuditEventInput } from './../src/audit/audit.service.js';
import { createAuditSandbox } from './helpers/audit-sandbox.js';
import type { AuditSandbox } from './helpers/audit-sandbox.js';

/**
 * Story 20.1, QA round 2 (D1, D3, occurredAt, head, partial): the hash of what is
 * WRITTEN must equal the hash of what is READ BACK, whatever the text. SANDBOX
 * schemas only (the real Audit_Events is immutable and is never touched).
 */
interface Boxed {
  sb: AuditSandbox;
  prisma: PrismaService;
  audit: AuditService;
  runner: SqlRunner;
}

const boxes: Boxed[] = [];
async function make(): Promise<Boxed> {
  const sb = await createAuditSandbox();
  let prisma: PrismaService | undefined;
  try {
    prisma = new PrismaService(new ConfigService({ DATABASE_URL: sb.url }));
    await prisma.onModuleInit();
  } catch (err) {
    await prisma?.onModuleDestroy().catch(() => undefined);
    await sb.drop();
    throw err;
  }
  const p = prisma;
  const b: Boxed = {
    sb,
    prisma: p,
    audit: new AuditService(p),
    runner: (sql, params = []) =>
      p.$queryRawUnsafe<Record<string, unknown>[]>(sql, ...params),
  };
  boxes.push(b);
  return b;
}

const verifyFull = (b: Boxed) =>
  new AuditChainVerifier().verify(b.runner, { mode: 'full' });

const base = {
  actorType: 'ADMIN',
  action: 'REFUND_ISSUED',
  entityType: 'ORDER',
  entityId: '2',
} as const;

/** Deterministic PRNG (mulberry32): a failing run is reproducible from its seed. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = [
  'a',
  'Z',
  '0',
  '9',
  ' ',
  'é',
  'ñ',
  '日',
  '本',
  '😀',
  '🧑‍💻',
  '𝒳',
  '\ud800',
  '\udc00',
  '\ud83d',
  '\ude00',
  '\u0000',
  '\u0001',
  '\u001f',
  '\u007f',
  '\u0085',
  ' ',
  ' ',
  '‮',
  '​',
  '﻿',
  '￿',
  '￾',
  '\ufffd',
  '\\',
  '"',
  "'",
  '\n',
  '\t',
  '\r',
  '%',
  '_',
  '$',
  '{',
  '}',
  '[',
  ']',
  '/',
  '́',
  'ａ',
  '\u0000\u0000',
];

afterAll(async () => {
  for (const b of boxes) {
    await b.prisma.onModuleDestroy();
    await b.sb.drop();
  }
});

describe('round trip: what is hashed is what Postgres stores (Story 20.1 D1)', () => {
  it('QA repro: an emoji cut by slice() in reason / entityId no longer makes a permanent HASH_MISMATCH', async () => {
    const b = await make();
    await b.audit.transaction(async (_tx, audit) => {
      audit.add({ ...base, reason: 'emoji cut \ud83d' });
      audit.add({ ...base, entityId: 'x\ud800y' });
      audit.add({ ...base, reason: 'tail \udc00' });
    });
    const v = await verifyFull(b);
    expect(v).toMatchObject({ ok: true, rows: 3, done: true });
    const rows = await b.sb.exec(
      `SELECT "reason", "entityId" FROM "Audit_Events" ORDER BY "seq"`,
    );
    expect(rows[0].reason).toBe('emoji cut \ufffd');
    expect(rows[1].entityId).toBe('x\ufffdy');
  });

  it('QA repro: lone surrogates and NUL inside before/after (values AND keys) used to be a 503 WRITE_FAILED; now stored and verified', async () => {
    const b = await make();
    await b.audit.transaction(async (_tx, audit) => {
      audit.add({
        ...base,
        before: { 'k\ud800': 'v\ud83d', n: 1 },
        after: { list: ['a\u0000b', { 'x\u0000': 'y\udc00' }] },
        reason: 'nul \u0000 here',
        entityId: 'e\u0000',
      });
    });
    const v = await verifyFull(b);
    expect(v).toMatchObject({ ok: true, rows: 1 });
    const [row] = await b.sb.exec(
      `SELECT "before", "after", "reason", "entityId" FROM "Audit_Events"`,
    );
    expect(row.before).toEqual({ 'k\ufffd': 'v\ufffd', n: 1 });
    expect(row.after).toEqual({ list: ['a\ufffdb', { 'x\ufffd': 'y\ufffd' }] });
    expect(row.reason).toBe('nul \ufffd here');
    expect(row.entityId).toBe('e\ufffd');
  });

  it('extremes: column limits in code points, an astral reason cut at 500, ints at the safe limits, -0, __proto__, empty key, key order that differs between UTF-8 and UTF-16, 100 kB of payload', async () => {
    const b = await make();
    const extreme: AuditEventInput[] = [
      {
        ...base,
        entityId: '😀'.repeat(128),
        entityType: '😀'.repeat(64),
        reason: '😀'.repeat(500),
      },
      { ...base, reason: '😀'.repeat(501) },
      { ...base, reason: '😀'.repeat(499) + '\ud83d' },
      { ...base, reason: 'x'.repeat(5_000) },
      {
        ...base,
        before: {
          max: Number.MAX_SAFE_INTEGER,
          min: -Number.MAX_SAFE_INTEGER,
          z: 0,
          nz: -0,
        },
        after: {
          ['__proto__']: 'p',
          '': 'empty',
          '😀': 1,
          '￿': 2,
          é: 3,
          z: 4,
          Z: 5,
          '10': 6,
          '2': 7,
          ａ: 8,
          // ~100 kB of payload as 100 strings of 1 000 characters. One 100 000-character token
          // used to take 4.6 s inside the value detectors (quadratic) and hit the 5 s test
          // timeout; the guard now refuses a single string over 8 000 characters (audit-payload.ts).
          big: Array.from({ length: 100 }, () => 'y'.repeat(1_000)),
        },
      },
      {
        ...base,
        before: { a: { b: { c: { d: { e: { f: { g: ['deep'] } } } } } } },
      },
      { ...base, before: 'top-level string', after: 7 },
      { ...base, before: [], after: {} },
      { ...base, before: 'null', after: 'true' },
      { ...base, before: false, after: true },
    ];
    for (const ev of extreme)
      await b.audit.transaction(async (_t, a) => a.add(ev));
    const v = await verifyFull(b);
    expect(v).toMatchObject({ ok: true, rows: extreme.length, done: true });
    const rows = await b.sb.exec(
      `SELECT "reason","entityId","entityType" FROM "Audit_Events" ORDER BY "seq"`,
    );
    expect(codePointLength(rows[0].entityId as string)).toBe(128);
    expect(codePointLength(rows[1].reason as string)).toBe(500);
    expect(rows[2].reason).toBe('😀'.repeat(499) + '\ufffd');
  });

  it.each([1, 2, 3])(
    'property (seed %i): 400 random events with unicode and extremes insert and verify OK, never a 503',
    async (seed) => {
      const saved = process.env.AUDIT_PAYLOAD_STRICT;
      process.env.AUDIT_PAYLOAD_STRICT = 'false'; // random text may look like PII: masking is fine here, the round trip is what is measured
      try {
        const b = await make();
        const r = rng(seed * 7919);
        const int = (n: number) => Math.floor(r() * n);
        const str = (max: number): string =>
          Array.from({ length: int(max) }, () => POOL[int(POOL.length)]).join(
            '',
          );
        const nonEmpty = (max: number): string => str(max) || 'x';
        const value = (depth: number): unknown => {
          const k = int(depth >= 4 ? 5 : 8);
          switch (k) {
            case 0:
              return null;
            case 1:
              return r() < 0.5;
            case 2:
              return [
                0,
                -0,
                1,
                -1,
                42,
                Number.MAX_SAFE_INTEGER,
                -Number.MAX_SAFE_INTEGER,
              ][int(7)];
            case 3:
            case 4:
              return str(60);
            case 5:
              return Array.from({ length: int(4) }, () => value(depth + 1));
            default: {
              const o: Record<string, unknown> = {};
              for (let i = int(5); i > 0; i -= 1) {
                Object.defineProperty(o, str(8), {
                  value: value(depth + 1),
                  enumerable: true,
                  configurable: true,
                  writable: true,
                });
              }
              return o;
            }
          }
        };
        const actions = Object.keys(AUDIT_ACTIONS);
        const N = 400;
        let made = 0;
        while (made < N) {
          const batch = Math.min(N - made, 1 + int(8));
          await b.audit.transaction(async (_tx, audit) => {
            for (let i = 0; i < batch; i += 1) {
              audit.add({
                actorType: (['ADMIN', 'SYSTEM', 'CUSTOMER', 'ANON'] as const)[
                  int(4)
                ],
                actorId: r() < 0.5 ? randomUUID() : null,
                action: actions[
                  int(actions.length)
                ] as AuditEventInput['action'],
                entityType: nonEmpty(64).slice(0, 64),
                entityId: nonEmpty(128).slice(0, 128),
                reason: r() < 0.3 ? null : str(700),
                before:
                  r() < 0.3 ? null : (value(0) as AuditEventInput['before']),
                after:
                  r() < 0.3 ? null : (value(0) as AuditEventInput['after']),
                ip: r() < 0.3 ? null : '2001:db8::' + int(65535).toString(16),
                requestId: r() < 0.5 ? randomUUID() : null,
              });
            }
          });
          made += batch;
        }
        const v = await verifyFull(b);
        expect(v).toMatchObject({ ok: true, rows: N, done: true });
        const stored = await b.sb.exec(
          `SELECT "reason", "entityId", "entityType" FROM "Audit_Events"`,
        );
        for (const s of stored) {
          expect(codePointLength(s.entityId as string)).toBeLessThanOrEqual(
            128,
          );
          expect(codePointLength(s.entityType as string)).toBeLessThanOrEqual(
            64,
          );
          if (s.reason !== null) {
            expect(codePointLength(s.reason as string)).toBeLessThanOrEqual(
              500,
            );
          }
        }
      } finally {
        if (saved === undefined) delete process.env.AUDIT_PAYLOAD_STRICT;
        else process.env.AUDIT_PAYLOAD_STRICT = saved;
      }
    },
    120_000,
  );
});

describe('IP formats never block an audited action (Story 20.1 D3)', () => {
  // [raw, what the log keeps]: null = stored as NULL
  const CORPUS: [string, string | null][] = [
    ['203.0.113.7', '203.0.113.7'],
    ['2001:DB8::1', '2001:db8::1'],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['::1', '::1'],
    ['::', '::'],
    ['::ffff:1.2.3.4', '::ffff:1.2.3.4'],
    ['::ffff:0102:0304', '::ffff:1.2.3.4'],
    ['fe80::1%eth0', 'fe80::1'],
    ['fe80::1%25eth0', 'fe80::1'],
    ['fe80::1%', null],
    ['fe80::1%0', 'fe80::1'],
    ['[::1]:443', '::1'],
    ['[2001:db8::1]', '2001:db8::1'],
    ['1.2.3.4:5678', '1.2.3.4'],
    ['1.2.3.4, 5.6.7.8', null],
    ['1.2.3.4/24', null],
    ['unknown', null],
    ['', null],
    ['256.0.0.1', null],
    ['01.02.03.04', null],
    ['1.2.3', null],
    ['1.2.3.4.5', null],
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.255'],
    ['::1.2.3.4', '::1.2.3.4'],
    ['64:ff9b::1.2.3.4', '64:ff9b::102:304'],
    ['1::', '1::'],
    ['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
    ['1:2:3:4:5:6:7:8:9', null],
    [':::', null],
    ['g::1', null],
    ['1.2.3.4\u0000', null],
    ['\ud800', null],
    ['x'.repeat(5000), null],
  ];

  it('every format in the corpus: the audited action commits, the ip is NULL or Postgres-normalized, verify OK', async () => {
    const b = await make();
    for (const [raw] of CORPUS) {
      await b.audit.transaction(async (tx, audit) => {
        await tx.$executeRaw`SELECT 1`; // the audited "action"
        audit.add({
          ...base,
          ip: raw,
          entityId: JSON.stringify(raw).slice(0, 100),
        });
      });
    }
    const rows = await b.sb.exec(
      `SELECT host("ip") AS ip FROM "Audit_Events" ORDER BY "seq"`,
    );
    expect(rows).toHaveLength(CORPUS.length);
    CORPUS.forEach(([raw, want], i) => {
      const got = rows[i].ip as string | null;
      // the exact printed form is Postgres's; the contract is: NULL or the same address
      if (want === null) expect(got, raw).toBeNull();
      else expect(got?.toLowerCase(), raw).toBe(want.toLowerCase());
    });
    expect(await verifyFull(b)).toMatchObject({
      ok: true,
      rows: CORPUS.length,
    });
  });

  it('through the request context (X-Forwarded-For without nginx): a POST-shaped transaction with fe80::1%eth0 commits', async () => {
    const b = await make();
    const { RequestContext } =
      await import('./../src/common/request-context.js');
    await RequestContext.run(
      { requestId: randomUUID(), ip: 'fe80::1%eth0' },
      () => b.audit.transaction(async (_t, a) => a.add({ ...base })),
    );
    const [row] = await b.sb.exec(
      `SELECT host("ip") AS ip FROM "Audit_Events"`,
    );
    expect(row.ip).toBe('fe80::1');
  });

  it('300 random address-shaped strings in ONE transaction: none aborts it', async () => {
    const b = await make();
    const r = rng(99);
    const ALPHA = '0123456789abcdefABCDEF:.%[]/ -xg';
    const gen = () =>
      Array.from(
        { length: 1 + Math.floor(r() * 45) },
        () => ALPHA[Math.floor(r() * ALPHA.length)],
      ).join('');
    await b.audit.transaction(async (_tx, audit) => {
      for (let i = 0; i < 300; i += 1)
        audit.add({ ...base, ip: gen(), entityId: String(i) });
    });
    expect(await verifyFull(b)).toMatchObject({ ok: true, rows: 300 });
  });
});

describe('occurredAt is bounded by the database (Story 20.1)', () => {
  const raw = (b: Boxed, seq: number, at: string, prev: string) =>
    b.sb.exec(
      `INSERT INTO "Audit_Events" ("seq","occurredAt","actorType","action","entityType","entityId","prevHash","hash")
       VALUES ($1::bigint, ${at}, 'SYSTEM', 'AUDIT_VERIFIED', 'T', '1', $2, repeat('a', 63) || $1::text)`,
      [seq, prev],
    );
  const code = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: { code?: string }) => e.code,
    );

  it('rejects 1990 and 2090 as the first row, going backwards, and a row from the future; honest events keep flowing', async () => {
    const b = await make();
    const zeros = '0'.repeat(64);
    expect(await code(raw(b, 1, `'1990-01-01T00:00:00Z'`, zeros))).toBe(
      '23000',
    );
    expect(await code(raw(b, 1, `'2090-01-01T00:00:00Z'`, zeros))).toBe(
      '23000',
    );
    const { hash } = await b.audit.transaction(async (tx, a) => {
      a.add({ ...base });
      return (await tx.$queryRaw<{ hash: string }[]>`SELECT 'x' AS hash`)[0];
    });
    void hash;
    const [head] = await b.sb.exec(
      `SELECT "hash" FROM "Audit_Events" WHERE seq = 1`,
    );
    const h1 = head.hash as string;
    expect(await code(raw(b, 2, `now() - interval '1 hour'`, h1))).toBe(
      '23000',
    ); // backwards
    expect(await code(raw(b, 2, `now() + interval '10 minutes'`, h1))).toBe(
      '23000',
    ); // future
    expect(await code(raw(b, 2, `'1990-01-01T00:00:00Z'`, h1))).toBe('23000');
    // within the margin it is accepted (a clock a few seconds ahead)
    expect(await code(raw(b, 2, `now() + interval '20 seconds'`, h1))).toBe(
      'ok',
    );
    // and the service, whose clock is now BEHIND the head, clamps instead of being rejected
    await b.audit.transaction(async (_t, a) =>
      a.add({ ...base, entityId: '3' }),
    );
    const rows = await b.sb.exec(
      `SELECT "occurredAt" FROM "Audit_Events" ORDER BY seq`,
    );
    expect(rows).toHaveLength(3);
    expect((rows[2].occurredAt as Date).getTime()).toBeGreaterThanOrEqual(
      (rows[1].occurredAt as Date).getTime(),
    );
  });
});

describe('head, partial verification (Story 20.1)', () => {
  it('head.count is the seq (no count(*)) and equals count(*) on an intact chain; anchor flag follows AUDIT_ANCHOR_EMAIL', async () => {
    const b = await make();
    for (let i = 0; i < 7; i += 1) {
      await b.audit.transaction(async (_t, a) =>
        a.add({ ...base, entityId: String(i + 1) }),
      );
    }
    const reader = new AuditReadService(b.prisma, new ConfigService({}));
    const head = await reader.head();
    const [{ n }] = await b.sb.exec(
      `SELECT count(*)::int AS n FROM "Audit_Events"`,
    );
    expect(head).toMatchObject({
      seq: 7,
      count: 7,
      anchorEmailConfigured: false,
    });
    expect(head.count).toBe(n);
    expect(
      (
        await new AuditReadService(
          b.prisma,
          new ConfigService({ AUDIT_ANCHOR_EMAIL: ' ' }),
        ).head()
      ).anchorEmailConfigured,
    ).toBe(false);
    expect(
      (
        await new AuditReadService(
          b.prisma,
          new ConfigService({ AUDIT_ANCHOR_EMAIL: 'a@b.co' }),
        ).head()
      ).anchorEmailConfigured,
    ).toBe(true);
    // the empty chain
    const empty = await make();
    expect(await new AuditReadService(empty.prisma).head()).toMatchObject({
      seq: 0,
      count: 0,
      at: null,
    });
  });

  it('a `full` run that skips the past (fromSeq > 1) is stored and answered as PARTIAL; only a run from row 1 to the end is complete', async () => {
    const b = await make();
    for (let i = 0; i < 6; i += 1) {
      await b.audit.transaction(async (_t, a) =>
        a.add({ ...base, entityId: String(i + 1) }),
      );
    }
    const svc = new AuditVerifyService(
      b.prisma,
      b.audit,
      new AuditChainVerifier(),
    );
    const actor = { actorType: 'SYSTEM', actorId: null } as const;
    const reader = new AuditReadService(b.prisma);

    const skipped = await svc.run({
      mode: 'full',
      fromSeq: 4,
      source: 'MANUAL',
      actor,
    });
    expect(skipped).toMatchObject({
      ok: true,
      done: true,
      partial: true,
      checkedFrom: 4,
    });
    let v = await reader.verifications();
    expect(v.items[0]).toMatchObject({ result: 'OK', partial: true });
    expect(v.lastCompleteVerificationAt).toBeNull();

    const stopped = await svc.run({
      mode: 'full',
      limit: 2,
      source: 'MANUAL',
      actor,
    });
    expect(stopped).toMatchObject({
      ok: true,
      done: false,
      partial: true,
      rows: 2,
    });

    const whole = await svc.run({ mode: 'full', source: 'MANUAL', actor });
    expect(whole).toMatchObject({
      ok: true,
      done: true,
      partial: false,
      checkedFrom: 1,
    });
    v = await reader.verifications();
    expect(v.items[0]).toMatchObject({ result: 'OK', partial: false });
    expect(v.lastCompleteVerificationAt).toBe(v.items[0].startedAt);

    // the AUDIT_VERIFIED event carries it
    const [ev] = await b.sb.exec(
      `SELECT "after" FROM "Audit_Events" WHERE "action" = 'AUDIT_VERIFIED' ORDER BY seq LIMIT 1`,
    );
    expect(ev.after).toMatchObject({ partial: true, fromSeq: 4 });
  });
});
