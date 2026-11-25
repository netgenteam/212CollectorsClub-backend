import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageInspectError, inspectImage, storeImage } from './image-store.js';
import {
  avifOf,
  jpegOf,
  pngOf,
  webpOf,
} from '../../test/fixtures/simulator-images.js';

const OPTS = { minWidth: 1, maxSide: 4096 };
const reasonOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof ImageInspectError ? e.reason : 'other';
  }
  return null;
};

describe('image-store', () => {
  describe('inspectImage', () => {
    it.each([
      ['png', pngOf(300, 200), 'image/png'],
      ['jpg', jpegOf(300, 200), 'image/jpeg'],
      ['webp', webpOf(300, 200), 'image/webp'],
      ['avif', avifOf(300, 200), 'image/avif'],
    ])('detects %s by content with its dimensions', (ext, buf, mime) => {
      expect(inspectImage(buf, OPTS)).toEqual({
        mime,
        ext: ext,
        width: 300,
        height: 200,
      });
    });

    it('rejects non-images and unsupported formats', () => {
      expect(reasonOf(() => inspectImage(Buffer.from('MZ.exe'), OPTS))).toBe(
        'UNSUPPORTED_TYPE',
      );
      expect(reasonOf(() => inspectImage(Buffer.alloc(0), OPTS))).toBe(
        'UNSUPPORTED_TYPE',
      );
      expect(
        reasonOf(() => inspectImage(Buffer.from('GIF89a......'), OPTS)),
      ).toBe('UNSUPPORTED_TYPE');
      expect(
        reasonOf(() => inspectImage(Buffer.from('<svg></svg>'), OPTS)),
      ).toBe('UNSUPPORTED_TYPE');
    });

    it('flags unreadable or zero dimensions', () => {
      expect(reasonOf(() => inspectImage(pngOf(0, 0), OPTS))).toBe(
        'UNDECODABLE',
      );
    });

    it('applies maxSide boundaries (4096 ok, 4097 not) and minWidth', () => {
      expect(reasonOf(() => inspectImage(pngOf(4096, 4096), OPTS))).toBeNull();
      expect(reasonOf(() => inspectImage(pngOf(4097, 10), OPTS))).toBe(
        'DIMENSIONS',
      );
      expect(reasonOf(() => inspectImage(pngOf(10, 4097), OPTS))).toBe(
        'DIMENSIONS',
      );
      expect(
        reasonOf(() =>
          inspectImage(pngOf(199, 300), { ...OPTS, minWidth: 200 }),
        ),
      ).toBe('DIMENSIONS');
    });

    it('checks the 63:88 ratio only with cardRatio', () => {
      expect(reasonOf(() => inspectImage(pngOf(1000, 1000), OPTS))).toBeNull();
      expect(reasonOf(() => inspectImage(pngOf(300, 900), OPTS))).toBeNull();
      expect(
        reasonOf(() =>
          inspectImage(pngOf(1000, 1000), { ...OPTS, cardRatio: true }),
        ),
      ).toBe('BAD_RATIO');
      expect(
        reasonOf(() =>
          inspectImage(pngOf(630, 880), { ...OPTS, cardRatio: true }),
        ),
      ).toBeNull();
    });
  });

  describe('storeImage', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'img-store-'));
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it('writes <uuid>.<ext> from the content, atomically (no temp left)', async () => {
      const buf = pngOf(10, 10);
      const { url, filename } = await storeImage(buf, dir, '/p/');
      expect(filename).toMatch(/^[0-9a-f-]{36}\.png$/);
      expect(url).toBe(`/p/${filename}`);
      expect(await readdir(dir)).toEqual([filename]);
      expect((await readFile(join(dir, filename))).equals(buf)).toBe(true);
    });

    it('creates the directory and never collides under concurrency', async () => {
      const sub = join(dir, 'nested');
      const rs = await Promise.all(
        Array.from({ length: 10 }, () => storeImage(webpOf(5, 5), sub, '/p/')),
      );
      expect(new Set(rs.map((r) => r.filename)).size).toBe(10);
      expect((await readdir(sub)).length).toBe(10);
    });

    it('refuses non-image content', async () => {
      await expect(
        storeImage(Buffer.from('hi'), dir, '/p/'),
      ).rejects.toBeInstanceOf(ImageInspectError);
      expect(await readdir(dir)).toEqual([]);
    });
  });
});
