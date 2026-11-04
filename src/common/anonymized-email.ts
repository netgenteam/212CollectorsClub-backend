import { timingSafeEqual, createHash } from 'node:crypto';
import { registerDecorator } from 'class-validator';
import type { ValidationOptions } from 'class-validator';

/**
 * Story 20.6 (AD-98, A84): the reserved, non-routable domain of an anonymized account
 * (`deleted+<uuid>@anonymized.invalid`; `.invalid` is reserved by RFC 2606 and can never receive
 * mail). A customer must never be able to register, log in or ask for a reset AS one of those
 * addresses: nothing real can live there, and a person who typed `deleted+...@anonymized.invalid`
 * into a form is probing the system.
 */
export const ANONYMIZED_EMAIL_DOMAIN = 'anonymized.invalid';

export function anonymizedEmailFor(customerId: string): string {
  return `deleted+${customerId}@${ANONYMIZED_EMAIL_DOMAIN}`;
}

/** Lower-case, trim, NFKC (full-width letters, ligatures) and no trailing dot of the domain. */
export function normalizeEmailForCompare(raw: string): string {
  return raw.normalize('NFKC').trim().toLowerCase();
}

/**
 * True when the domain of `email` is `anonymized.invalid` or any subdomain of it, whatever the
 * letter case, Unicode form or trailing dot. The domain is whatever follows the LAST `@`
 * (a quoted local part may contain `@`).
 */
export function isAnonymizedEmail(email: unknown): boolean {
  if (typeof email !== 'string') return false;
  const e = normalizeEmailForCompare(email);
  const at = e.lastIndexOf('@');
  if (at < 0) return false;
  const domain = e.slice(at + 1).replace(/\.+$/, '');
  return (
    domain === ANONYMIZED_EMAIL_DOMAIN ||
    domain.endsWith(`.${ANONYMIZED_EMAIL_DOMAIN}`)
  );
}

/**
 * Safe comparison of the email an admin typed against the real one: both sides are normalized
 * and compared by constant-time equality of their SHA-256 (so neither the length nor the first
 * different character leaks through timing). Returns a boolean only: the caller must never put
 * either value in an error.
 */
export function emailsMatch(typed: string, actual: string): boolean {
  const a = createHash('sha256')
    .update(normalizeEmailForCompare(typed))
    .digest();
  const b = createHash('sha256')
    .update(normalizeEmailForCompare(actual))
    .digest();
  return timingSafeEqual(a, b);
}

/** class-validator decorator: the email's domain must not be the reserved anonymization domain. */
export function IsNotAnonymizedEmailDomain(
  options?: ValidationOptions,
): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isNotAnonymizedEmailDomain',
      target: object.constructor,
      propertyName: propertyName as string,
      options: {
        message: 'email uses a domain that cannot be registered',
        ...options,
      },
      validator: {
        validate: (value: unknown) => !isAnonymizedEmail(value),
      },
    });
  };
}
