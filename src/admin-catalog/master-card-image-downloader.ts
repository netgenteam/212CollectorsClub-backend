import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ALLOWED_PRODUCT_IMAGE_MIME_TYPES,
  MAX_PRODUCT_IMAGE_BYTES,
  PRODUCT_IMAGES_DIR,
} from './product-image-upload-paths.constants.js';

/** DI token: tests replace the downloader with a local, network-free fake. */
export const MASTER_CARD_IMAGE_DOWNLOADER = Symbol(
  'MASTER_CARD_IMAGE_DOWNLOADER',
);

export const DEFAULT_TCG_IMAGE_ALLOWED_HOSTS = [
  'product-images.tcgplayer.com',
  'tcgplayer-cdn.tcgplayer.com',
];
export const IMAGE_DOWNLOAD_TIMEOUT_MS = 10_000;
export const IMAGE_DOWNLOAD_MAX_REDIRECTS = 2;

/** A file already written under `PRODUCT_IMAGES_DIR`. */
export interface DownloadedImage {
  /** Server-chosen uuid name (feeds `buildProductImagePublicUrl`). */
  filename: string;
  /** Absolute path, used to delete the file if the product is not created. */
  path: string;
}

export interface MasterCardImageDownloader {
  /**
   * Tries each candidate url in order (imageLarge, then imageSmall) and
   * returns the first that downloads and validates. Throws
   * `MasterCardImageUnavailableError` when none does; never leaves a file.
   */
  download(urls: readonly string[]): Promise<DownloadedImage>;
}

export class MasterCardImageUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'MasterCardImageUnavailableError';
  }
}

type FetchLike = (
  url: string,
  init: { redirect: 'manual'; signal: AbortSignal; headers: HeadersInit },
) => Promise<Response>;

/** Declared mime type of the bytes, from their magic number. */
export function detectImageMime(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return 'image/png';
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.subarray(from, to));
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/**
 * Story 15.6 (AD-57, A33, R5). Downloads a master card image into the product
 * images directory with the SSRF rules: https only, port 443, host in the
 * `TCG_IMAGE_ALLOWED_HOSTS` allowlist, no credentials in the url, manual
 * redirects (max 2, each re-validated against the same rules), 10 s timeout,
 * byte cap `MAX_PRODUCT_IMAGE_BYTES`, content-type AND magic bytes must be
 * jpeg/png/webp and agree with each other. Built by a factory provider (see
 * `AdminCatalogModule`); `fetchImpl`/`imagesDir` exist for unit tests.
 */
export class HttpMasterCardImageDownloader implements MasterCardImageDownloader {
  private readonly logger = new Logger(HttpMasterCardImageDownloader.name);
  private readonly allowedHosts: ReadonlySet<string>;

  constructor(
    configService: ConfigService,
    private readonly fetchImpl: FetchLike = (url, init) => fetch(url, init),
    private readonly imagesDir: string = PRODUCT_IMAGES_DIR,
  ) {
    const raw = configService.get<string>('TCG_IMAGE_ALLOWED_HOSTS');
    const hosts = raw
      ? raw
          .split(',')
          .map((h) => h.trim().toLowerCase())
          .filter(Boolean)
      : DEFAULT_TCG_IMAGE_ALLOWED_HOSTS;
    this.allowedHosts = new Set(hosts);
  }

  async download(urls: readonly string[]): Promise<DownloadedImage> {
    const reasons: string[] = [];
    for (const url of urls) {
      try {
        return await this.downloadOne(url);
      } catch (err) {
        const reason = err instanceof Error ? err.message : 'unknown error';
        reasons.push(reason);
        this.logger.warn(`Master card image rejected: ${reason}`);
      }
    }
    throw new MasterCardImageUnavailableError(
      reasons.length > 0 ? reasons.join('; ') : 'master card has no image url',
    );
  }

  /** Returns the parsed url or throws when it breaks a rule. */
  private assertAllowed(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error('invalid image url');
    }
    if (url.protocol !== 'https:') throw new Error('image url is not https');
    if (url.username || url.password) {
      throw new Error('image url carries credentials');
    }
    if (url.port !== '' && url.port !== '443') {
      throw new Error('image url port is not 443');
    }
    if (!this.allowedHosts.has(url.hostname.toLowerCase())) {
      throw new Error(`image host "${url.hostname}" is not allowlisted`);
    }
    return url;
  }

  private async downloadOne(rawUrl: string): Promise<DownloadedImage> {
    let url = this.assertAllowed(rawUrl);
    let response: Response | undefined;
    for (let hop = 0; hop <= IMAGE_DOWNLOAD_MAX_REDIRECTS + 1; hop += 1) {
      response = await this.fetchImpl(url.toString(), {
        redirect: 'manual',
        signal: AbortSignal.timeout(IMAGE_DOWNLOAD_TIMEOUT_MS),
        headers: { Accept: 'image/jpeg,image/png,image/webp' },
      });
      if (response.status < 300 || response.status >= 400) break;
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (!location || hop === IMAGE_DOWNLOAD_MAX_REDIRECTS) {
        throw new Error('too many or invalid redirects');
      }
      url = this.assertAllowed(new URL(location, url).toString());
    }
    if (!response || !response.ok) {
      await response?.body?.cancel().catch(() => undefined);
      throw new Error(`image request failed with status ${response?.status}`);
    }

    const declared = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_PRODUCT_IMAGE_MIME_TYPES[declared]) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`unsupported content-type "${declared}"`);
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_PRODUCT_IMAGE_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error('image exceeds the byte cap');
    }

    const bytes = await this.readCapped(response);
    const detected = detectImageMime(bytes);
    if (detected === null || detected !== declared) {
      throw new Error('image bytes are not a valid jpeg/png/webp');
    }

    const filename = `${randomUUID()}${ALLOWED_PRODUCT_IMAGE_MIME_TYPES[detected]}`;
    const path = join(this.imagesDir, filename);
    await mkdir(this.imagesDir, { recursive: true });
    try {
      await writeFile(path, bytes, { flag: 'wx' });
    } catch (err) {
      await unlink(path).catch(() => undefined);
      throw err;
    }
    return { filename, path };
  }

  private async readCapped(response: Response): Promise<Uint8Array> {
    if (!response.body) throw new Error('empty image body');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PRODUCT_IMAGE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error('image exceeds the byte cap');
      }
      chunks.push(value);
    }
    if (total === 0) throw new Error('empty image body');
    return Buffer.concat(chunks);
  }
}
