import express from 'express';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TRUST_PROXY, resolveTrustProxy } from './trust-proxy.js';

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
});
