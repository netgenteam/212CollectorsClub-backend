import { describe, expect, it } from 'vitest';
import { AdminLoginLimiter } from './admin-login-limiter.js';

const make = (env: Record<string, string> = {}) =>
  new AdminLoginLimiter({ get: (k: string) => env[k] } as never);

const code = (fn: () => void): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as { getResponse(): { errorCode: string } }).getResponse()
      .errorCode;
  }
};

describe('AdminLoginLimiter (Story 20.5, R4)', () => {
  it('blocks the (IP, user) pair after 5 failures, not other users from the same IP', () => {
    const l = make();
    for (let i = 0; i < 5; i++) l.recordFailure('1.1.1.1', 'admin', 1000);
    expect(code(() => l.assertAllowed('1.1.1.1', 'admin', 1500))).toBe(
      'ADMIN_LOGIN_RATE_LIMITED',
    );
    expect(code(() => l.assertAllowed('1.1.1.1', 'other', 1500))).toBeNull();
  });

  it('does not lock the real admin out from ANOTHER ip (the pair is per IP)', () => {
    const l = make();
    for (let i = 0; i < 50; i++) l.recordFailure('6.6.6.6', 'admin', 1000);
    expect(code(() => l.assertAllowed('2.2.2.2', 'admin', 1500))).toBeNull();
  });

  it('blocks an IP after 20 failures with any user names', () => {
    const l = make();
    for (let i = 0; i < 20; i++) l.recordFailure('3.3.3.3', `u${i}`, 1000);
    expect(code(() => l.assertAllowed('3.3.3.3', 'brand-new', 1500))).toBe(
      'ADMIN_LOGIN_RATE_LIMITED',
    );
    expect(
      code(() => l.assertAllowed('4.4.4.4', 'brand-new', 1500)),
    ).toBeNull();
  });

  it('the window slides: the block ends when the window does', () => {
    const l = make({ ADMIN_LOGIN_WINDOW_MS: '1000' });
    for (let i = 0; i < 5; i++) l.recordFailure('1.1.1.1', 'admin', 0);
    expect(code(() => l.assertAllowed('1.1.1.1', 'admin', 999))).not.toBeNull();
    expect(code(() => l.assertAllowed('1.1.1.1', 'admin', 1001))).toBeNull();
  });

  it('the answer depends on what was SENT, never on whether the user exists (same for any name)', () => {
    const l = make();
    for (let i = 0; i < 5; i++) {
      l.recordFailure('1.1.1.1', 'exists', 0);
      l.recordFailure('1.1.1.1', 'does-not-exist', 0);
    }
    expect(code(() => l.assertAllowed('1.1.1.1', 'exists', 1))).toBe(
      code(() => l.assertAllowed('1.1.1.1', 'does-not-exist', 1)),
    );
  });

  it('a success clears only the (IP, user) counter; the IP counter keeps counting', () => {
    const l = make();
    for (let i = 0; i < 4; i++) l.recordFailure('1.1.1.1', 'admin', 0);
    l.recordSuccess('1.1.1.1', 'admin');
    l.recordFailure('1.1.1.1', 'admin', 1);
    expect(code(() => l.assertAllowed('1.1.1.1', 'admin', 2))).toBeNull();
  });

  it('limits come from env', () => {
    const l = make({ ADMIN_LOGIN_MAX_FAILURES_PER_USER: '2' });
    l.recordFailure('1.1.1.1', 'a', 0);
    l.recordFailure('1.1.1.1', 'a', 0);
    expect(code(() => l.assertAllowed('1.1.1.1', 'a', 1))).not.toBeNull();
  });

  it('bounds the LOGIN_ADMIN_FAILED writes: per-minute budget and writes in flight (brake 3)', () => {
    const l = make({
      AUDIT_LOGIN_FAILED_MAX_PER_MINUTE: '3',
      AUDIT_LOGIN_FAILED_MAX_IN_FLIGHT: '2',
    });
    const a = l.tryAcquireEventSlot(0);
    const b = l.tryAcquireEventSlot(0);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(l.tryAcquireEventSlot(0)).toBeNull(); // 2 in flight
    expect(l.droppedEvents).toBe(1);
    a?.();
    a?.(); // idempotent release
    const c = l.tryAcquireEventSlot(0);
    expect(c).not.toBeNull(); // 3rd of the minute
    b?.();
    c?.();
    expect(l.tryAcquireEventSlot(1000)).toBeNull(); // budget of the minute spent
    expect(l.tryAcquireEventSlot(61_000)).not.toBeNull(); // new minute
  });

  it('memory is bounded under a flood of distinct keys', () => {
    const l = make();
    for (let i = 0; i < 60_000; i++)
      l.recordFailure(`10.0.${i % 255}.${i}`, `u${i}`, 0);
    const sizes = [
      (l as unknown as { byIp: Map<string, unknown> }).byIp.size,
      (l as unknown as { byPair: Map<string, unknown> }).byPair.size,
    ];
    expect(Math.max(...sizes)).toBeLessThanOrEqual(20_000);
  });
});
