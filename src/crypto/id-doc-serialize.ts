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
 * value never leaves this function. If decryption fails (corrupt or tampered
 * data) it logs a value-free error and returns null so the view stays usable.
 */
export function serializeIdDoc(
  crypto: Decryptor,
  enc: string | null | undefined,
  legacyPlain?: string | null,
): string | null {
  const source = enc ? enc : legacyPlain ? legacyPlain : null;
  if (!source) return null;
  if (!crypto.isEncrypted(source)) return maskIdDoc(source);
  try {
    return maskIdDoc(crypto.decrypt(source));
  } catch {
    logger.error('IDDOC_DECRYPT_FAILED while serializing an ID document view');
    return null;
  }
}
