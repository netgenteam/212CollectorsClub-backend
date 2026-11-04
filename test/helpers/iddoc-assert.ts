import { expect } from 'vitest';
import { makeTestCrypto } from './iddoc-test-crypto.js';

/** The same keyring the app under test uses (the vitest config puts the throw-away keys in the env). */
export const appCrypto = makeTestCrypto(process.env);

interface Stored {
  recipientIdDoc: string | null;
  recipientIdDocEnc: string | null;
  recipientIdDocBlind: string | null;
}

/** Story 20.3: a NEW row holds the cedula only encrypted: plain NULL, Enc decrypts to `canonical`, Blind is its index. */
export function expectOnlyEncrypted(row: Stored, canonical: string): void {
  expect(row.recipientIdDoc).toBeNull();
  expect(row.recipientIdDocEnc).toMatch(/^v\d+:/);
  expect(
    appCrypto.checkStored(row.recipientIdDocEnc as string, {
      expectedPlain: canonical,
      blind: row.recipientIdDocBlind,
    }),
  ).toBe('ok');
  expect(appCrypto.blindIndexOf(canonical)).toBe(row.recipientIdDocBlind);
}
