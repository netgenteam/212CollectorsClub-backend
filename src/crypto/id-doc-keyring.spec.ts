import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { IdDocCryptoService } from './id-doc-crypto.service.js';
import { IdDocConfigError, parseIdDocKeyring } from './id-doc-keyring.js';

const k = (n = 32): string => randomBytes(n).toString('base64');
const ok = () => ({
  encKeys: `1:${k()},2:${k()}`,
  activeKey: '1',
  blindKey: k(),
});

function problems(raw: Parameters<typeof parseIdDocKeyring>[0]): string {
  try {
    parseIdDocKeyring(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(IdDocConfigError);
    return (e as Error).message;
  }
  throw new Error('expected IdDocConfigError');
}

describe('keyring validation: every abort cause (AC2)', () => {
  it('accepts a valid keyring (base64 and base64url, 32 B keys, blind >= 32 B)', () => {
    const r = parseIdDocKeyring({ ...ok(), blindKey: k(64) });
    expect(r.keys.size).toBe(2);
    const url = randomBytes(32).toString('base64url');
    expect(
      parseIdDocKeyring({ encKeys: `7:${url}`, activeKey: '7', blindKey: k() })
        .activeVersion,
    ).toBe(7);
  });

  const cases: Array<
    [
      string,
      (o: ReturnType<typeof ok>) => Parameters<typeof parseIdDocKeyring>[0],
      RegExp,
    ]
  > = [
    [
      'missing keys',
      (o) => ({ ...o, encKeys: undefined }),
      /IDDOC_ENC_KEYS is missing/,
    ],
    [
      'blank keys',
      (o) => ({ ...o, encKeys: '  ' }),
      /IDDOC_ENC_KEYS is missing/,
    ],
    [
      'entry without version',
      (o) => ({ ...o, encKeys: k() }),
      /not <version>:<base64>/,
    ],
    [
      'non integer version',
      (o) => ({ ...o, encKeys: `a:${k()}`, activeKey: '1' }),
      /not <version>:<base64>/,
    ],
    [
      'zero version',
      (o) => ({ ...o, encKeys: `0:${k()}`, activeKey: '0' }),
      /version must be an integer/,
    ],
    [
      'huge version',
      (o) => ({ ...o, encKeys: `99999999:${k()}`, activeKey: '1' }),
      /version must be an integer/,
    ],
    [
      'repeated version',
      (o) => ({ ...o, encKeys: `1:${k()},1:${k()}` }),
      /version 1 is repeated/,
    ],
    [
      'not base64',
      (o) => ({ ...o, encKeys: `1:%%%notbase64%%%` }),
      /key v1 is not valid base64/,
    ],
    [
      '31 bytes',
      (o) => ({ ...o, encKeys: `1:${k(31)}` }),
      /exactly 32 bytes \(got 31\)/,
    ],
    [
      '33 bytes',
      (o) => ({ ...o, encKeys: `1:${k(33)}` }),
      /exactly 32 bytes \(got 33\)/,
    ],
    [
      'placeholder key',
      (o) => ({ ...o, encKeys: `1:${Buffer.alloc(32).toString('base64')}` }),
      /placeholder/,
    ],
    [
      'missing active',
      (o) => ({ ...o, activeKey: undefined }),
      /IDDOC_ENC_ACTIVE_KEY is missing/,
    ],
    [
      'active not integer',
      (o) => ({ ...o, activeKey: 'one' }),
      /must be an integer version/,
    ],
    ['active not in ring', (o) => ({ ...o, activeKey: '3' }), /does not exist/],
    [
      'missing blind',
      (o) => ({ ...o, blindKey: undefined }),
      /IDDOC_BLIND_KEY is missing/,
    ],
    [
      'blind not base64',
      (o) => ({ ...o, blindKey: '***' }),
      /IDDOC_BLIND_KEY is not valid base64/,
    ],
    [
      'blind too short',
      (o) => ({ ...o, blindKey: k(31) }),
      /at least 32 bytes/,
    ],
    [
      'blind placeholder',
      (o) => ({ ...o, blindKey: Buffer.alloc(32, 7).toString('base64') }),
      /placeholder/,
    ],
    [
      'blind equal to an encryption key',
      (o) => {
        const shared = k();
        return {
          ...o,
          encKeys: `1:${shared}`,
          activeKey: '1',
          blindKey: shared,
        };
      },
      /must differ from encryption key v1/,
    ],
    [
      'documented placeholder',
      (o) => ({ ...o, encKeys: '1:<generate: openssl rand -base64 32>' }),
      /not <version>:<base64>|not valid base64/,
    ],
  ];
  for (const [name, mut, re] of cases) {
    it(`aborts: ${name}`, () => {
      expect(problems(mut(ok()))).toMatch(re);
    });
  }

  it('reports all problems at once and never echoes a key value', () => {
    const secret = k(31);
    const msg = problems({
      encKeys: `1:${secret}`,
      activeKey: '9',
      blindKey: secret,
    });
    expect(msg).toContain('exactly 32 bytes');
    expect(msg).toContain('does not exist');
    expect(msg).not.toContain(secret);
  });

  it('onModuleInit aborts (throws) and the service is unusable without valid config', () => {
    const svc = new IdDocCryptoService({ get: () => undefined } as never);
    expect(() => svc.onModuleInit()).toThrow(IdDocConfigError);
    expect(() => svc.encrypt('V-1')).toThrow(IdDocConfigError);
  });

  it('never generates a default key: an empty environment is an error, also in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const svc = new IdDocCryptoService({ get: () => undefined } as never);
      expect(() => svc.onModuleInit()).toThrow(/IDDOC_ENC_KEYS is missing/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
