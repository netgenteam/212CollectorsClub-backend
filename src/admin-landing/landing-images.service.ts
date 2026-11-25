import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../common/api-exception.js';
import {
  CARD_RATIO,
  CARD_RATIO_TOLERANCE,
  ImageInspectError,
  inspectImage,
  storeImage,
} from '../common/image-store.js';
import {
  LANDING_IMAGES_DIR,
  LANDING_IMAGES_URL_PREFIX,
} from '../admin-catalog/product-image-upload-paths.constants.js';

export type LandingImageKind = 'generic' | 'card';

export const LANDING_IMAGE_MIN_WIDTH = 200;
export const LANDING_IMAGE_MAX_SIDE = 4096;
export const LANDING_CARD_RATIO = CARD_RATIO;
export const LANDING_CARD_RATIO_TOLERANCE = CARD_RATIO_TOLERANCE;

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
    const { width, height } = this.inspect(file.buffer, kind);
    const { url } = await storeImage(
      file.buffer,
      LANDING_IMAGES_DIR,
      LANDING_IMAGES_URL_PREFIX,
    );
    return {
      url,
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
    try {
      return inspectImage(buffer, {
        minWidth: LANDING_IMAGE_MIN_WIDTH,
        maxSide: LANDING_IMAGE_MAX_SIDE,
        cardRatio: kind === 'card',
      });
    } catch (e) {
      if (!(e instanceof ImageInspectError)) throw e;
      switch (e.reason) {
        case 'DIMENSIONS':
          throw new ApiException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'LANDING_IMAGE_DIMENSIONS',
            e.message,
            e.details,
          );
        case 'BAD_RATIO':
          throw new ApiException(
            HttpStatus.UNPROCESSABLE_ENTITY,
            'LANDING_IMAGE_BAD_RATIO',
            e.message,
            e.details,
          );
        default:
          throw new ApiException(
            HttpStatus.BAD_REQUEST,
            'UNSUPPORTED_FILE_TYPE',
            e.message,
          );
      }
    }
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
