import { describe, expect, it } from 'vitest';
import { isValidImageUrl } from './image-url.validator.js';

describe('isValidImageUrl (Story 22.4, AC5)', () => {
  it.each([
    '/uploads/public/simulator/a.png',
    '/uploads/public/landing/dir/b-1_2.webp',
    'https://images.example.com/a/b.png?x=1',
  ])('accepts %s', (v) => expect(isValidImageUrl(v)).toBe(true));

  it.each([
    'http://example.com/a.png',
    'javascript:alert(1)',
    '//evil.com/a.png',
    '/uploads/public/simulator/../../etc/passwd',
    '/uploads/public/simulator/a/../b.png',
    '/uploads/private/simulator/a.png',
    '/uploads/public/other/a.png',
    'https://user:pw@example.com/a.png',
    'https://user@example.com/a.png',
    'https://',
    'https://exa mple.com/a.png',
    'https://example.com/a\n.png',
    'ftp://example.com/a.png',
    'data:image/png;base64,AAAA',
    '',
    `https://example.com/${'a'.repeat(300)}`,
    42,
    null,
    undefined,
  ])('rejects %j', (v) => expect(isValidImageUrl(v)).toBe(false));

  it('accepts 300 chars and rejects 301', () => {
    const base = 'https://e.com/';
    expect(isValidImageUrl(base + 'a'.repeat(300 - base.length))).toBe(true);
    expect(isValidImageUrl(base + 'a'.repeat(301 - base.length))).toBe(false);
  });
});
