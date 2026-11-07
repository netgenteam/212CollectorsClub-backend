import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { PUBLIC_STATIC_PREFIX } from '../admin-catalog/product-image-upload-paths.constants.js';

/** HSTS lifetime in production: 180 days. No `includeSubDomains` and no `preload` (a decision for the whole domain). */
export const HSTS_MAX_AGE_SECONDS = 15552000;

/** The API serves JSON only: no page may load anything from it nor frame it. */
const API_CSP = {
  useDefaults: false,
  directives: {
    'default-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-ancestors': ["'none'"],
  },
};

type Env = Record<string, string | undefined>;

/**
 * Story 20.11 (security audit, high priority 3): response headers of the Nest app, with `helmet`.
 *  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` + CSP `frame-ancestors 'none'`,
 *    `Referrer-Policy: no-referrer`, `Cross-Origin-Resource-Policy: same-origin`, no `X-Powered-By`.
 *  - `Strict-Transport-Security` ONLY with `NODE_ENV=production` (a browser ignores it over plain http; behind
 *    Traefik/Nginx the TLS is theirs and the header is the same one they could add).
 *  - Swagger UI (`/api/docs`, dev only, or `SWAGGER_ENABLED=true`) needs inline scripts and styles: it is served
 *    WITHOUT the CSP (the other headers stay). Every other path keeps the strict API CSP.
 *  - Public product images (`/uploads/public`) are meant to be embedded by the storefront, so CORP is `cross-origin`
 *    there (the storefront normally reaches them through its own origin: next.config rewrite).
 *  - The Stripe webhook is not affected: helmet only sets response headers, it never touches the request body
 *    (`rawBody` stays intact), and nothing here adds CORS.
 */
export function applySecurityHeaders(
  app: NestExpressApplication,
  env: Env = process.env,
): void {
  // helmet's own X-Powered-By removal stays on (its default); Express stops adding the header at all.
  app.disable('x-powered-by');
  const production = env.NODE_ENV === 'production';
  const common = {
    strictTransportSecurity: production
      ? { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: false }
      : false,
    xFrameOptions: { action: 'deny' as const },
    referrerPolicy: { policy: 'no-referrer' as const },
  };
  const strict = helmet({
    ...common,
    contentSecurityPolicy: API_CSP,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  const docs = helmet({
    ...common,
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
  const publicFiles = helmet({
    ...common,
    contentSecurityPolicy: API_CSP,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const path = req.path;
    if (
      path === '/api/docs' ||
      path.startsWith('/api/docs/') ||
      path === '/api/docs-json'
    ) {
      return docs(req, res, next);
    }
    if (path.startsWith(PUBLIC_STATIC_PREFIX)) {
      return publicFiles(req, res, next);
    }
    return strict(req, res, next);
  });
}
