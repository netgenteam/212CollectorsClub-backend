import { registerDecorator, type ValidationOptions } from 'class-validator';

/**
 * Story 22.4 (AD-107): shared `imageUrl` rule of manual sets/cards (22.5, 22.7 reuse it). The URL is
 * only stored, never fetched (no SSRF). Allowed: an own upload path, or a parseable `https://` URL
 * without credentials; at most 300 characters; no control characters or whitespace.
 */
export const IMAGE_URL_MAX = 300;
const OWN_PATH_RE =
  /^\/uploads\/public\/(simulator|landing)\/[A-Za-z0-9_\-./]+$/;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS_RE = /[\s\u0000-\u001f\u007f]/;

export function isValidImageUrl(v: unknown): v is string {
  if (typeof v !== 'string' || v.length === 0 || v.length > IMAGE_URL_MAX)
    return false;
  if (FORBIDDEN_CHARS_RE.test(v)) return false;
  if (v.startsWith('/'))
    return OWN_PATH_RE.test(v) && !v.split('/').includes('..');
  if (!v.startsWith('https://')) return false;
  try {
    const u = new URL(v);
    return (
      u.protocol === 'https:' &&
      u.hostname.length > 0 &&
      u.username === '' &&
      u.password === ''
    );
  } catch {
    return false;
  }
}

/** class-validator decorator; `null`/`undefined` are skipped by `@IsOptional()` on the property. */
export function IsSimulatorImageUrl(options?: ValidationOptions) {
  return (target: object, propertyName: string): void =>
    registerDecorator({
      name: 'isSimulatorImageUrl',
      target: target.constructor,
      propertyName,
      options: {
        message: `${propertyName} must be an own /uploads/public/(simulator|landing)/ path or an https:// URL (max ${IMAGE_URL_MAX} chars, no credentials)`,
        ...options,
      },
      validator: { validate: (value: unknown) => isValidImageUrl(value) },
    });
}
