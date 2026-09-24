import { join } from 'node:path';

/**
 * Story 4.2 (AD-12): the private upload root — `uploads/private/` — is
 * resolved relative to `process.cwd()` (the process's working directory
 * when the app is started, whether via `nest start`, `node dist/main.js`,
 * or a test runner), the same convention `.gitignore`'s `/uploads` entry
 * at the repo root already assumes. AD-12's other root, `uploads/public/`
 * (Product Images, static-mounted), belongs to Story 8.2 and is not
 * created here.
 *
 * **Never static-mounted** — confirmed by inspection: nothing in this
 * codebase calls `ServeStaticModule.forRoot` or
 * `app.useStaticAssets`/`NestExpressApplication#useStaticAssets` anywhere
 * (checked `src/main.ts` and every module), so there is no static-serve
 * root to accidentally point at this directory, and none is added by this
 * story either.
 */
export const UPLOADS_PRIVATE_ROOT = join(process.cwd(), 'uploads', 'private');

/** Subdirectory (under `UPLOADS_PRIVATE_ROOT`) proof-of-payment files land in. */
export const PROOF_OF_PAYMENT_SUBDIR = 'proof-of-payment';

export const PROOF_OF_PAYMENT_DIR = join(
  UPLOADS_PRIVATE_ROOT,
  PROOF_OF_PAYMENT_SUBDIR,
);

/**
 * Allowlisted MIME types for a Pago Móvil proof-of-payment upload: a photo
 * of the transfer confirmation screen (the overwhelmingly common case) or a
 * PDF (a bank-emailed receipt). Deliberately narrow — this is a criterion
 * call for this story (not a fixed AC), chosen to cover what a Venezuelan
 * bank app / buyer phone realistically produces without accepting arbitrary
 * file types onto the server's disk. Extending this list later (e.g. HEIC)
 * is a one-line change here, nothing else.
 */
export const ALLOWED_MIME_TYPES: Readonly<Record<string, string>> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
};

/**
 * 10 MiB — a criterion call for this story (no fixed AC): generous enough
 * for an uncompressed bank-app screenshot or a scanned receipt, small
 * enough that a single upload can't meaningfully be used to fill the VPS's
 * disk. Multer enforces this during the multipart stream itself (the
 * request is aborted, not fully buffered then rejected).
 */
export const MAX_PROOF_OF_PAYMENT_BYTES = 10 * 1024 * 1024;
