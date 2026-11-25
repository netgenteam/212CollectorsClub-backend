import { BadRequestException } from '@nestjs/common';
import { sanitizeAuditPayload } from '../../audit/audit-payload.js';

/** Story 22.4 (AC3): name rules of a manual set. `nameKey` is the unique, case-insensitive key. */
export const SET_NAME_MAX = 120;

/**
 * Free text that ends up in the immutable audit chain (set name, imageUrl) is checked with the
 * audit guard's own detectors (e-mail, phone, id document, card number, secrets...) BEFORE the
 * transaction: a hit is a 400, never a 500 from the audit write and never PII in the chain.
 */
export function assertAuditSafeText(field: string, value: string): void {
  const { issues } = sanitizeAuditPayload({ [field]: value }, 'lenient', '$');
  if (issues.length > 0)
    throw new BadRequestException(
      `${field} must not contain emails, phone numbers, ID documents, card numbers or secrets`,
    );
}

const cpLen = (s: string): number => Array.from(s).length;

/** trim + collapse whitespace; 400 (standard shape) when empty, > 120 characters or holding NUL. */
export function normalizeSetName(raw: unknown): {
  name: string;
  nameKey: string;
} {
  if (typeof raw !== 'string')
    throw new BadRequestException('name must be a string');
  if (raw.includes('\u0000'))
    throw new BadRequestException('name must not contain NUL characters');
  const name = raw.replace(/\s+/gu, ' ').trim();
  if (name.length === 0)
    throw new BadRequestException('name must not be empty');
  if (cpLen(name) > SET_NAME_MAX)
    throw new BadRequestException(
      `name must be at most ${SET_NAME_MAX} characters`,
    );
  const nameKey = name.toLowerCase();
  // lower-casing can lengthen a string (e.g. "İ"): the column is VarChar(120)
  if (cpLen(nameKey) > SET_NAME_MAX)
    throw new BadRequestException(
      `name must be at most ${SET_NAME_MAX} characters`,
    );
  assertAuditSafeText('name', name);
  return { name, nameKey };
}
