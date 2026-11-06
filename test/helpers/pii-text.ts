/**
 * Helpers for "no cedula in this text" assertions (Story 20.10).
 *
 * A row cast to text (`a::text`) carries random UUIDs (`requestId`, `entityId`, `runId`), and any 8-digit group of a UUID
 * looks like a cedula (`\b\d{7,10}\b`, ~4.6 % of UUIDs). They are removed before looking for cedula-shaped numbers; the
 * cedula detection itself is unchanged.
 */
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const CEDULA_SHAPED = /\b\d{7,10}\b/;

export function stripUuids(text: string): string {
  return text.replace(UUID_RE, '<uuid>');
}

/** True when the text, once the UUIDs are removed, holds a 7-10 digit number (a cedula or RIF shape). */
export function hasCedulaShapedNumber(text: string): boolean {
  return CEDULA_SHAPED.test(stripUuids(text));
}

/** A run tag that always has a letter (the anonymization service rejects reasons with 7+ digit runs). */
export function letteredTag(hex: string): string {
  return `t${hex.slice(0, 7)}`;
}
