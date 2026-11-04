/**
 * Story 20.1 (AD-99, FR-139, NFR-20.5): the `before`/`after` of an audit event
 * hold ONLY strings, safe integers, booleans and null (nested objects/arrays of
 * those are fine). No floats (`jsonb` normalizes numbers, so a float would break
 * the hash round trip: money goes as a string) and no PII in clear (emails,
 * phones, addresses, cedula/RIF, passwords, tokens): emails go as `emailHash`.
 * This guard is a safety net for the helpers of Stories 20.4-20.8; a violation
 * is a programming error (it throws, the audited action fails).
 */
export type AuditScalar = string | number | boolean | null;
export type AuditPayload =
  AuditScalar | AuditPayload[] | { [key: string]: AuditPayload };

export class AuditPayloadError extends Error {
  constructor(path: string, why: string) {
    super(`Invalid audit payload at ${path}: ${why}`);
    this.name = 'AuditPayloadError';
  }
}

/** Key names that hold personal data. Keys ending in `Hash` (e.g. `emailHash`) are salted hashes: allowed. */
const PII_KEY =
  /(e-?mail|phone|tel[eé]fono|c[eé]dula|id_?doc|buyer_?id|recipient_?id|address|direcci[oó]n)/i;
/** Never allowed, not even as a hash. */
const SECRET_KEY = /(passw|secret|token|ciphertext|cookie|authorization)/i;
const EMAIL_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const ID_DOC_VALUE = /^[VEJGP]-?\d{5,10}(-?\d)?$/i;

export function assertAuditPayload(
  value: unknown,
  path = '$',
  depth = 0,
): asserts value is AuditPayload {
  if (depth > 8) throw new AuditPayloadError(path, 'nested too deep');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new AuditPayloadError(
        path,
        'numbers must be safe integers (send money/decimals as strings)',
      );
    }
    return;
  }
  if (typeof value === 'string') {
    if (value.includes('\u0000')) {
      throw new AuditPayloadError(path, 'NUL character');
    }
    if (EMAIL_VALUE.test(value)) {
      throw new AuditPayloadError(path, 'looks like an email address (PII)');
    }
    if (ID_DOC_VALUE.test(value.trim())) {
      throw new AuditPayloadError(path, 'looks like an ID document (PII)');
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAuditPayload(v, `${path}[${i}]`, depth + 1));
    return;
  }
  if (
    typeof value === 'object' &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY.test(k) || (PII_KEY.test(k) && !/Hash$/.test(k))) {
        throw new AuditPayloadError(`${path}.${k}`, 'key names personal data');
      }
      if (v === undefined) {
        throw new AuditPayloadError(`${path}.${k}`, 'undefined (omit the key)');
      }
      assertAuditPayload(v, `${path}.${k}`, depth + 1);
    }
    return;
  }
  throw new AuditPayloadError(
    path,
    `unsupported value (${typeof value}); Date/BigInt/class instances are not allowed`,
  );
}
