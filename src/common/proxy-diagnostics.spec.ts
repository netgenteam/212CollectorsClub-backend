import { describe, expect, it, vi } from 'vitest';
import {
  createClientIpMonitor,
  isLoopbackOnlyHost,
  isPrivateIp,
  proxyStartupWarning,
  suspicion,
} from './proxy-diagnostics.js';

const req = (ip: string, peer: string, xff?: string) => ({
  ip,
  headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  socket: { remoteAddress: peer },
});

describe('proxyStartupWarning', () => {
  const base = {
    nodeEnv: 'production',
    trustProxy: undefined,
    host: undefined,
  };
  it('warns in production with TRUST_PROXY unset and not bound to loopback', () => {
    expect(proxyStartupWarning(base)).toMatch(/TRUST_PROXY is not set/);
    expect(proxyStartupWarning({ ...base, host: '0.0.0.0' })).not.toBeNull();
    expect(proxyStartupWarning({ ...base, trustProxy: '  ' })).not.toBeNull();
  });
  it('is silent when TRUST_PROXY is set, bound to loopback, or not production', () => {
    expect(
      proxyStartupWarning({ ...base, trustProxy: '172.16.0.0/12' }),
    ).toBeNull();
    expect(proxyStartupWarning({ ...base, host: '127.0.0.1' })).toBeNull();
    expect(proxyStartupWarning({ ...base, host: '::1' })).toBeNull();
    expect(proxyStartupWarning({ ...base, nodeEnv: 'development' })).toBeNull();
  });
  it('never contains an address', () => {
    expect(proxyStartupWarning(base)).not.toMatch(
      /\b(?:10|172|192)\.\d+\.\d+\.\d+/,
    );
    expect(isLoopbackOnlyHost('0.0.0.0')).toBe(false);
  });
});

describe('private address / suspicion detection', () => {
  it('classifies', () => {
    for (const ip of [
      '10.1.2.3',
      '172.18.0.4',
      '192.168.1.9',
      '::ffff:172.17.0.2',
      'fd00::1',
      '100.64.1.1',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of [
      '203.0.113.7',
      '172.32.0.1',
      '127.0.0.1',
      '::1',
      '2001:db8::1',
      'garbage',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
  it('X-Forwarded-For ignored (req.ip is the non-loopback peer) is suspicious; loopback and a believed header are not', () => {
    expect(suspicion(req('203.0.113.9', '203.0.113.9', '1.2.3.4'))).toBe(
      'forwarded-for-ignored',
    );
    expect(suspicion(req('127.0.0.1', '127.0.0.1', '1.2.3.4'))).toBeNull();
    expect(suspicion(req('1.2.3.4', '172.18.0.4', '1.2.3.4'))).toBeNull();
    expect(suspicion(req('172.18.0.4', '172.18.0.4'))).toBe('private-ip');
  });
});

describe('client IP monitor: one warning, no flood, no PII', () => {
  it('warns once after N consecutive suspicious requests, then stays quiet for the cool-down', () => {
    let t = 0;
    const warn = vi.fn();
    const m = createClientIpMonitor({
      threshold: 5,
      cooldownMs: 1000,
      now: () => t,
      warn,
    });
    for (let i = 0; i < 4; i++)
      m.observe(req('172.18.0.4', '172.18.0.4', '8.8.8.8'));
    expect(warn).not.toHaveBeenCalled();
    m.observe(req('172.18.0.4', '172.18.0.4', '8.8.8.8'));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toMatch(/172\.18|8\.8\.8\.8/);
    for (let i = 0; i < 1000; i++)
      m.observe(req('172.18.0.4', '172.18.0.4', '8.8.8.8'));
    expect(warn).toHaveBeenCalledTimes(1);
    t = 5000;
    m.observe(req('172.18.0.4', '172.18.0.4', '8.8.8.8'));
    expect(warn).toHaveBeenCalledTimes(2);
  });
  it('one good request resets the streak', () => {
    const warn = vi.fn();
    const m = createClientIpMonitor({ threshold: 3, warn });
    for (let i = 0; i < 100; i++) {
      m.observe(req('10.0.0.5', '10.0.0.5'));
      m.observe(req('10.0.0.5', '10.0.0.5'));
      m.observe(req('203.0.113.7', '203.0.113.7'));
    }
    expect(warn).not.toHaveBeenCalled();
  });
});
