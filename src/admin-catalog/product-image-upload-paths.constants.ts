import { join } from 'node:path';

/**
 * Story 8.2 (AD-12): the PUBLIC upload root — `uploads/public/` — is the
 * only static-mounted path in this codebase (see `main.ts`'s
 * `app.useStaticAssets(UPLOADS_PUBLIC_ROOT, { prefix: PUBLIC_STATIC_PREFIX
 * })` call). Resolved relative to `process.cwd()`, the same convention
 * `src/orders/upload-paths.constants.ts` (Story 4.2) already uses for its
 * sibling PRIVATE root (`uploads/private/`, never static-mounted — see that
 * file's own doc comment) — the repo root `.gitignore`'s `/uploads` entry
 * already covers both, and both are created lazily on first upload
 * (`uploads/` is git-ignored, not part of a fresh checkout).
 *
 * **Contrast with Story 4.2 is the whole point of AD-12**: that story's
 * root is never passed to `useStaticAssets`/`ServeStaticModule` anywhere —
 * confirmed again here, right before adding the one and only call that
 * mounts a directory statically in this app, and it mounts THIS root, not
 * that one.
 */
export const UPLOADS_PUBLIC_ROOT = join(process.cwd(), 'uploads', 'public');

/** Subdirectory (under `UPLOADS_PUBLIC_ROOT`) Product image files land in. */
export const PRODUCT_IMAGES_SUBDIR = 'products';

export const PRODUCT_IMAGES_DIR = join(
  UPLOADS_PUBLIC_ROOT,
  PRODUCT_IMAGES_SUBDIR,
);

/**
 * The URL prefix `main.ts` mounts `UPLOADS_PUBLIC_ROOT` under
 * (`app.useStaticAssets(UPLOADS_PUBLIC_ROOT, { prefix: PUBLIC_STATIC_PREFIX
 * })`). Deliberately OUTSIDE the versioned `/api/v1` prefix — static assets
 * served by Express's own static middleware are not routed through Nest's
 * controller layer at all, so `setGlobalPrefix`/`enableVersioning`
 * (main.ts) never apply to it; a Product image's real, publicly-fetchable
 * URL is therefore `<host>/uploads/public/products/<file>`, not
 * `<host>/api/v1/...`.
 */
export const PUBLIC_STATIC_PREFIX = '/uploads/public/';

/** Builds the value stored on `ProductImage.url` for a file that
 * `createProductImageMulterOptions` just saved under `PRODUCT_IMAGES_DIR`
 * as `filename` — a server-relative path the client prefixes with the
 * API's own host to fetch the real file (same convention every other
 * relative-URL field in this codebase uses). */
export function buildProductImagePublicUrl(filename: string): string {
  return `${PUBLIC_STATIC_PREFIX}${PRODUCT_IMAGES_SUBDIR}/${filename}`;
}

/**
 * Allowlisted MIME types for a Product image upload — deliberately
 * image-only (unlike Story 4.2's proof-of-payment uploads, which also
 * allow `application/pdf` — a Product image is always a picture, never a
 * scanned document). A criterion call for this story, not a fixed AC.
 */
export const ALLOWED_PRODUCT_IMAGE_MIME_TYPES: Readonly<
  Record<string, string>
> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

/** 10 MiB per file — same criterion-call size Story 4.2 chose for its own
 * uploads, generous enough for an uncompressed product photo. */
export const MAX_PRODUCT_IMAGE_BYTES = 10 * 1024 * 1024;

/** Max number of image files accepted in a single multipart request
 * (either `POST .../products` at creation, or `POST .../products/:id/
 * images`) — a sane upper bound, not a fixed AC. */
export const MAX_PRODUCT_IMAGES_PER_REQUEST = 10;
