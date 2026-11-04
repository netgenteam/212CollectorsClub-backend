import {
  decodeCustomerCursor,
  encodeCustomerCursor,
  escapeLike,
} from './customer-directory.service.js';

const ID = '0b9a8a4e-6a5f-4d0d-9e3a-1c2d3e4f5a6b';

describe('customer cursor', () => {
  it('round-trips', () => {
    const d = new Date('2026-11-04T10:00:00.123Z');
    const c = encodeCustomerCursor(d, ID);
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCustomerCursor(c)).toEqual({ c: d, i: ID });
  });

  it.each([
    '',
    '!!!',
    'not-base64-json',
    Buffer.from('{"c":"x","i":"y"}').toString('base64url'),
    Buffer.from('[]').toString('base64url'),
    Buffer.from('{"c":"2026-13-45T00:00:00.000Z","i":"' + ID + '"}').toString(
      'base64url',
    ),
    Buffer.from('{"c":"2026-11-04","i":"' + ID + '"}').toString('base64url'),
    Buffer.from('{"c":"2026-11-04T10:00:00.000Z","i":"zz"}').toString(
      'base64url',
    ),
    'a'.repeat(201),
  ])('rejects %j with 400 CURSOR_INVALID', (raw) => {
    try {
      decodeCustomerCursor(raw);
      expect.unreachable('should have thrown');
    } catch (e) {
      const err = e as { status: number; response: { errorCode: string } };
      expect(err.status).toBe(400);
      expect(err.response.errorCode).toBe('CURSOR_INVALID');
    }
  });
});

describe('escapeLike (q is text to find, never a LIKE pattern)', () => {
  it.each([
    ['%%', '\\%\\%'],
    ['__', '\\_\\_'],
    ['a\\b', 'a\\\\b'],
    ['100%_x\\', '100\\%\\_x\\\\'],
    ['plain-text@x.co', 'plain-text@x.co'],
  ])('%j -> %j', (raw, escaped) => {
    expect(escapeLike(raw)).toBe(escaped);
  });
});
