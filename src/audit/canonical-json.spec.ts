import { describe, expect, it } from 'vitest';
import {
  canonicalJSON,
  computeAuditHash,
  GENESIS_HASH,
} from './canonical-json.js';

describe('canonicalJSON (Story 20.1)', () => {
  it('sorts keys recursively, no whitespace', () => {
    expect(canonicalJSON({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });

  it('Date -> ISO with milliseconds, BigInt -> string, undefined omitted, null kept', () => {
    expect(
      canonicalJSON({
        at: new Date('2026-11-04T12:00:00.5Z'),
        n: 10n ** 20n,
        u: undefined,
        z: null,
      }),
    ).toBe(
      '{"at":"2026-11-04T12:00:00.500Z","n":"100000000000000000000","z":null}',
    );
    expect(canonicalJSON([undefined, 1])).toBe('[null,1]');
  });

  it('rejects non-finite numbers and unsupported types', () => {
    expect(() => canonicalJSON({ a: NaN })).toThrow();
    expect(() => canonicalJSON({ a: Infinity })).toThrow();
    expect(() => canonicalJSON({ a: () => 1 })).toThrow();
    expect(() => canonicalJSON(new Date('x'))).toThrow();
  });

  it('is independent of key insertion order and escapes like JSON', () => {
    expect(canonicalJSON({ a: 1, b: 2 })).toBe(canonicalJSON({ b: 2, a: 1 }));
    expect(canonicalJSON('ñandú "q"\n')).toBe('"ñandú \\"q\\"\\n"');
  });
});

describe('computeAuditHash vectors (computed independently with Python hashlib)', () => {
  const ev1 = {
    seq: 1,
    occurredAt: new Date('2026-11-04T12:00:00.000Z'),
    actorType: 'ADMIN',
    actorId: '0b8f2f0e-6d2c-4f43-9a3e-7c1d2e3f4a5b',
    action: 'ORDER_STATUS_CHANGED',
    entityType: 'ORDER',
    entityId: 'o-1',
    before: { status: 'PAID', n: 1 },
    after: { status: 'SHIPPED', n: 2, ok: true, x: null },
    reason: null,
    requestId: null,
    ip: '::ffff:127.0.0.1',
  };
  const H1 = '00a90f3100295a438f2abc1ae390d2291abc7130b181219d83ae14c87bc6df25';
  const ev2 = {
    seq: 2,
    occurredAt: new Date('2026-11-04T12:00:00.001Z'),
    actorType: 'SYSTEM',
    actorId: null,
    action: 'AUDIT_VERIFIED',
    entityType: 'AUDIT_VERIFICATION',
    entityId: 'v',
    before: null,
    after: null,
    reason: 'ñandú "q"',
    requestId: '11111111-1111-4111-8111-111111111111',
    ip: null,
  };

  it('genesis row and the next one', () => {
    expect(computeAuditHash(GENESIS_HASH, ev1)).toBe(H1);
    expect(computeAuditHash(H1, ev2)).toBe(
      'cad19f4facfede0edb6fe28e7e045f9d62410629e492588f909498b67f79f019',
    );
  });

  it('survives the jsonb round trip (Postgres reorders keys, not values)', () => {
    // jsonb returns the same logical value with another key order.
    const roundTripped = {
      ...ev1,
      before: { n: 1, status: 'PAID' },
      after: { x: null, ok: true, n: 2, status: 'SHIPPED' },
    };
    expect(computeAuditHash(GENESIS_HASH, roundTripped)).toBe(H1);
  });

  it('every covered field changes the hash', () => {
    const base = computeAuditHash(GENESIS_HASH, ev1);
    const variants = [
      { seq: 2 },
      { occurredAt: new Date('2026-11-04T12:00:00.001Z') },
      { actorType: 'SYSTEM' },
      { actorId: null },
      { action: 'AUDIT_VERIFIED' },
      { entityType: 'X' },
      { entityId: 'o-2' },
      { before: null },
      { after: {} },
      { reason: 'r' },
      { requestId: '11111111-1111-4111-8111-111111111111' },
      { ip: null },
    ];
    for (const v of variants) {
      expect(computeAuditHash(GENESIS_HASH, { ...ev1, ...v })).not.toBe(base);
    }
    expect(computeAuditHash('1'.repeat(64), ev1)).not.toBe(base);
  });
});
