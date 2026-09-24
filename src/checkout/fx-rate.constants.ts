/**
 * Story 4.1 (AD-4): the fixed, well-known `id` of the single mutable
 * `FxRateSetting` row that represents "the store's current admin-maintained
 * VES/USD exchange rate" — see that model's doc comment in
 * `prisma/schema.prisma` for the full gap writeup (no Sprint 3 story yet
 * owns an admin endpoint to edit this row; it is seeded once by
 * `prisma/seed.ts` and only ever read here at checkout time).
 *
 * A constant instead of a magic string repeated in the seed script and
 * `CheckoutService`, so both always agree on which row is "the" rate.
 */
export const SINGLETON_FX_RATE_ID = 'default';
