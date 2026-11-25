import { HttpStatus, Injectable } from '@nestjs/common';
import { ApiException } from '../../common/api-exception.js';
import {
  ImageInspectError,
  inspectImage,
  storeImage,
} from '../../common/image-store.js';
import {
  SIMULATOR_IMAGES_DIR,
  SIMULATOR_IMAGES_URL_PREFIX,
} from '../../admin-catalog/product-image-upload-paths.constants.js';

export const SIMULATOR_IMAGE_MAX_SIDE = 4096;
export const SIMULATOR_IMAGE_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** `SIMULATOR_IMAGE_MAX_BYTES` (def. = `LANDING_IMAGE_MAX_BYTES` = 2 MB). */
export function simulatorImageMaxBytes(): number {
  return (
    Number(process.env.SIMULATOR_IMAGE_MAX_BYTES) ||
    Number(process.env.LANDING_IMAGE_MAX_BYTES) ||
    SIMULATOR_IMAGE_DEFAULT_MAX_BYTES
  );
}

export interface SimulatorImageResult {
  url: string;
  width: number;
  height: number;
  bytes: number;
}

/**
 * Story 22.6 (AD-107, FR-151, A104, A117). Validates by CONTENT and stores
 * under `uploads/public/simulator/<uuid>.<ext>`. No card proportion; orphan
 * files are never deleted.
 */
@Injectable()
export class SimulatorImagesService {
  async upload(
    file: Pick<Express.Multer.File, 'buffer'> | undefined,
  ): Promise<SimulatorImageResult> {
    if (!file?.buffer) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'SIMULATOR_IMAGE_REQUIRED',
        'A "file" field with the image is required.',
      );
    }
    const buffer = file.buffer;
    if (buffer.length > simulatorImageMaxBytes()) {
      throw tooLarge();
    }
    let info;
    try {
      info = inspectImage(buffer, {
        minWidth: 1,
        maxSide: SIMULATOR_IMAGE_MAX_SIDE,
      });
    } catch (e) {
      if (!(e instanceof ImageInspectError)) throw e;
      if (e.reason === 'UNSUPPORTED_TYPE') {
        throw new ApiException(
          HttpStatus.BAD_REQUEST,
          'UNSUPPORTED_FILE_TYPE',
          e.message,
        );
      }
      throw new ApiException(
        HttpStatus.UNPROCESSABLE_ENTITY,
        'SIMULATOR_IMAGE_DIMENSIONS',
        e.message,
        e.details,
      );
    }
    const { url } = await storeImage(
      buffer,
      SIMULATOR_IMAGES_DIR,
      SIMULATOR_IMAGES_URL_PREFIX,
    );
    return {
      url,
      width: info.width,
      height: info.height,
      bytes: buffer.length,
    };
  }
}

export function tooLarge(): ApiException {
  const max = simulatorImageMaxBytes();
  return new ApiException(
    HttpStatus.PAYLOAD_TOO_LARGE,
    'SIMULATOR_IMAGE_TOO_LARGE',
    `The image exceeds the maximum of ${max} bytes.`,
    { maxBytes: max },
  );
}
