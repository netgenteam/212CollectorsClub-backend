import express from 'express';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TRUST_PROXY,
  TrustProxyConfigError,
  applyTrustProxy,
  checkTrustProxy,
  resolveTrustProxy,
} from './trust-proxy.js';

/** `req.ip` exactly as Express computes it for a peer address and an `X-Forwarded-For`. */
function ipSeenBy(
  trust: string | undefined,
  peer: string,
  xff?: string,
): string | undefined {
  const app = express();
  app.set('trust proxy', resolveTrustProxy(trust));
  const req = Object.create(express.request) as Request;
  Object.assign(req, {
    app,
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
    connection: { remoteAddress: peer },
    socket: { remoteAddress: peer },
  });
  return req.ip;
}

describe('trust proxy (Story 20.5 follow-up): what IP does the backend see?', () => {
  it('resolves the setting', () => {
    expect(resolveTrustProxy(undefined)).toBe(DEFAULT_TRUST_PROXY);
    expect(resolveTrustProxy('  ')).toBe('loopback');
    expect(resolveTrustProxy('1')).toBe(1);
    expect(resolveTrustProxy('false')).toBe(false);
    expect(resolveTrustProxy('loopback, 10.0.0.0/8')).toBe(
      'loopback,10.0.0.0/8',
    );
  });

  describe('default (loopback)', () => {
    it('Nginx -> backend: the address Nginx appended, whatever the client wrote before it', () => {
      expect(ipSeenBy(undefined, '127.0.0.1', '203.0.113.7')).toBe(
        '203.0.113.7',
      );
      expect(ipSeenBy(undefined, '127.0.0.1', '6.6.6.6, 203.0.113.7')).toBe(
        '203.0.113.7',
      );
      expect(
        ipSeenBy(undefined, '127.0.0.1', '1.1.1.1, 6.6.6.6, 203.0.113.7'),
      ).toBe('203.0.113.7');
    });

    it('a client cannot impersonate a loopback / trusted address to hide: it is appended to, not read', () => {
      expect(ipSeenBy(undefined, '127.0.0.1', '127.0.0.1, 203.0.113.7')).toBe(
        '203.0.113.7',
      );
    });

    it('Next -> backend (loopback, ONE address forwarded): that address', () => {
      expect(ipSeenBy(undefined, '127.0.0.1', '203.0.113.7')).toBe(
        '203.0.113.7',
      );
      expect(ipSeenBy(undefined, '::1', '2001:db8::7')).toBe('2001:db8::7');
      expect(ipSeenBy(undefined, '::ffff:127.0.0.1', '203.0.113.7')).toBe(
        '203.0.113.7',
      );
    });

    it('Next through Nginx (BACKEND_API_URL by mistake on the public URL): the loopback hops are skipped and the address Next set wins', () => {
      // Nginx appends the Next server address (loopback on the same host) to the one Next sent.
      expect(ipSeenBy(undefined, '127.0.0.1', '203.0.113.7, 127.0.0.1')).toBe(
        '203.0.113.7',
      );
    });

    it('a peer that is NOT loopback is never believed: its X-Forwarded-For is ignored (hop count 1 would believe it)', () => {
      expect(ipSeenBy(undefined, '198.51.100.9', '203.0.113.7')).toBe(
        '198.51.100.9',
      );
      expect(ipSeenBy('1', '198.51.100.9', '203.0.113.7')).toBe('203.0.113.7');
    });

    it('no X-Forwarded-For (a direct local call): the socket address', () => {
      expect(ipSeenBy(undefined, '127.0.0.1')).toBe('127.0.0.1');
    });
  });

  it('TRUST_PROXY can name another proxy address', () => {
    expect(ipSeenBy('loopback,10.0.0.0/8', '10.1.2.3', '203.0.113.7')).toBe(
      '203.0.113.7',
    );
    expect(ipSeenBy('loopback,10.0.0.0/8', '198.51.100.9', '203.0.113.7')).toBe(
      '198.51.100.9',
    );
  });

  describe('Docker / Dokploy: Next and Nest in different containers (QA blocker)', () => {
    const NEXT = '172.30.212.2';
    it('NEGATIVE, the default: the Next container is not loopback, so its X-Forwarded-For is ignored and every client is the Next container', () => {
      expect(ipSeenBy(undefined, NEXT, '203.0.113.7')).toBe(NEXT);
      expect(ipSeenBy(undefined, NEXT, '198.51.100.20')).toBe(NEXT);
    });
    it('POSITIVE: TRUST_PROXY = the segment of the container network, the single address Next set is believed', () => {
      expect(ipSeenBy('172.30.212.0/28', NEXT, '203.0.113.7')).toBe(
        '203.0.113.7',
      );
      expect(ipSeenBy('172.30.212.0/28', NEXT, '198.51.100.20')).toBe(
        '198.51.100.20',
      );
    });
    it('a client address written to the left of the one Next set is never read', () => {
      expect(ipSeenBy('172.30.212.0/28', NEXT, '6.6.6.6, 203.0.113.7')).toBe(
        '203.0.113.7',
      );
    });
    it('a container OUTSIDE the trusted segment is not believed (a narrow range is the defence)', () => {
      expect(ipSeenBy('172.30.212.0/28', '172.30.99.9', '6.6.6.6')).toBe(
        '172.30.99.9',
      );
    });
    it('RISK of a wide range: any container inside it chooses the IP the backend sees', () => {
      // 172.16.0.0/12 covers every default Docker network on the host: a neighbour container
      // that can reach the backend port can claim to be anyone (and so dodge or aim a rate limit).
      expect(ipSeenBy('172.16.0.0/12', '172.18.0.77', '203.0.113.7')).toBe(
        '203.0.113.7',
      );
    });
  });
});

