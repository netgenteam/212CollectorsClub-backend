export const TRACKING_PLACEHOLDER = '{trackingNumber}';

/**
 * Story 17.1 (AD-71, FR-82): a tracking URL template is `https://...` and
 * carries exactly one `{trackingNumber}` marker.
 */
export function isValidTrackingTemplate(template: string): boolean {
  if (!template.startsWith('https://')) return false;
  return template.split(TRACKING_PLACEHOLDER).length === 2;
}
