import { randomBytes } from 'node:crypto';

/**
 * Story 20.2: throw-away ID-document keys for tests, generated at run time
 * (never committed, never a real key). Called with the default `base`
 * (process.env) it honours values already present there; the vitest configs call it
 * with `{}` (Story 20.10) so an exported `IDDOC_ENC_KEYS` (a real or a one-key ring)
 * can never replace the run's own keys and break the rotation/boot tests.
 */
export function generateIdDocTestEnv(
  base: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const b64 = (): string => randomBytes(32).toString('base64');
  return {
    IDDOC_ENC_KEYS: base.IDDOC_ENC_KEYS ?? `1:${b64()},2:${b64()}`,
    IDDOC_ENC_ACTIVE_KEY: base.IDDOC_ENC_ACTIVE_KEY ?? '1',
    IDDOC_BLIND_KEY: base.IDDOC_BLIND_KEY ?? b64(),
  };
}
