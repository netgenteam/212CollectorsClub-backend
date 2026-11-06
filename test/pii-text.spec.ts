import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  hasCedulaShapedNumber,
  letteredTag,
  stripUuids,
} from './helpers/pii-text.js';

describe('pii-text helpers (flakiness guards of the epic 20 regression)', () => {
  it('a UUID with an 8-digit group is not a cedula, but a real cedula next to it still is', () => {
    const uuid = '12345678-1234-4abc-9def-123456789012';
    expect(/\b\d{7,10}\b/.test(uuid)).toBe(true); // the old check would have failed here
    expect(hasCedulaShapedNumber(`(1,${uuid},RETENTION_PURGE_RUN)`)).toBe(
      false,
    );
    expect(hasCedulaShapedNumber(`(1,${uuid},V-87654321)`)).toBe(true);
    expect(hasCedulaShapedNumber(`(1,${uuid},"rif":"070133805")`)).toBe(true);
    expect(hasCedulaShapedNumber(`(1,${uuid},9876543210)`)).toBe(true);
    expect(stripUuids(`a ${uuid} b`)).toBe('a <uuid> b');
  });

  it('random UUIDs never trip the check', () => {
    for (let i = 0; i < 2000; i++) {
      expect(hasCedulaShapedNumber(`(${randomUUID()},${randomUUID()})`)).toBe(
        false,
      );
    }
  });

  it('the tag always has a letter, even when the random part is all digits', () => {
    const t = letteredTag('12345678abcdef');
    expect(t).toBe('t1234567');
    expect(/[A-Za-z]/.test(t)).toBe(true);
    expect(/(?<![A-Za-z0-9])\d{7,}/.test(`ref ${t}, 2026-11-05`)).toBe(false);
  });
});