describe('TRUST_PROXY validation (Story 20.5, QA round 3)', () => {
  const check = (v: string) => checkTrustProxy(resolveTrustProxy(v) as string);
  const fakeApp = () => {
    const calls: unknown[][] = [];
    return {
      app: { set: (...a: unknown[]) => calls.push(a) } as never,
      calls,
    };
  };

  it('a range that covers the public Internet is refused, even when it is split in two halves', () => {
    for (const v of [
      '0.0.0.0/0',
      '0.0.0.0/1,128.0.0.0/1',
      '::/0',
      '8.0.0.0/8',
      '2000::/3',
      'loopback,0.0.0.0/1,128.0.0.0/1',
    ]) {
      const r = check(v);
      expect(r.errors, v).toHaveLength(1);
      expect(r.errors[0], v).toMatch(/TRUST_PROXY/);
      expect(r.errors[0], v).toMatch(/Internet/);
    }
  });
  it('applyTrustProxy throws TrustProxyConfigError for them and never sets the value', () => {
    const { app, calls } = fakeApp();
    expect(() => applyTrustProxy(app, '0.0.0.0/1,128.0.0.0/1')).toThrow(
      TrustProxyConfigError,
    );
    expect(calls).toHaveLength(0);
  });
  it('a small public range (a CDN, a proxy with a public address) is a warning, not an error', () => {
    for (const v of ['203.0.113.5', '203.0.113.0/24', '104.16.0.0/13']) {
      const r = check(v);
      expect(r.errors, v).toEqual([]);
      expect(r.warnings, v).toHaveLength(1);
      expect(r.warnings[0], v).toMatch(/TRUST_PROXY includes public addresses/);
    }
  });
  it('private, loopback, link-local, CGNAT and their keywords are silent', () => {
    for (const v of [
      'loopback',
      'loopback,172.30.212.0/28',
      '10.0.0.0/8',
      '172.16.0.0/12',
      '192.168.0.0/16',
      'linklocal,uniquelocal',
      '100.64.0.0/10',
      'fd00::/8',
      '::ffff:10.0.0.0/104',
      'loopback,10.0.0.0/255.0.0.0',
    ]) {
      expect(check(v), v).toEqual({ errors: [], warnings: [] });
    }
  });
  it('an invalid value stops with a message that NAMES the variable (not Express "invalid IP address")', () => {
    for (const v of [
      'bogus',
      '1.2.3.4/33',
      'loopback,10.0.0.0/x',
      'true',
      '300.1.1.1',
    ]) {
      const { app } = fakeApp();
      let message = '';
      try {
        applyTrustProxy(app, v);
      } catch (e) {
        expect(e).toBeInstanceOf(TrustProxyConfigError);
        message = (e as Error).message;
      }
      expect(message, v).toMatch(/^TRUST_PROXY/);
      expect(message, v).not.toMatch(/^invalid IP address/);
    }
  });
  it('Express itself rejecting the value is wrapped with the name of the variable', () => {
    const app = {
      set: () => {
        throw new TypeError('invalid IP address: x');
      },
    } as never;
    expect(() => applyTrustProxy(app, 'loopback')).toThrow(
      /^TRUST_PROXY=loopback was rejected by Express: invalid IP address/,
    );
  });
  it('the usual values go to Express untouched', () => {
    for (const [raw, value] of [
      [undefined, 'loopback'],
      ['', 'loopback'],
      ['false', false],
      ['2', 2],
      ['loopback, 172.30.212.0/28', 'loopback,172.30.212.0/28'],
    ] as const) {
      const { app, calls } = fakeApp();
      applyTrustProxy(app, raw);
      expect(calls, String(raw)).toEqual([['trust proxy', value]]);
    }
  });
});
