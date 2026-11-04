import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import {
  ACTIVE_KEY_VAR,
  BLIND_KEY_VAR,
  ENC_KEYS_VAR,
  IdDocConfigError,
  parseIdDocKeyring,
} from '../id-doc-keyring.js';

/**
 * Story 20.3: `node dist/crypto/cli/check-keyring.js`, run by `deploy/deploy.sh` BEFORE the
 * migrations and the restart. `grep '^VAR=.+'` accepts a copy of `.env.example` (placeholders),
 * and then the service would die on restart: this applies the SAME validation as the service
 * boot (`parseIdDocKeyring`). With `--env-file <path>` it reads that file (dotenv syntax, nothing
 * is exported or sourced: a copy of `.env.example` has `<...>` placeholders that bash would
 * choke on); without it, the process environment. It prints variable names and versions, never
 * a key value. Exit 0 valid, 1 invalid.
 */
try {
  const i = process.argv.indexOf('--env-file');
  const env: Record<string, string | undefined> =
    i >= 0 && process.argv[i + 1]
      ? parse(readFileSync(process.argv[i + 1], 'utf8'))
      : process.env;
  const ring = parseIdDocKeyring({
    encKeys: env[ENC_KEYS_VAR],
    activeKey: env[ACTIVE_KEY_VAR],
    blindKey: env[BLIND_KEY_VAR],
  });
  console.log(
    `[check-keyring] ID document keyring OK: ${ring.keys.size} key version(s), active v${ring.activeVersion}`,
  );
} catch (err) {
  console.error(
    err instanceof IdDocConfigError
      ? err.message
      : '[check-keyring] unexpected failure while validating the keyring',
  );
  process.exitCode = 1;
}
