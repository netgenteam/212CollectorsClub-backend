import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { HttpStatus } from '@nestjs/common';
import { diskStorage } from 'multer';
import { ApiException } from '../common/api-exception.js';
import {
  ALLOWED_PRODUCT_IMAGE_MIME_TYPES,
  MAX_PRODUCT_IMAGES_PER_REQUEST,
  MAX_PRODUCT_IMAGE_BYTES,
  PRODUCT_IMAGES_DIR,
} from './product-image-upload-paths.constants.js';

// Same multer/Nest FileFilterCallback type mismatch documented in
// `src/orders/proof-of-payment-multer.config.ts` — see that file's own doc
// comment for the full reasoning; left uninferred here for the same reason.
type MulterFileFilterCallback = (
  error: Error | null,
  acceptFile: boolean,
) => void;

/**
 * Story 8.2 (AD-12): multer options for a Product-images multipart upload —
 * used by BOTH `FilesInterceptor('images', ..., ...)` call sites on
 * `AdminProductsController` (`POST /admin/products` at creation time, and
 * `POST /admin/products/:id/images` to add more later). Deliberately the
 * SAME options object shape both places — the storage/filename/fileFilter/
 * limits rules for "a Product image file" don't differ by which route
 * accepted it.
 *
 * Mirrors `createProofOfPaymentMulterOptions` (Story 4.2) closely — same
 * "never trust the client's filename" defense (`file.originalname` is never
 * read, not even to sanitize it; the server-chosen `randomUUID()` name is
 * the only thing ever written to disk) — but targets `PRODUCT_IMAGES_DIR`
 * (under the PUBLIC `uploads/public/` root, AD-12) instead of Story 4.2's
 * private root, and only accepts image MIME types (no PDF).
 */
export function createProductImageMulterOptions() {
  return {
    storage: diskStorage({
      destination: (_req, _file, callback) => {
        mkdir(PRODUCT_IMAGES_DIR, { recursive: true })
          .then(() => callback(null, PRODUCT_IMAGES_DIR))
          .catch((error: unknown) => {
            callback(error as Error, PRODUCT_IMAGES_DIR);
          });
      },
      filename: (_req, file, callback) => {
        const extension = ALLOWED_PRODUCT_IMAGE_MIME_TYPES[file.mimetype];
        // `fileFilter` below already rejects any mimetype outside the
        // allowlist before `filename` ever runs — see
        // `proof-of-payment-multer.config.ts` for why the `?? ''` fallback
        // exists regardless.
        callback(null, `${randomUUID()}${extension ?? ''}`);
      },
    }),
    limits: {
      fileSize: MAX_PRODUCT_IMAGE_BYTES,
      files: MAX_PRODUCT_IMAGES_PER_REQUEST,
    },
    fileFilter: (
      _req: unknown,
      file: Express.Multer.File,
      callback: MulterFileFilterCallback,
    ) => {
      if (!ALLOWED_PRODUCT_IMAGE_MIME_TYPES[file.mimetype]) {
        callback(
          new ApiException(
            HttpStatus.BAD_REQUEST,
            'UNSUPPORTED_FILE_TYPE',
            `Unsupported file type "${file.mimetype}". Allowed: ${Object.keys(
              ALLOWED_PRODUCT_IMAGE_MIME_TYPES,
            ).join(', ')}.`,
          ),
          false,
        );
        return;
      }
      callback(null, true);
    },
  };
}
