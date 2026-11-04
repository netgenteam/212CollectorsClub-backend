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
