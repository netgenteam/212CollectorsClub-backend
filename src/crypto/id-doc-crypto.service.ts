import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import { inspect } from 'node:util';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ACTIVE_KEY_VAR,
  BLIND_KEY_VAR,
  ENC_KEYS_VAR,
  parseIdDocKeyring,
  type IdDocKeyring,
} from './id-doc-keyring.js';
import {
  normalizeIdDoc,
  type IdDocType,
  type NormalizedIdDoc,
} from './id-doc-normalize.js';
import { serializeIdDoc } from './id-doc-serialize.js';

export const IDDOC_DECRYPT_FAILED = 'IDDOC_DECRYPT_FAILED';

/** Deliberately generic: no reason, no value, no key version. */
export class IdDocDecryptError extends Error {
  readonly code = IDDOC_DECRYPT_FAILED;
  constructor() {
    super(IDDOC_DECRYPT_FAILED);
    this.name = 'IdDocDecryptError';
  }
}

const AAD = Buffer.from('iddoc', 'utf8');
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT = 256;
const ENC_SHAPE =
  /^v(\d{1,4}):([A-Za-z0-9_-]{16}):([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{1,400})$/;

const b64u = (b: Buffer): string => b.toString('base64url');
/** Canonical base64url only: a re-encoded copy must equal the input (no malleable encodings). */
function fromB64u(s: string, len?: number): Buffer | null {
  const b = Buffer.from(s, 'base64url');
  if (b64u(b) !== s || (len !== undefined && b.length !== len)) return null;
  return b;
}

/** What 20.3 stores for one raw value. `blind` is null for unparsed legacy values (no reliable equality). */
export interface PreparedIdDoc {
  enc: string;
  blind: string | null;
  canonical: string;
  type: IdDocType | null;
  unparsed: boolean;
}

const yieldToLoop = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * Story 20.2 (AD-95, FR-123/124): AES-256-GCM encryption of the cedula with a
 * versioned keyring, plus the keyed blind index. Keys live ONLY in process
 * memory (true private fields), loaded from env at startup; `onModuleInit`
 * aborts the boot if the configuration is invalid (also in dev/test).
 *
 * Operational cost: one encrypt/decrypt or HMAC is a few microseconds, but the
 * batch helpers (`protectMany`, `reencryptMany`) yield to the event loop every
 * `yieldEvery` items so a backfill over a whole table (Story 20.3) never
 * starves the HTTP server.
 */
@Injectable()
export class IdDocCryptoService implements OnModuleInit {
  #ring: IdDocKeyring | null = null;

  constructor(private readonly config: Pick<ConfigService, 'get'>) {}

  onModuleInit(): void {
    this.#ring = parseIdDocKeyring({
      encKeys: this.config.get<string>(ENC_KEYS_VAR),
      activeKey: this.config.get<string>(ACTIVE_KEY_VAR),
      blindKey: this.config.get<string>(BLIND_KEY_VAR),
    });
  }

  private ring(): IdDocKeyring {
    if (!this.#ring) this.onModuleInit();
    return this.#ring as IdDocKeyring;
  }

  get activeKeyVersion(): number {
    return this.ring().activeVersion;
  }

  /** Never exposes the keyring (logs, JSON responses, `util.inspect`). */
  toJSON(): Record<string, string> {
    return { service: 'IdDocCryptoService', keyring: '[hidden]' };
  }
  [inspect.custom](): string {
    return 'IdDocCryptoService { keyring: [hidden] }';
  }

  // --- AES-256-GCM -----------------------------------------------------------

  /** Encrypts with the active key (or `version`, used by re-encryption). Output: `v<N>:<iv>:<tag>:<ct>`. */
  encrypt(plain: string, version?: number): string {
    if (
      typeof plain !== 'string' ||
      plain.length === 0 ||
      plain.length > MAX_PLAINTEXT
    ) {
      throw new TypeError(
        'encrypt: plaintext must be a non-empty string (<= 256 chars)',
      );
    }
    const ring = this.ring();
    const v = version ?? ring.activeVersion;
    const key = ring.keys.get(v);
    if (!key) throw new TypeError(`encrypt: unknown key version ${v}`);
    const iv = randomBytes(IV_BYTES); // fresh random 96-bit nonce per value
    const cipher = createCipheriv('aes-256-gcm', key, iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(AAD);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return `v${v}:${b64u(iv)}:${b64u(cipher.getAuthTag())}:${b64u(ct)}`;
  }

  /** Any malformed, unknown-version or altered value throws `IdDocDecryptError`; never returns garbage. */
  decrypt(stored: string): string {
    try {
      const m = typeof stored === 'string' ? ENC_SHAPE.exec(stored) : null;
      if (!m) throw new Error('shape');
      const key = this.ring().keys.get(Number(m[1]));
      const iv = fromB64u(m[2], IV_BYTES);
      const tag = fromB64u(m[3], TAG_BYTES);
      const ct = fromB64u(m[4]);
      if (!key || !iv || !tag || !ct) throw new Error('parts');
      const d = createDecipheriv('aes-256-gcm', key, iv, {
        authTagLength: TAG_BYTES,
      });
      d.setAAD(AAD);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
    } catch {
      throw new IdDocDecryptError();
    }
  }

  /** True if `value` has the shape of an encrypted value (FR-128: tells ciphered from legacy plain). */
  isEncrypted(value: unknown): value is string {
    return typeof value === 'string' && ENC_SHAPE.test(value);
  }

  /** Key version of an encrypted value, or null if it is not one. */
  keyVersionOf(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const m = ENC_SHAPE.exec(value);
    return m ? Number(m[1]) : null;
  }

  /** Decrypts and re-encrypts under `toVersion` (default: active). Same version: returned unchanged. */
  reencrypt(stored: string, toVersion?: number): string {
    const target = toVersion ?? this.ring().activeVersion;
    if (this.keyVersionOf(stored) === target) {
      this.decrypt(stored); // still verifies the tag
      return stored;
    }
    return this.encrypt(this.decrypt(stored), target);
  }

  /** Key versions this process can decrypt with (for preflight checks: never the keys). */
  knownVersions(): number[] {
    return [...this.ring().keys.keys()].sort((a, b) => a - b);
  }

  /**
   * Story 20.3 (backfill `--verify`, scrub, reencrypt): checks ONE stored value without ever
   * returning it, so the scripts never hold a decrypted cedula. Decrypting here keeps every
   * `decrypt(` call inside `src/crypto/` (the static test of AC5).
   *   - `undecryptable`: not a ciphertext, unknown key version or altered (tag).
   *   - `plain_mismatch`: decrypts, but differs from the normalized `expectedPlain`.
   *   - `blind_mismatch`: decrypts, but `blind` is not the index of that value (a null blind
   *     is right only for an unparsed legacy value).
   */
  checkStored(
    stored: string,
    opts: { expectedPlain?: string | null; blind?: string | null } = {},
  ): 'ok' | 'undecryptable' | 'plain_mismatch' | 'blind_mismatch' {
    let canonical: string;
    try {
      canonical = this.decrypt(stored);
    } catch {
      return 'undecryptable';
    }
    if (opts.expectedPlain !== undefined && opts.expectedPlain !== null) {
      const want = normalizeIdDoc(opts.expectedPlain);
      if (!want || want.canonical !== canonical) return 'plain_mismatch';
    }
    if (opts.blind !== undefined) {
      const got = normalizeIdDoc(canonical);
      const expectedBlind =
        got && !got.unparsed ? this.blindIndex(got.type, got.digits) : null;
      if ((opts.blind ?? null) !== expectedBlind) return 'blind_mismatch';
    }
    return 'ok';
  }

  /**
   * Re-encrypts under `toVersion` and proves in memory that the new ciphertext holds exactly the
   * same value as the old one before returning it. Throws `IdDocDecryptError` on any failure.
   */
  reencryptChecked(stored: string, toVersion: number): string {
    const plain = this.decrypt(stored);
    const next = this.encrypt(plain, toVersion);
    if (this.decrypt(next) !== plain) throw new IdDocDecryptError();
    return next;
  }

  // --- Blind index and email hash --------------------------------------------

  /**
   * `HMAC-SHA256(IDDOC_BLIND_KEY, "iddoc:v1:" + type + digits)` in hex. Equality
   * only (A97). A cedula has few possible values (about 40 million per type):
   * the HMAC is only as safe as the blind key, which therefore must stay outside
   * the database and the backups. If it leaks, every blind value can be reversed
   * by brute force in minutes.
   */
  blindIndex(type: IdDocType, digits: string): string {
    return this.hmac(`iddoc:v1:${type}${digits}`);
  }

  /** Blind index of a raw value (normalizes first). Null for blank or unparsed input. */
  blindIndexOf(raw: unknown): string | null {
    const n = normalizeIdDoc(raw);
    return n && !n.unparsed ? this.blindIndex(n.type, n.digits) : null;
  }

  /** Audit-safe email hash (A103). Own domain prefix, same key. */
  hashEmail(email: string): string {
    return this.hmac(`email:v1:${email.trim().toLowerCase()}`);
  }

  private hmac(message: string): string {
    return createHmac('sha256', this.ring().blindKey)
      .update(message)
      .digest('hex');
  }

  // --- Compose / batch -------------------------------------------------------

  /** Normalizes, encrypts the canonical form and computes the blind index. Null for blank input. */
  protect(raw: unknown): PreparedIdDoc | null {
    const n: NormalizedIdDoc | null = normalizeIdDoc(raw);
    if (!n) return null;
    return {
      enc: this.encrypt(n.canonical),
      blind: n.unparsed ? null : this.blindIndex(n.type, n.digits),
      canonical: n.canonical,
      type: n.type,
      unparsed: n.unparsed,
    };
  }

  /** Batch `protect`; yields to the event loop every `yieldEvery` items (default 200). Order preserved. */
  async protectMany(
    raws: ReadonlyArray<unknown>,
    opts: { yieldEvery?: number } = {},
  ): Promise<Array<PreparedIdDoc | null>> {
    return this.inChunks(raws, (r) => this.protect(r), opts.yieldEvery);
  }

  /** Batch `reencrypt` (key rotation, Story 20.3). */
  async reencryptMany(
    stored: ReadonlyArray<string>,
    opts: { toVersion?: number; yieldEvery?: number } = {},
  ): Promise<string[]> {
    return this.inChunks(
      stored,
      (s) => this.reencrypt(s, opts.toVersion),
      opts.yieldEvery,
    );
  }

  private async inChunks<T, R>(
    items: ReadonlyArray<T>,
    fn: (item: T) => R,
    yieldEvery = 200,
  ): Promise<R[]> {
    const step = Math.max(1, Math.floor(yieldEvery));
    const out: R[] = [];
    for (let i = 0; i < items.length; i++) {
      out.push(fn(items[i]));
      if ((i + 1) % step === 0) await yieldToLoop();
    }
    return out;
  }

  /** The single serializer of views (masked), see `serializeIdDoc`. */
  serialize(
    enc: string | null | undefined,
    legacyPlain?: string | null,
  ): string | null {
    return serializeIdDoc(this, enc, legacyPlain);
  }
}
