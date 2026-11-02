/** The six fixed legal documents (AD-88). The order is the public list order. */
export const LEGAL_SLUGS = [
  'terminos',
  'privacidad',
  'cookies',
  'envios',
  'devoluciones',
  'aviso-legal',
] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

/**
 * Sandbox documents (test helpers only, created through SQL; DB CHECK forces
 * `e2e-*` and `isSandbox`). The pipe lets the FORMAT through; the DB decides.
 */
export const SANDBOX_SLUG_RE = /^e2e-[a-z0-9][a-z0-9-]{0,50}$/;

/**
 * `e2e-*` is accepted ONLY outside production (the DB still decides whether a
 * sandbox document exists; in production none ever should).
 */
export const isLegalSlug = (v: string): boolean =>
  (LEGAL_SLUGS as readonly string[]).includes(v) ||
  (process.env.NODE_ENV !== 'production' && SANDBOX_SLUG_RE.test(v));
