import { IdDocCryptoService } from '../../src/crypto/id-doc-crypto.service.js';
import { generateIdDocTestEnv } from './iddoc-test-keys.js';

/**
 * A ready `IdDocCryptoService` over throw-away keys (unit tests and sandboxed e2e). Kept apart
 * from `iddoc-test-keys.ts`, which the vitest configs import and therefore must stay free of
 * application code.
 */
export function makeTestCrypto(
  env: Record<string, string | undefined> = generateIdDocTestEnv({}),
): IdDocCryptoService {
  const svc = new IdDocCryptoService({
    get: (k: string) => env[k],
  } as never);
  svc.onModuleInit();
  return svc;
}
