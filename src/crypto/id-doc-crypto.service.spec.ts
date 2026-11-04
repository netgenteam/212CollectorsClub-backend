import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  IdDocCryptoService,
  IdDocDecryptError,
} from './id-doc-crypto.service.js';

const b64 = (n = 32): string => randomBytes(n).toString('base64');

function make(env: Record<string, string> = {}): {
  svc: IdDocCryptoService;
  env: Record<string, string>;
} {
  const full: Record<string, string> = {
    IDDOC_ENC_KEYS: `1:${b64()},2:${b64()}`,
    IDDOC_ENC_ACTIVE_KEY: '1',
    IDDOC_BLIND_KEY: b64(),
    ...env,
  };
  const svc = new IdDocCryptoService({
    get: (k: string): string | undefined => full[k],
  } as never);
  svc.onModuleInit();
  return { svc, env: full };
}

/** Flips one byte of a base64url part and returns the modified stored value. */
function tamper(stored: string, part: 2 | 3): string {
  const parts = stored.split(':');
  const buf = Buffer.from(parts[part], 'base64url');
  buf[0] ^= 0x01;
  parts[part] = buf.toString('base64url');
  return parts.join(':');
}

describe('IdDocCryptoService AES-256-GCM (AC1)', () => {
  it('round-trips and uses the v<N>:<iv>:<tag>:<ct> format (about 70 chars)', () => {
    const { svc } = make();
    const enc = svc.encrypt('V-12345678');
    expect(enc).toMatch(/^v1:[\w-]{16}:[\w-]{22}:[\w-]+$/);
    expect(enc.length).toBeGreaterThan(55);
    expect(enc.length).toBeLessThan(90);
    expect(svc.decrypt(enc)).toBe('V-12345678');
  });

  it('uses a different IV (so a different value) on every call', () => {
    const { svc } = make();
    const seen = new Set<string>();
    const ivs = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const e = svc.encrypt('V-12345678');
      seen.add(e);
      ivs.add(e.split(':')[1]);
    }
    expect(seen.size).toBe(500);
    expect(ivs.size).toBe(500);
  });

  it('rejects a tampered tag, ciphertext, IV, version, truncation and garbage with IDDOC_DECRYPT_FAILED', () => {
    const { svc } = make();
    const enc = svc.encrypt('V-12345678');
    const bad = [
      tamper(enc, 3),
      (() => {
        const p = enc.split(':');
        const b = Buffer.from(p[3], 'base64url');
        b[b.length - 1] ^= 0x80;
        p[3] = b.toString('base64url');
        return p.join(':');
      })(),
      (() => {
        const p = enc.split(':');
        const b = Buffer.from(p[2], 'base64url');
        b[0] ^= 0x01;
        p[2] = b.toString('base64url');
        return p.join(':');
      })(),
      enc.replace(/^v1/, 'v2'), // another key: tag cannot verify
      enc.replace(/^v1/, 'v99'), // unknown version
      enc.slice(0, -2),
      enc + 'AA',
      '',
      'V-12345678',
      'v1:::',
      undefined as unknown as string,
      null as unknown as string,
    ];
    for (const b of bad) {
      expect(() => svc.decrypt(b), String(b)).toThrow(IdDocDecryptError);
      try {
        svc.decrypt(b);
      } catch (e) {
        expect((e as IdDocDecryptError).code).toBe('IDDOC_DECRYPT_FAILED');
        expect((e as Error).message).toBe('IDDOC_DECRYPT_FAILED');
      }
    }
  });

  it('rejects non-canonical base64url (a different string for the same bytes)', () => {
    const { svc } = make();
    const enc = svc.encrypt('V-12345678');
    const p = enc.split(':');
    // The tag is 16 bytes = 22 chars; the last char carries 4 unused bits.
    const last = p[2][21];
    const alphabet =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const alt = alphabet[(alphabet.indexOf(last) + 1) % 64];
    p[2] = p[2].slice(0, 21) + alt;
    if (
      Buffer.from(p[2], 'base64url').equals(
        Buffer.from(enc.split(':')[2], 'base64url'),
      )
    ) {
      expect(() => svc.decrypt(p.join(':'))).toThrow(IdDocDecryptError);
    }
  });

  it('binds the value to the "iddoc" AAD: the same key with another AAD does not decrypt', async () => {
    const { createCipheriv } = await import('node:crypto');
    const key = randomBytes(32);
    const { svc } = make({ IDDOC_ENC_KEYS: `1:${key.toString('base64')}` });
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from('other'));
    const ct = Buffer.concat([c.update('V-1', 'utf8'), c.final()]);
    const forged = `v1:${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
    expect(() => svc.decrypt(forged)).toThrow(IdDocDecryptError);
  });

  it('refuses to encrypt empty, non-string or oversized input', () => {
    const { svc } = make();
    expect(() => svc.encrypt('')).toThrow(TypeError);
    expect(() => svc.encrypt(5 as unknown as string)).toThrow(TypeError);
    expect(() => svc.encrypt('x'.repeat(300))).toThrow(TypeError);
  });
});

describe('rotation (AC2)', () => {
  it('a v1 value still decrypts after v2 becomes active, and reencrypt moves it to v2', () => {
    const k1 = b64();
    const k2 = b64();
    const blind = b64();
    const { svc: before } = make({
      IDDOC_ENC_KEYS: `1:${k1}`,
      IDDOC_ENC_ACTIVE_KEY: '1',
      IDDOC_BLIND_KEY: blind,
    });
    const old = before.encrypt('V-12345678');
    const { svc: after } = make({
      IDDOC_ENC_KEYS: `1:${k1},2:${k2}`,
      IDDOC_ENC_ACTIVE_KEY: '2',
      IDDOC_BLIND_KEY: blind,
    });
    expect(after.activeKeyVersion).toBe(2);
    expect(after.encrypt('V-1').startsWith('v2:')).toBe(true);
    expect(after.decrypt(old)).toBe('V-12345678');
    const moved = after.reencrypt(old);
    expect(moved.startsWith('v2:')).toBe(true);
    expect(after.decrypt(moved)).toBe('V-12345678');
    expect(after.keyVersionOf(old)).toBe(1);
    expect(after.reencrypt(moved)).toBe(moved);
    // Retiring v1 makes the old value unreadable (the documented consequence).
    const { svc: retired } = make({
      IDDOC_ENC_KEYS: `2:${k2}`,
      IDDOC_ENC_ACTIVE_KEY: '2',
      IDDOC_BLIND_KEY: blind,
    });
    expect(() => retired.decrypt(old)).toThrow(IdDocDecryptError);
    expect(retired.decrypt(moved)).toBe('V-12345678');
  });

  it('the blind index does not change when the encryption key rotates (A97)', () => {
    const blind = b64();
    const { svc: a } = make({
      IDDOC_BLIND_KEY: blind,
      IDDOC_ENC_ACTIVE_KEY: '1',
    });
    const { svc: b } = make({
      IDDOC_BLIND_KEY: blind,
      IDDOC_ENC_ACTIVE_KEY: '2',
    });
    expect(a.blindIndexOf('V-12345678')).toBe(b.blindIndexOf('V-12345678'));
  });
});

describe('keyring never leaks (AC2)', () => {
  it('toJSON, inspect, String and JSON.stringify hide every key', () => {
    const { svc, env } = make();
    const secrets = [
      ...env.IDDOC_ENC_KEYS.split(',').map((e) => e.split(':')[1]),
      env.IDDOC_BLIND_KEY,
    ];
    const dumps = [
      JSON.stringify(svc),
      inspect(svc, { depth: 10, showHidden: true }),
      `${JSON.stringify(svc)}`,
      JSON.stringify({ wrapped: svc }),
    ];
    for (const d of dumps) for (const s of secrets) expect(d).not.toContain(s);
    expect(
      (JSON.parse(JSON.stringify(svc)) as { keyring: string }).keyring,
    ).toBe('[hidden]');
  });
});

describe('blind index and email hash (AC4)', () => {
  it('is stable, 64 hex, sensitive to type and digits, equal across formats', () => {
    const { svc } = make();
    const a = svc.blindIndex('V', '12345678');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(svc.blindIndex('V', '12345678')).toBe(a);
    expect(svc.blindIndex('E', '12345678')).not.toBe(a);
    expect(svc.blindIndex('V', '12345679')).not.toBe(a);
    expect(svc.blindIndexOf('v-12.345.678')).toBe(a);
    expect(svc.blindIndexOf(' V 12345678 ')).toBe(a);
    expect(svc.blindIndexOf('12345678')).toBeNull(); // unparsed: no blind
    expect(svc.blindIndexOf(null)).toBeNull();
  });

  it('depends on the blind key, and not on the encryption keys', () => {
    const { svc: a } = make();
    const { svc: b } = make();
    expect(a.blindIndex('V', '1')).not.toBe(b.blindIndex('V', '1'));
  });

  it('separates the domains: an email hash never equals an ID blind', () => {
    const { svc } = make();
    const email = svc.hashEmail('V12345678');
    expect(email).not.toBe(svc.blindIndex('V', '12345678'));
    expect(svc.hashEmail('  Ana@Example.COM ')).toBe(
      svc.hashEmail('ana@example.com'),
    );
    expect(svc.hashEmail('ana@example.com')).toMatch(/^[0-9a-f]{64}$/);
    expect(svc.hashEmail('ana@example.com')).not.toBe(
      svc.hashEmail('ana2@example.com'),
    );
  });
});

describe('protect / batch / serialize', () => {
  it('protect normalizes, encrypts the canonical form and computes blind', () => {
    const { svc } = make();
    const p = svc.protect('v-12.345.678')!;
    expect(p.canonical).toBe('V-12345678');
    expect(svc.decrypt(p.enc)).toBe('V-12345678');
    expect(p.blind).toBe(svc.blindIndex('V', '12345678'));
    expect(svc.protect('   ')).toBeNull();
    const legacy = svc.protect('sin cedula')!;
    expect(legacy.unparsed).toBe(true);
    expect(legacy.blind).toBeNull();
    expect(svc.decrypt(legacy.enc)).toBe('SIN CEDULA');
  });

  it('protectMany keeps order, handles nulls and yields to the event loop', async () => {
    const { svc } = make();
    const raws = Array.from({ length: 1000 }, (_, i) =>
      i % 10 === 0 ? null : `V${10000000 + i}`,
    );
    let ticks = 0;
    const t = setInterval(() => ticks++, 0);
    const out = await svc.protectMany(raws, { yieldEvery: 50 });
    clearInterval(t);
    expect(out).toHaveLength(1000);
    expect(out[0]).toBeNull();
    expect(out[1]!.canonical).toBe('V-10000001');
    expect(ticks).toBeGreaterThan(0);
    const re = await svc.reencryptMany(
      out.filter(Boolean).map((o) => o!.enc),
      { toVersion: 2 },
    );
    expect(re.every((e) => e.startsWith('v2:'))).toBe(true);
  });

  it('serialize reads enc ?? plain and only ever returns the masked value', () => {
    const { svc } = make();
    const enc = svc.encrypt('V-12345678');
    expect(svc.serialize(enc, null)).toBe('V-****5678');
    expect(svc.serialize(enc, 'E-99999999')).toBe('V-****5678'); // enc wins
    expect(svc.serialize(null, 'v-12.345.678')).toBe('V-****5678');
    expect(svc.serialize(undefined, undefined)).toBeNull();
    expect(svc.serialize('', '')).toBeNull();
    expect(svc.serialize(enc.slice(0, -3) + 'AAA')).toBeNull(); // tampered: no leak, no throw
    expect(svc.serialize(null, enc)).toBe('V-****5678'); // transition: a ciphertext in the plain column
  });

  it('isEncrypted distinguishes ciphertext from legacy plain values', () => {
    const { svc } = make();
    expect(svc.isEncrypted(svc.encrypt('V-1'))).toBe(true);
    for (const v of ['V-12345678', 'v1:abc', '', null, 5])
      expect(svc.isEncrypted(v)).toBe(false);
  });

  describe('helpers for the migration scripts (Story 20.3)', () => {
    it('knownVersions lists the versions, never keys', () => {
      const { svc } = make();
      expect(svc.knownVersions()).toEqual([1, 2]);
    });

    it('checkStored: ok / undecryptable / plain_mismatch / blind_mismatch, never returns a value', () => {
      const { svc } = make();
      const enc = svc.encrypt('V-12345678');
      const blind = svc.blindIndex('V', '12345678');
      expect(svc.checkStored(enc)).toBe('ok');
      expect(
        svc.checkStored(enc, { expectedPlain: ' v-12.345.678 ', blind }),
      ).toBe('ok');
      expect(svc.checkStored(enc, { expectedPlain: 'V-12345679' })).toBe(
        'plain_mismatch',
      );
      expect(
        svc.checkStored(enc, { blind: svc.blindIndex('V', '12345679') }),
      ).toBe('blind_mismatch');
      expect(svc.checkStored(enc, { blind: null })).toBe('blind_mismatch'); // a parsed value must have an index
      expect(svc.checkStored('V-12345678')).toBe('undecryptable');
      expect(
        svc.checkStored(enc.slice(0, -2) + (enc.endsWith('AA') ? 'BB' : 'AA')),
      ).toBe('undecryptable');
      // unparsed legacy: canonical text, no blind (null is the right answer)
      const legacy = svc.protect('12345678')!;
      expect(legacy.unparsed).toBe(true);
      expect(
        svc.checkStored(legacy.enc, { expectedPlain: '12345678', blind: null }),
      ).toBe('ok');
      expect(svc.checkStored(legacy.enc, { blind: 'a'.repeat(64) })).toBe(
        'blind_mismatch',
      );
    });

    it('reencryptChecked moves to the target version keeping the value; fails closed on a bad input', () => {
      const { svc } = make();
      const v1 = svc.encrypt('V-12345678', 1);
      const v2 = svc.reencryptChecked(v1, 2);
      expect(v2.startsWith('v2:')).toBe(true);
      expect(svc.checkStored(v2, { expectedPlain: 'V-12345678' })).toBe('ok');
      expect(() => svc.reencryptChecked('garbage', 2)).toThrow(
        IdDocDecryptError,
      );
      expect(() => svc.reencryptChecked(v1, 9)).toThrow();
    });

    it('the keyring can change between batches: values of both versions are read', () => {
      const { svc: a, env } = make();
      const b = new IdDocCryptoService({
        get: (k: string): string | undefined =>
          ({ ...env, IDDOC_ENC_ACTIVE_KEY: '2' })[k],
      } as never);
      b.onModuleInit();
      const first = a.protect('V-11111111')!.enc; // written under v1
      const second = b.protect('E-22222222')!.enc; // written under v2
      expect([a.keyVersionOf(first), a.keyVersionOf(second)]).toEqual([1, 2]);
      for (const svc of [a, b]) {
        expect(svc.checkStored(first, { expectedPlain: 'V-11111111' })).toBe(
          'ok',
        );
        expect(svc.checkStored(second, { expectedPlain: 'E-22222222' })).toBe(
          'ok',
        );
      }
    });
  });
});
