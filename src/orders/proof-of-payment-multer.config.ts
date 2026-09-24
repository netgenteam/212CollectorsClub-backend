import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { HttpStatus } from '@nestjs/common';
import { diskStorage } from 'multer';
import { ApiException } from '../common/api-exception.js';
import {
  ALLOWED_MIME_TYPES,
  MAX_PROOF_OF_PAYMENT_BYTES,
  PROOF_OF_PAYMENT_DIR,
} from './upload-paths.constants.js';

/**
 * Nest's own `MulterOptions` type (`@nestjs/platform-express`) declares
 * `fileFilter`'s callback as a single, non-overloaded
 * `(error: Error | null, acceptFile: boolean) => void`, while multer's own
 * `FileFilterCallback` type is an *overloaded* signature (`(error: Error):
 * void` OR `(error: null, acceptFile: boolean): void`) — the two are not
 * structurally assignable to each other, so this factory's return type is
 * deliberately left uninferred/structural (not annotated as either
 * library's named options type) and this callback is typed to match
 * exactly what `FileInterceptor` expects at its call site. Multer's actual
 * runtime behavior doesn't care about the extra `acceptFile` argument being
 * present on an error call — only the type-checker does.
 */
type MulterFileFilterCallback = (
  error: Error | null,
  acceptFile: boolean,
) => void;

/**
 * Story 4.2: multer options for `POST .../proof-of-payment`'s single
 * `file` field — used by `FileInterceptor('file', ...)` on
 * `ProofOfPaymentController`. This interceptor runs *after*
 * `OrderAccessTokenGuard` (Nest's execution order is
 * Guards -> Interceptors -> Pipes -> Handler), so an invalid/missing token
 * is rejected before any multipart body is even parsed — no disk write
 * ever happens for a request this guard would reject.
 *
 * - **Storage**: disk, under `PROOF_OF_PAYMENT_DIR`
 *   (`uploads/private/proof-of-payment/`, AD-12 — never static-mounted).
 *   The directory is created lazily (idempotent
 *   `mkdir(..., { recursive: true })`) on first use rather than assumed to
 *   pre-exist, since `uploads/` is git-ignored and not part of a fresh
 *   checkout.
 * - **Filename — the actual path-traversal defense**: `randomUUID()` plus
 *   an allowlisted extension. `file.originalname` (the client-supplied
 *   filename) is **never read here, not even to sanitize it** — a request
 *   sending `../../../etc/passwd` as its filename has that string stored
 *   nowhere in the eventual disk path, because the server-chosen name
 *   never incorporates client input at all. This is deliberately a
 *   stronger guarantee than sanitizing/stripping traversal sequences
 *   (`../`, absolute paths, null bytes, etc.) from the client's name would
 *   be — there is nothing to bypass because nothing client-supplied is
 *   ever used to build the path.
 * - **fileFilter**: rejects (before any byte is written to disk) any MIME
 *   type not in `ALLOWED_MIME_TYPES` with a typed `ApiException` (400
 *   `UNSUPPORTED_FILE_TYPE`).
 * - **limits.fileSize**: `MAX_PROOF_OF_PAYMENT_BYTES` (10 MiB) — multer/
 *   busboy aborts the stream once the limit is crossed and raises a
 *   `MulterError` (code `LIMIT_FILE_SIZE`); `@nestjs/platform-express`'s own
 *   `FileInterceptor` already translates that into a typed
 *   `PayloadTooLargeException` (413) before it ever reaches this
 *   controller's code — see `ProofOfPaymentController`'s own doc comment
 *   for why this module deliberately does NOT add its own `MulterError`
 *   exception filter on top of that (it would never fire).
 */
export function createProofOfPaymentMulterOptions() {
  return {
    storage: diskStorage({
      destination: (_req, _file, callback) => {
        mkdir(PROOF_OF_PAYMENT_DIR, { recursive: true })
          .then(() => callback(null, PROOF_OF_PAYMENT_DIR))
          .catch((error: unknown) => {
            callback(error as Error, PROOF_OF_PAYMENT_DIR);
          });
      },
      filename: (_req, file, callback) => {
        const extension = ALLOWED_MIME_TYPES[file.mimetype];
        // `fileFilter` below already rejects any mimetype outside the
        // allowlist before `filename` ever runs, so `extension` is always
        // defined in practice — the `?? ''` fallback exists only so a
        // filename is never literally `"undefined"` if that invariant is
        // ever broken by a future change to either function.
        callback(null, `${randomUUID()}${extension ?? ''}`);
      },
    }),
    limits: {
      fileSize: MAX_PROOF_OF_PAYMENT_BYTES,
      files: 1,
    },
    fileFilter: (
      _req: unknown,
      file: Express.Multer.File,
      callback: MulterFileFilterCallback,
    ) => {
      if (!ALLOWED_MIME_TYPES[file.mimetype]) {
        callback(
          new ApiException(
            HttpStatus.BAD_REQUEST,
            'UNSUPPORTED_FILE_TYPE',
            `Unsupported file type "${file.mimetype}". Allowed: ${Object.keys(
              ALLOWED_MIME_TYPES,
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
