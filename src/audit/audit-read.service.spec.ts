import { describe, expect, it } from 'vitest';
import { parseAuditEventsQuery } from './audit-read.service.js';

describe('parseAuditEventsQuery (400 AUDIT_FILTER_INVALID)', () => {
  it('accepts every filter', () => {
    const f = parseAuditEventsQuery({
      from: '2026-11-01',
      to: '2026-11-02',
      action: 'ORDER_STATUS_CHANGED',
      actorId: '0B8F2F0E-6D2C-4F43-9A3E-7C1D2E3F4A5B',
      entityType: 'ORDER',
      entityId: 'abc',
      requestId: '11111111-1111-4111-8111-111111111111',
      cursor: '120',
    });
    expect(f.from?.toISOString()).toBe('2026-11-01T00:00:00.000Z');
    expect(f.toExclusive?.toISOString()).toBe('2026-11-03T00:00:00.000Z');
    expect(f.actorId).toBe('0b8f2f0e-6d2c-4f43-9a3e-7c1d2e3f4a5b');
    expect(f.cursor).toBe(120);
  });

  it('a date-time `to` is inclusive', () => {
    expect(
      parseAuditEventsQuery({
        to: '2026-11-02T10:00:00Z',
      }).toInclusive?.toISOString(),
    ).toBe('2026-11-02T10:00:00.000Z');
  });

  it.each([
    [{ from: 'yesterday' }],
    [{ from: '2026-13-45' }],
    [{ to: '2026-01-01', from: '2026-02-01' }],
    [{ action: 'lower_case' }],
    [{ action: "A'; DROP" }],
    [{ actorId: 'not-a-uuid' }],
    [{ requestId: '123' }],
    [{ cursor: '0' }],
    [{ cursor: '-5' }],
    [{ cursor: '1.5' }],
    [{ cursor: 'abc' }],
    [{ entityType: 'a b' }],
    [{ entityId: 'x'.repeat(129) }],
    [{ action: ['A', 'B'] }],
    [{ action: '' }],
    // Story 20.1 QA round 2 (AC9): used to be a 500 or a silently shifted date
    [{ entityId: '\u0000' }],
    [{ entityId: 'a\u0000b' }],
    [{ entityId: 'x\ud800y' }],
    [{ from: '0000-01-01' }],
    [{ from: '0001-01-01' }],
    [{ from: '1999-12-31' }],
    [{ from: '3000-01-01' }],
    [{ from: '9999-12-31' }],
    [{ to: '0000-12-31' }],
    [{ from: '2026-02-30' }],
    [{ from: '2026-02-29' }],
    [{ from: '2026-04-31' }],
    [{ from: '2026-00-10' }],
    [{ from: '2026-11-00' }],
    [{ to: '2026-06-31' }],
    [{ from: '2026-02-30T10:00:00Z' }],
    [{ from: '2026-11-03T24:00:00Z' }],
    [{ from: '2026-11-03T23:60:00Z' }],
    [{ from: '2026-11-03T23:59:60Z' }],
    [{ from: '2026-11-03T10:00:00+24:00' }],
    [{ from: '2026-11-03T10:00:00+05:60' }],
    [{ from: '2026-11-03T10:00:00' }], // no offset
    [{ from: '2026-11-03 10:00:00Z' }],
    [{ from: '+002026-11-03' }],
    [{ from: '20261103' }],
    [{ from: '2026-1-3' }],
    [{ cursor: '9007199254740992' }],
    [{ cursor: '9999999999999999' }],
    [{ from: { a: 1 } }],
  ])('rejects %j', (q) => {
    expect(() => parseAuditEventsQuery(q)).toThrow();
  });

  it('a real leap day, offsets and fractions are fine', () => {
    expect(
      parseAuditEventsQuery({ from: '2028-02-29' }).from?.toISOString(),
    ).toBe('2028-02-29T00:00:00.000Z');
    expect(
      parseAuditEventsQuery({
        from: '2026-11-03T10:00:00.5+02:00',
      }).from?.toISOString(),
    ).toBe('2026-11-03T08:00:00.500Z');
    expect(
      parseAuditEventsQuery({
        from: '2026-11-03T10:00-04:30',
      }).from?.toISOString(),
    ).toBe('2026-11-03T14:30:00.000Z');
    expect(
      parseAuditEventsQuery({ entityId: 'é'.repeat(128) }).entityId,
    ).toHaveLength(128);
    expect(
      parseAuditEventsQuery({ entityId: '😀'.repeat(128) }).entityId,
    ).toBeDefined(); // 128 code points
    expect(() =>
      parseAuditEventsQuery({ entityId: '😀'.repeat(129) }),
    ).toThrow();
  });
});
