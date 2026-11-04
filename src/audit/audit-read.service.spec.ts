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
  ])('rejects %j', (q) => {
    expect(() => parseAuditEventsQuery(q)).toThrow();
  });
});
