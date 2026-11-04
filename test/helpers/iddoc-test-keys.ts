import { randomBytes } from 'node:crypto';

/**
 * Story 20.2: throw-away ID-document keys for tests, generated at run time
 * (never committed, never a real key). Honours values already present in the
 * environment (CI or a developer who exports their own).
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
