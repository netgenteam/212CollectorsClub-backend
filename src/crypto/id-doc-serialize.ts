import { Logger } from '@nestjs/common';
import { maskIdDoc } from './id-doc-mask.js';

interface Decryptor {
  isEncrypted(value: unknown): boolean;
  decrypt(stored: string): string;
}

const logger = new Logger('IdDocSerializer');

/**
 * Story 20.2 (AD-95, FR-125): THE serializer for every non-admin view.
 * Reads `Enc ?? plain` (columns are in transition, Story 20.3), decrypts if it
 * is encrypted and returns the MASKED value (`V-****5678`) or null. The full
 * value never leaves this function.
 *
 * `Enc` wins whenever it is set. A set `Enc` that does NOT have the shape of a
 * ciphertext (a bad write, a manual edit) is NEVER treated as a legacy plain
 * value (it would be masked as if it were a cedula) and never falls back to the
 * plain column behind it: it is logged (`IDDOC_ENC_MALFORMED`, no value) and the
 * view gets null. Decryption failures (corrupt/tampered data, key missing) are
 * logged the same way (`IDDOC_DECRYPT_FAILED`) so the view stays usable.
 * Only an absent `Enc` (NULL or empty) falls back to the legacy plain column.
 */
export function serializeIdDoc(
  crypto: Decryptor,
  enc: string | null | undefined,
  legacyPlain?: string | null,
): string | null {
  if (enc) {
    if (!crypto.isEncrypted(enc)) {
      logger.error(
        'IDDOC_ENC_MALFORMED: a stored ID document column is not a ciphertext (value not logged)',
      );
      return null;
    }
    return decryptMasked(crypto, enc);
  }
  if (!legacyPlain) return null;
  // Transition: the plain column may itself hold a ciphertext.
  return crypto.isEncrypted(legacyPlain)
    ? decryptMasked(crypto, legacyPlain)
    : maskIdDoc(legacyPlain);
}

function decryptMasked(crypto: Decryptor, stored: string): string | null {
  try {
    return maskIdDoc(crypto.decrypt(stored));
  } catch {
    logger.error('IDDOC_DECRYPT_FAILED while serializing an ID document view');
    return null;
  }
}
