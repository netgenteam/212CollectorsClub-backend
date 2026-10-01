import { CERT_NUMBER_REGEX } from './grading-company.js';

/** Story 11.4 (AD-21): shape returned in `ProductDetailDto.marketReferences`. */
export interface MarketReferenceView {
  provider: string;
  label: string;
  url: string;
  suggestedPriceEur?: number;
}

export interface StoredMarketReference {
  provider: string;
  label: string;
  url: string;
  suggestedPriceEur: { toString(): string } | number | null;
}

export const PSA_CERT_BASE_URL = 'https://www.psacard.com/cert/';

/**
 * Story 11.4 (FR-34, AD-21): pure builder of the detail `marketReferences`.
 * Stored references come first (caller orders them by `sortOrder`), then a
 * calculated PSA cert link when the product is a PSA slab with a valid cert
 * number and no stored `PSA_CERT` already exists. The calculated link is never
 * persisted. Always returns an array (never null).
 */
export function buildMarketReferences(
  product: { gradingCompany: string | null; certNumber: string | null },
  storedRefs: readonly StoredMarketReference[],
): MarketReferenceView[] {
  const refs: MarketReferenceView[] = storedRefs.map((ref) => {
    const view: MarketReferenceView = {
      provider: ref.provider,
      label: ref.label,
      url: ref.url,
    };
    if (ref.suggestedPriceEur !== null && ref.suggestedPriceEur !== undefined) {
      view.suggestedPriceEur = Number(ref.suggestedPriceEur);
    }
    return view;
  });

  if (
    product.gradingCompany === 'PSA' &&
    product.certNumber !== null &&
    CERT_NUMBER_REGEX.test(product.certNumber) &&
    !storedRefs.some((ref) => ref.provider === 'PSA_CERT')
  ) {
    refs.push({
      provider: 'PSA_CERT',
      label: 'PSA Cert Verification',
      url: PSA_CERT_BASE_URL + encodeURIComponent(product.certNumber),
    });
  }
  return refs;
}
