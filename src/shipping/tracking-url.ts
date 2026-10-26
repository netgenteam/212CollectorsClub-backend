export const TRACKING_PLACEHOLDER = '{trackingNumber}';

/**
 * Story 17.1 (AD-71, FR-82): a tracking URL template is `https://...` and
 * carries exactly one `{trackingNumber}` marker.
 */
export function isValidTrackingTemplate(template: string): boolean {
  if (!template.startsWith('https://')) return false;
  return template.split(TRACKING_PLACEHOLDER).length === 2;
}

/**
 * Story 17.5 (AD-75, FR-89): agency template with the marker replaced by the
 * URL-encoded tracking number; null when any of the three is missing.
 */
export function buildTrackingUrl(
  template: string | null | undefined,
  trackingNumber: string | null | undefined,
): string | null {
  if (!template || !trackingNumber) return null;
  return template.replaceAll(
    TRACKING_PLACEHOLDER,
    encodeURIComponent(trackingNumber),
  );
}
