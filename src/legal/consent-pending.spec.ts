import {
  computePendingConsents,
  type CurrentConsentDocument,
} from './consent-pending.js';

const doc = (
  slug: string,
  versionNumber: number,
  lastSubstantialVersion: number | null,
): CurrentConsentDocument => ({
  slug,
  versionNumber,
  lastSubstantialVersion,
  changeSummary: `v${versionNumber}`,
});
const SCOPE = ['terminos', 'privacidad'];

describe('computePendingConsents (Story 19.4, FR-115, A73)', () => {
  it('no previous acceptance: pending', () => {
    expect(
      computePendingConsents({
        current: [doc('terminos', 1, null), doc('privacidad', 2, 1)],
        lastAccepted: {},
        scope: SCOPE,
      }),
    ).toEqual([
      { slug: 'terminos', version: 1, changeSummary: 'v1' },
      { slug: 'privacidad', version: 2, changeSummary: 'v2' },
    ]);
  });

  it('a NON substantial change after the accepted version is not pending', () => {
    expect(
      computePendingConsents({
        current: [doc('terminos', 3, 1)],
        lastAccepted: { terminos: 1 },
        scope: SCOPE,
      }),
    ).toEqual([]);
  });

  it('an intermediate substantial version makes it pending (reported at the version in force)', () => {
    expect(
      computePendingConsents({
        current: [doc('terminos', 4, 3)],
        lastAccepted: { terminos: 2 },
        scope: SCOPE,
      }),
    ).toEqual([{ slug: 'terminos', version: 4, changeSummary: 'v4' }]);
  });

  it('accepted at (or after) the last substantial version: not pending', () => {
    for (const last of [3, 4]) {
      expect(
        computePendingConsents({
          current: [doc('terminos', 4, 3)],
          lastAccepted: { terminos: last },
          scope: SCOPE,
        }),
      ).toEqual([]);
    }
  });

  it('a future (not yet in force) substantial version never makes it pending', () => {
    // the DB only reports versions in force; even if a caller passed a future one, it is ignored
    expect(
      computePendingConsents({
        current: [doc('terminos', 2, 5)],
        lastAccepted: { terminos: 2 },
        scope: SCOPE,
      }),
    ).toEqual([]);
  });

  it('a document without a version in force is absent, so it is never pending', () => {
    expect(
      computePendingConsents({
        current: [],
        lastAccepted: {},
        scope: SCOPE,
      }),
    ).toEqual([]);
  });

  it('a TERMS acceptance made in an account checkout counts as the last accepted (A73)', () => {
    // The service builds lastAccepted from every ConsentRecord of the customer
    // (any context), so a CHECKOUT row with customerId is just another entry.
    expect(
      computePendingConsents({
        current: [doc('terminos', 5, 5)],
        lastAccepted: { terminos: 5 },
        scope: SCOPE,
      }),
    ).toEqual([]);
  });

  it('only documents in scope are considered (envios/devoluciones are checkout-only)', () => {
    expect(
      computePendingConsents({
        current: [doc('envios', 2, 2), doc('devoluciones', 2, 2)],
        lastAccepted: {},
        scope: SCOPE,
      }),
    ).toEqual([]);
  });
});
