import { detectImageMime } from './image-mime.js';

const ascii = (s: string) => Buffer.from(s, 'ascii');

describe('detectImageMime', () => {
  it('detects jpeg, png, webp and avif by magic bytes', () => {
    expect(detectImageMime(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(
      'image/jpeg',
    );
    expect(
      detectImageMime(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]),
      ),
    ).toBe('image/png');
    expect(detectImageMime(ascii('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
    expect(detectImageMime(ascii('\0\0\0\x1cftypavif\0\0\0\0'))).toBe(
      'image/avif',
    );
    expect(detectImageMime(ascii('\0\0\0\x1cftypavis\0\0\0\0'))).toBe(
      'image/avif',
    );
  });

  it('rejects other ftyp brands, text and gif', () => {
    expect(detectImageMime(ascii('\0\0\0\x1cftypmp42\0\0\0\0'))).toBeNull();
    expect(detectImageMime(ascii('not an image at all'))).toBeNull();
    expect(detectImageMime(ascii('GIF89a......'))).toBeNull();
  });
});
