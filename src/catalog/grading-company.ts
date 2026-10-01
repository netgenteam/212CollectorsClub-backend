/**
 * Story 11.1 (AD-18): grading houses accepted for `Product.gradingCompany`.
 * A TS const (not a Prisma enum) so new houses can be added without an
 * `ALTER TYPE`; validated at the DTO layer. `RAW` = ungraded.
 */
export const GradingCompany = {
  PSA: 'PSA',
  BGS: 'BGS',
  CGC: 'CGC',
  RAW: 'RAW',
} as const;

export type GradingCompany =
  (typeof GradingCompany)[keyof typeof GradingCompany];

/** Alphanumeric only, 1..50 chars (PRD A3). */
export const CERT_NUMBER_REGEX = /^[A-Za-z0-9]{1,50}$/;
