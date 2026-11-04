import { timingSafeEqual } from 'node:crypto';

export const ENC_KEYS_VAR = 'IDDOC_ENC_KEYS';
export const ACTIVE_KEY_VAR = 'IDDOC_ENC_ACTIVE_KEY';
export const BLIND_KEY_VAR = 'IDDOC_BLIND_KEY';

export interface IdDocKeyring {
  keys: Map<number, Buffer>;
  activeVersion: number;
  blindKey: Buffer;
}

/** Thrown at startup. Its message names variables and versions, NEVER a key value. */
export class IdDocConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(
      `Invalid ID document crypto configuration (Story 20.2). The service cannot start safely:\n` +
        problems.map((p) => `  - ${p}`).join('\n') +
        `\nGenerate each key with: openssl rand -base64 32 (see docs/deployment.md, section 14).`,
    );
    this.name = 'IdDocConfigError';
  }
}

const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;
const MAX_VERSION = 9999;

/** Strict base64 / base64url: canonical encoding only, no stray characters. */
function decodeBase64(s: string): Buffer | null {
  if (!B64.test(s)) return null;
  const std = s.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  const buf = Buffer.from(padded, 'base64');
  return buf.toString('base64') === padded ? buf : null;
}

const allSameByte = (b: Buffer): boolean => b.every((x) => x === b[0]);

/**
 * Parses and validates the keyring from env-like values. Collects EVERY
 * problem so the operator fixes them in one pass. Pure (no I/O, no logging).
 */
export function parseIdDocKeyring(raw: {
  encKeys?: string;
  activeKey?: string;
  blindKey?: string;
}): IdDocKeyring {
  const problems: string[] = [];
  const keys = new Map<number, Buffer>();

  const encKeys = (raw.encKeys ?? '').trim();
  if (!encKeys) {
    problems.push(
      `${ENC_KEYS_VAR} is missing (format: 1:<base64-32B>[,2:<base64-32B>])`,
    );
  } else {
    for (const [i, entry] of encKeys.split(',').entries()) {
      const m = /^\s*(\d+)\s*:\s*(\S+)\s*$/.exec(entry);
      if (!m) {
        problems.push(
          `${ENC_KEYS_VAR} entry #${i + 1} is not <version>:<base64>`,
        );
        continue;
      }
      const version = Number(m[1]);
      if (
        !Number.isSafeInteger(version) ||
        version < 1 ||
        version > MAX_VERSION
      ) {
        problems.push(
          `${ENC_KEYS_VAR} entry #${i + 1}: version must be an integer 1..${MAX_VERSION}`,
        );
        continue;
      }
      if (keys.has(version)) {
        problems.push(`${ENC_KEYS_VAR}: version ${version} is repeated`);
        continue;
      }
      const key = decodeBase64(m[2]);
      if (!key) {
        problems.push(`${ENC_KEYS_VAR}: key v${version} is not valid base64`);
      } else if (key.length !== 32) {
        problems.push(
          `${ENC_KEYS_VAR}: key v${version} must decode to exactly 32 bytes (got ${key.length})`,
        );
      } else if (allSameByte(key)) {
        problems.push(
          `${ENC_KEYS_VAR}: key v${version} is a placeholder (all bytes equal)`,
        );
      } else {
        keys.set(version, key);
      }
    }
  }

  const activeRaw = (raw.activeKey ?? '').trim();
  let activeVersion = 0;
  if (!activeRaw) {
    problems.push(`${ACTIVE_KEY_VAR} is missing`);
  } else if (
    !/^\d+$/.test(activeRaw) ||
    !Number.isSafeInteger(Number(activeRaw))
  ) {
    problems.push(`${ACTIVE_KEY_VAR} must be an integer version`);
  } else if (!keys.has(Number(activeRaw))) {
    problems.push(
      `${ACTIVE_KEY_VAR}=${activeRaw} does not exist in ${ENC_KEYS_VAR}`,
    );
  } else {
    activeVersion = Number(activeRaw);
  }

  const blindRaw = (raw.blindKey ?? '').trim();
  let blindKey: Buffer = Buffer.alloc(0);
  if (!blindRaw) {
    problems.push(`${BLIND_KEY_VAR} is missing`);
  } else {
    const b = decodeBase64(blindRaw);
    if (!b) {
      problems.push(`${BLIND_KEY_VAR} is not valid base64`);
    } else if (b.length < 32) {
      problems.push(
        `${BLIND_KEY_VAR} must decode to at least 32 bytes (got ${b.length})`,
      );
    } else if (allSameByte(b)) {
      problems.push(`${BLIND_KEY_VAR} is a placeholder (all bytes equal)`);
    } else {
      blindKey = b;
      for (const [version, k] of keys) {
        if (k.length === b.length && timingSafeEqual(k, b)) {
          problems.push(
            `${BLIND_KEY_VAR} must differ from encryption key v${version}`,
          );
        }
      }
    }
  }

  if (problems.length > 0) throw new IdDocConfigError(problems);
  return { keys, activeVersion, blindKey };
}
