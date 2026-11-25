import { randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageSize } from 'image-size';
import { detectImageMime } from './image-mime.js';

/**
 * Story 22.6 (AD-107): image engine extracted from `LandingImagesService`
 * (Story 16.2). Content-based validation + atomic storage; callers map
 * `ImageInspectError` to their own `errorCode`s.
 */
export const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

export const CARD_RATIO = 63 / 88;
export const CARD_RATIO_TOLERANCE = 0.03;

export type ImageInspectReason =
  | 'UNSUPPORTED_TYPE' // magic bytes are not jpg/png/webp/avif
  | 'UNDECODABLE' // known format but size unreadable / 0
  | 'DIMENSIONS' // outside minWidth / maxSide
  | 'BAD_RATIO'; // cardRatio requested and not met

export class ImageInspectError extends Error {
  constructor(
    readonly reason: ImageInspectReason,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface InspectOptions {
  minWidth: number;
  maxSide: number;
  /** When true, width/height must match 63:88 within ±3 %. */
  cardRatio?: boolean;
}

export interface InspectedImage {
  mime: string;
  ext: string;
  width: number;
  height: number;
}

export function inspectImage(
  buffer: Buffer,
  { minWidth, maxSide, cardRatio }: InspectOptions,
): InspectedImage {
  const mime = detectImageMime(buffer);
  if (mime === null) {
    throw new ImageInspectError(
      'UNSUPPORTED_TYPE',
      'The file is not a jpg, png, webp or avif image.',
    );
  }
  let width: number | undefined;
  let height: number | undefined;
  try {
    ({ width, height } = imageSize(buffer));
  } catch {
    width = undefined;
  }
  if (!width || !height) {
    throw new ImageInspectError(
      'UNDECODABLE',
      'The image could not be decoded.',
    );
  }
  if (width < minWidth || width > maxSide || height > maxSide) {
    throw new ImageInspectError(
      'DIMENSIONS',
      `Width must be ${minWidth}-${maxSide} px and height at most ${maxSide} px (got ${width}x${height}).`,
      { width, height },
    );
  }
  if (cardRatio) {
    const deviation = Math.abs(width / height - CARD_RATIO) / CARD_RATIO;
    if (deviation > CARD_RATIO_TOLERANCE) {
      throw new ImageInspectError(
        'BAD_RATIO',
        'A card image must have a 63:88 proportion (±3 %).',
        {
          width,
          height,
          expected: 0.7159,
          tolerance: CARD_RATIO_TOLERANCE,
        },
      );
    }
  }
  return { mime, ext: IMAGE_EXTENSIONS[mime], width, height };
}

/**
 * Writes `buffer` as `<dir>/<uuid>.<ext>` (ext from content, never from the
 * client name) via a temp file + rename so a reader never sees a partial
 * file. Returns the public url `<urlPrefix><filename>`.
 */
export async function storeImage(
  buffer: Buffer,
  dir: string,
  urlPrefix: string,
): Promise<{ url: string; filename: string }> {
  const mime = detectImageMime(buffer);
  const ext = mime === null ? undefined : IMAGE_EXTENSIONS[mime];
  if (ext === undefined) {
    throw new ImageInspectError(
      'UNSUPPORTED_TYPE',
      'The file is not a jpg, png, webp or avif image.',
    );
  }
  await mkdir(dir, { recursive: true });
  const id = randomUUID();
  const filename = `${id}.${ext}`;
  const tmp = join(dir, `.${id}.tmp`);
  await writeFile(tmp, buffer, { flag: 'wx' });
  await rename(tmp, join(dir, filename));
  return { url: `${urlPrefix}${filename}`, filename };
}
