/**
 * Story 21.2 (AD-105; FR-145..147). Pure helpers for the `enabled` flag of
 * the `home.drop212` block. No DB, no Nest.
 */

/** The published state of a block row, as far as `enabled` is concerned. */
export interface PublishedState {
  value: unknown;
  publishedAt: Date | null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Explicit boolean wins; otherwise inherit from the published value (legacy
 * published without the field => `true`); never published (no row or
 * `publishedAt` NULL) => `false`.
 */
export function resolveDrop212Enabled(
  candidate: unknown,
  published: PublishedState | null | undefined,
): boolean {
  const own = asRecord(candidate).enabled;
  if (typeof own === 'boolean') return own;
  if (published && published.publishedAt != null) {
    const inherited = asRecord(published.value).enabled;
    return typeof inherited === 'boolean' ? inherited : true;
  }
  return false;
}

/** Returns a copy of `value` with `enabled` resolved (always boolean). */
export function withDrop212Enabled(
  value: Record<string, unknown>,
  published: PublishedState | null | undefined,
): Record<string, unknown> {
  return { ...value, enabled: resolveDrop212Enabled(value, published) };
}
