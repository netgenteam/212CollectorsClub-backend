import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import {
  HttpMasterCardImageDownloader,
  MasterCardImageUnavailableError,
  detectImageMime,
} from './master-card-image-downloader.js';
import { MAX_PRODUCT_IMAGE_BYTES } from './product-image-upload-paths.constants.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([1, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
]);
const HOST = 'product-images.tcgplayer.com';
const OK_URL = `https://${HOST}/x/large.jpg`;

function imageResponse(
  body: Buffer,
  type = 'image/jpeg',
  extra: Record<string, string> = {},
): Response {
  return new Response(new Uint8Array(body), {
    status: 200,
    headers: { 'content-type': type, ...extra },
  });
}

/** Story 15.6 (AD-57, A33, R5): SSRF rules of the downloader, no network. */
describe('HttpMasterCardImageDownloader', () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let downloader: HttpMasterCardImageDownloader;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'mc-img-'));
    fetchMock = vi.fn();
    downloader = new HttpMasterCardImageDownloader(
      new ConfigService({}),
      fetchMock as never,
      dir,
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const expectUnavailable = async (urls: string[]) => {
    await expect(downloader.download(urls)).rejects.toBeInstanceOf(
      MasterCardImageUnavailableError,
    );
    expect(await readdir(dir)).toEqual([]);
  };

  it('detects jpeg/png/webp magic bytes only', () => {
    expect(detectImageMime(JPEG)).toBe('image/jpeg');
    expect(detectImageMime(PNG)).toBe('image/png');
    expect(detectImageMime(WEBP)).toBe('image/webp');
    expect(detectImageMime(Buffer.from('GIF89a......'))).toBeNull();
  });

  it.each([
    ['jpeg', JPEG, 'image/jpeg', '.jpg'],
    ['png', PNG, 'image/png', '.png'],
    ['webp', WEBP, 'image/webp', '.webp'],
  ])('stores a valid %s with a server-chosen name', async (_n, b, t, ext) => {
    fetchMock.mockResolvedValue(imageResponse(b, `${t}; charset=binary`));
    const res = await downloader.download([OK_URL]);
    expect(res.filename.endsWith(ext)).toBe(true);
    expect(await readFile(res.path)).toEqual(b);
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ redirect: 'manual' });
  });

  it('rejects a host outside the allowlist without fetching', async () => {
    await expectUnavailable(['https://evil.example.com/a.jpg']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'http://product-images.tcgplayer.com/a.jpg',
    'https://product-images.tcgplayer.com:8443/a.jpg',
    'https://user:pw@product-images.tcgplayer.com/a.jpg',
    'https://127.0.0.1/a.jpg',
    'https://product-images.tcgplayer.com.evil.com/a.jpg',
    'not a url',
    'file:///etc/passwd',
  ])('rejects %s without fetching', async (url) => {
    await expectUnavailable([url]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('follows a redirect inside the allowlist', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: `https://tcgplayer-cdn.tcgplayer.com/b.jpg` },
        }),
      )
      .mockResolvedValueOnce(imageResponse(JPEG));
    await downloader.download([OK_URL]);
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://tcgplayer-cdn.tcgplayer.com/b.jpg',
    );
  });

  it.each([
    'https://evil.example.com/b.jpg',
    'http://product-images.tcgplayer.com/b.jpg',
  ])('rejects a redirect to %s', async (location) => {
    fetchMock.mockResolvedValue(
      new Response(null, { status: 301, headers: { location } }),
    );
    await expectUnavailable([OK_URL]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after more than 2 redirects', async () => {
    fetchMock.mockImplementation(
      () => new Response(null, { status: 302, headers: { location: OK_URL } }),
    );
    await expectUnavailable([OK_URL]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('rejects a non-2xx status', async () => {
    fetchMock.mockResolvedValue(new Response('x', { status: 404 }));
    await expectUnavailable([OK_URL]);
  });

  it('rejects a disallowed content-type', async () => {
    fetchMock.mockResolvedValue(imageResponse(JPEG, 'image/gif'));
    await expectUnavailable([OK_URL]);
  });

  it('rejects bytes that are not an image despite an image content-type', async () => {
    fetchMock.mockResolvedValue(
      imageResponse(Buffer.from('<html>not an image</html>')),
    );
    await expectUnavailable([OK_URL]);
  });

  it('rejects when content-type and magic bytes disagree', async () => {
    fetchMock.mockResolvedValue(imageResponse(PNG, 'image/jpeg'));
    await expectUnavailable([OK_URL]);
  });

  it('rejects an oversized content-length and an oversized streamed body', async () => {
    fetchMock.mockResolvedValueOnce(
      imageResponse(JPEG, 'image/jpeg', {
        'content-length': String(MAX_PRODUCT_IMAGE_BYTES + 1),
      }),
    );
    await expectUnavailable([OK_URL]);
    const big = Buffer.concat([JPEG, Buffer.alloc(MAX_PRODUCT_IMAGE_BYTES)]);
    fetchMock.mockResolvedValueOnce(imageResponse(big));
    await expectUnavailable([OK_URL]);
  });

  it('rejects an empty body and a network error', async () => {
    fetchMock.mockResolvedValueOnce(imageResponse(Buffer.alloc(0)));
    await expectUnavailable([OK_URL]);
    fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'));
    await expectUnavailable([OK_URL]);
  });

  it('falls back to the second url when the first fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('x', { status: 500 }))
      .mockResolvedValueOnce(imageResponse(PNG, 'image/png'));
    const res = await downloader.download([
      OK_URL,
      `https://${HOST}/x/small.png`,
    ]);
    expect(res.filename.endsWith('.png')).toBe(true);
  });

  it('fails with no urls', async () => {
    await expectUnavailable([]);
  });

  it('honours TCG_IMAGE_ALLOWED_HOSTS', async () => {
    const custom = new HttpMasterCardImageDownloader(
      new ConfigService({ TCG_IMAGE_ALLOWED_HOSTS: ' Img.Example.com ' }),
      fetchMock as never,
      dir,
    );
    fetchMock.mockResolvedValue(imageResponse(JPEG));
    await custom.download(['https://img.example.com/a.jpg']);
    await expect(custom.download([OK_URL])).rejects.toBeInstanceOf(
      MasterCardImageUnavailableError,
    );
  });
});
