/**
 * Story 19.4 (AC10): consent helpers for e2e.
 *
 * Under `pnpm test:e2e` the app resolves the four consent documents through
 * the SANDBOX slugs (`LEGAL_CONSENT_SLUG_PREFIX=e2e-` in `vitest.config.e2e.ts`:
 * `e2e-terminos`, `e2e-privacidad`, `e2e-envios`, `e2e-devoluciones`), so an
 * e2e NEVER publishes on a real (immutable) document, and a developer who
 * publishes the real ones does not break the suites.
 *
 * - `registerConsent()`: what `POST /auth/register` needs while no sandbox
 *   consent document is in force (the normal state): only the age declaration.
 * - `seedConsentDocs()`: publishes sandbox versions and returns the exact
 *   bodies to send; `cleanup()` removes everything it created.
 */
import {
  createSandboxDocument,
  insertSandboxVersion,
  purgeSandbox,
} from './legal-sandbox.js';

type Exec = (
  sql: string,
  params?: unknown[],
) => Promise<Record<string, unknown>[]>;

/** Spread into the body of `POST /api/v1/auth/register`. */
export const registerConsent = (): { ageDeclared: true } => ({
  ageDeclared: true,
});

export type ConsentKey = 'terms' | 'privacy' | 'shipping' | 'returns';

const DOCS: Record<ConsentKey, { tag: string; kind: string }> = {
  terms: { tag: 'terminos', kind: 'TERMS' },
  privacy: { tag: 'privacidad', kind: 'PRIVACY' },
  shipping: { tag: 'envios', kind: 'SHIPPING' },
  returns: { tag: 'devoluciones', kind: 'RETURNS' },
};

export interface SeedSpec {
  /**
   * Per document: the versions to insert (number -> options). Default
   * `effectiveFrom` is `-1 day`; a future one uses `'+1 day'`; `isSubstantial`
   * defaults to false.
   */
  [key: string]:
    | {
        versionNumber: number;
        effectiveFrom?: string;
        isSubstantial?: boolean;
        changeSummary?: string;
      }[]
    | undefined;
}

export interface SeededConsent {
  /** Highest version in force per seeded document. */
  current: Partial<Record<ConsentKey, number>>;
  /**
   * Publishes one more sandbox version later in the test (effectiveFrom must
   * not go backwards: the DB enforces it). A version in force updates `current`.
   */
  addVersion: (
    key: ConsentKey,
    v: {
      versionNumber: number;
      effectiveFrom?: string;
      isSubstantial?: boolean;
      changeSummary?: string;
    },
  ) => Promise<void>;
  /** Body fields for register: versions in force + `ageDeclared: true`. */
  registerBody: () => Record<string, unknown>;
  /** Body fields for checkout: the versions in force. */
  checkoutBody: () => Record<string, unknown>;
  cleanup: () => Promise<void>;
}

/** Removes the four consent sandbox documents (and any orphaned evidence on them). */
export async function purgeConsentDocs(exec: Exec): Promise<void> {
  for (const d of Object.values(DOCS)) await purgeSandbox(exec, d.tag);
}

export async function seedConsentDocs(
  exec: Exec,
  spec: SeedSpec,
): Promise<SeededConsent> {
  await purgeConsentDocs(exec);
  const current: Partial<Record<ConsentKey, number>> = {};
  const ids: Partial<Record<ConsentKey, string>> = {};
  for (const key of Object.keys(DOCS) as ConsentKey[]) {
    const versions = spec[key];
    if (!versions) continue;
    const doc = await createSandboxDocument(exec, DOCS[key].tag, {
      kind: DOCS[key].kind,
    });
    ids[key] = doc.id;
    for (const v of versions) {
      await insertSandboxVersion(exec, doc.id, v.versionNumber, {
        effectiveFrom: v.effectiveFrom ?? '-1 day',
        isSubstantial: v.isSubstantial ?? false,
        changeSummary: v.changeSummary,
      });
      if ((v.effectiveFrom ?? '-1 day').startsWith('-')) {
        current[key] = Math.max(current[key] ?? 0, v.versionNumber);
      }
    }
  }
  return {
    current,
    addVersion: async (key, v) => {
      const id = ids[key];
      if (!id) throw new Error(`no sandbox document seeded for ${key}`);
      await insertSandboxVersion(exec, id, v.versionNumber, {
        effectiveFrom: v.effectiveFrom ?? '-1 day',
        isSubstantial: v.isSubstantial ?? false,
        changeSummary: v.changeSummary,
      });
      if ((v.effectiveFrom ?? '-1 day').startsWith('-')) {
        current[key] = Math.max(current[key] ?? 0, v.versionNumber);
      }
    },
    registerBody: () => ({
      ...(current.terms ? { acceptedTermsVersion: current.terms } : {}),
      ...(current.privacy ? { acceptedPrivacyVersion: current.privacy } : {}),
      ageDeclared: true,
    }),
    checkoutBody: () => ({
      ...(current.terms ? { acceptedTermsVersion: current.terms } : {}),
      ...(current.shipping
        ? { acceptedShippingVersion: current.shipping }
        : {}),
      ...(current.returns ? { acceptedReturnsVersion: current.returns } : {}),
    }),
    cleanup: () => purgeConsentDocs(exec),
  };
}
