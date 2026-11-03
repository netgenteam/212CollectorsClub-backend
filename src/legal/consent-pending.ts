/**
 * Story 19.4 (AD-92, FR-115, A73): which documents a customer still has to
 * (re-)accept. PURE: no I/O, no clock. The caller passes only versions that
 * are already in force (`effectiveFrom <= now()` in the database), and this
 * function ignores a "last substantial version" above the current one anyway,
 * so a future (not yet in force) substantial version never makes anything pending.
 */
export interface CurrentConsentDocument {
  slug: string;
  /** Highest version in force. */
  versionNumber: number;
  /** Highest version in force that is `isSubstantial`, if any. */
  lastSubstantialVersion: number | null;
  changeSummary: string;
}

export interface PendingConsent {
  slug: string;
  version: number;
  changeSummary: string;
}

export interface ComputePendingInput {
  /** Documents with a version in force (an unpublished one is simply absent). */
  current: CurrentConsentDocument[];
  /**
   * Highest version of each slug the customer accepted (any context: a TERMS
   * accepted in an account checkout counts, A73). Absent = never accepted.
   */
  lastAccepted: Record<string, number | undefined>;
  /** Only these slugs are considered (TERMS/PRIVACY for the re-accept modal). */
  scope: readonly string[];
}

/**
 * Pending when there is no previous acceptance, or when the last accepted
 * version is older than the last substantial version in force. A non
 * substantial change (accepted v1, current v2 not substantial) is NOT pending.
 */
export function computePendingConsents(
  input: ComputePendingInput,
): PendingConsent[] {
  const inScope = new Set(input.scope);
  const out: PendingConsent[] = [];
  for (const doc of input.current) {
    if (!inScope.has(doc.slug)) continue;
    const last = input.lastAccepted[doc.slug];
    const substantial =
      doc.lastSubstantialVersion !== null &&
      doc.lastSubstantialVersion <= doc.versionNumber
        ? doc.lastSubstantialVersion
        : null;
    const pending =
      last === undefined || (substantial !== null && last < substantial);
    if (pending) {
      out.push({
        slug: doc.slug,
        version: doc.versionNumber,
        changeSummary: doc.changeSummary,
      });
    }
  }
  return out;
}
