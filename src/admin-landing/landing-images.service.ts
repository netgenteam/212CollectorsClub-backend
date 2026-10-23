import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HttpStatus, Injectable } from '@nestjs/common';
import { imageSize } from 'image-size';
import { ApiException } from '../common/api-exception.js';
import { detectImageMime } from '../common/image-mime.js';
import {
  LANDING_IMAGES_DIR,
  LANDING_IMAGES_URL_PREFIX,
} from '../admin-catalog/product-image-upload-paths.constants.js';

export type LandingImageKind = 'generic' | 'card';

export const LANDING_IMAGE_MIN_WIDTH = 200;
export const LANDING_IMAGE_MAX_SIDE = 4096;
export const LANDING_CARD_RATIO = 63 / 88;
export const LANDING_CARD_RATIO_TOLERANCE = 0.03;

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
};

export interface LandingImageResult {
  url: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Story 16.2 (FR-72, R4; AD-64). Validates a landing image by CONTENT
 * (magic bytes, then dimensions via `image-size`; the declared Content-Type
 * is ignored) and stores it under `uploads/public/landing/<uuid>.<ext>`
 * only after every check passed, so a failure leaves nothing on disk.
 */
@Injectable()
export class LandingImagesService {
  async upload(
    file: Pick<Express.Multer.File, 'buffer'> | undefined,
    kind: LandingImageKind,
  ): Promise<LandingImageResult> {
    if (!file?.buffer || file.buffer.length === 0) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'LANDING_IMAGE_REQUIRED',
        'A "file" field with the image is required.',
      );
    }
    const { mime, width, height } = this.inspect(file.buffer, kind);
    await mkdir(LANDING_IMAGES_DIR, { recursive: true });
    const filename = `${randomUUID()}.${EXTENSIONS[mime]}`;
    await writeFile(join(LANDING_IMAGES_DIR, filename), file.buffer, {
      flag: 'wx',
    });
    return {
      url: `${LANDING_IMAGES_URL_PREFIX}${filename}`,
      width,
      height,
      bytes: file.buffer.length,
    };
  }

  /**
   * Re-applies the card proportion to an already stored landing image (used
   * when a `heroScene` draft references `/uploads/public/landing/...`).
   * 400 `LANDING_IMAGE_NOT_FOUND` if the file is missing.
   */
  async assertStoredCard(url: string): Promise<void> {
    const filename = basename(url);
    if (`${LANDING_IMAGES_URL_PREFIX}${filename}` !== url) {
      throw notFound(url);
    }
    let buffer: Buffer;
    try {
      buffer = await readFile(join(LANDING_IMAGES_DIR, filename));
    } catch {
      throw notFound(url);
    }
    const { width, height } = this.inspect(buffer, 'card');
    void width;
    void height;
  }

  private inspect(
    buffer: Buffer,
    kind: LandingImageKind,
  ): { mime: string; width: number; height: number } {
    const mime = detectImageMime(buffer);
    if (mime === null) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'UNSUPPORTED_FILE_TYPE',
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
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'UNSUPPORTED_FILE_TYPE',
        'The image could not be decoded.',
      );
    }
    if (
      width < LANDING_IMAGE_MIN_WIDTH ||
      width > LANDING_IMAGE_MAX_SIDE ||
      height > LANDING_IMAGE_MAX_SIDE
    ) {
      throw new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'LANDING_IMAGE_DIMENSIONS',
        `Width must be ${LANDING_IMAGE_MIN_WIDTH}-${LANDING_IMAGE_MAX_SIDE} px and height at most ${LANDING_IMAGE_MAX_SIDE} px (got ${width}x${height}).`,
        { width, height },
      );
    }
    if (kind === 'card') {
      const deviation =
        Math.abs(width / height - LANDING_CARD_RATIO) / LANDING_CARD_RATIO;
      if (deviation > LANDING_CARD_RATIO_TOLERANCE) {
        throw new ApiException(
          HttpStatus.UNPROCESSABLE_ENTITY,
          'LANDING_IMAGE_BAD_RATIO',
          'A card image must have a 63:88 proportion (±3 %).',
          {
            width,
            height,
            expected: 0.7159,
            tolerance: LANDING_CARD_RATIO_TOLERANCE,
          },
        );
      }
    }
    return { mime, width, height };
  }
}

function notFound(url: string): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'LANDING_IMAGE_NOT_FOUND',
    `The image "${url}" does not exist on the server.`,
    { url },
  );
}
