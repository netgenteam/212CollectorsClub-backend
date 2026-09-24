import { AdminAuthGuard } from './admin-auth.guard.js';

const ADMIN_USER = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  email: 'admin@212collectorsclub.test',
  roleTier: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

function catchThrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected function to throw, but it did not.');
}

/**
 * Story 7.1. `AdminAuthGuard.handleRequest` is the one bit of custom logic
 * this guard adds on top of `passport-jwt`'s own signature/expiry
 * verification (which is exercised end-to-end by the e2e suite instead,
 * against a real signed JWT) — proves every rejection shape Passport can
 * hand it (an `err`, a falsy `user`, or both) collapses to the same 401
 * `ApiException`, and that a genuinely authenticated user passes through
 * untouched.
 */
describe('AdminAuthGuard', () => {
  let guard: AdminAuthGuard;

  beforeEach(() => {
    guard = new AdminAuthGuard();
  });

  it('returns the AdminUser unchanged when Passport authenticated one, with no error', () => {
    expect(guard.handleRequest(null, ADMIN_USER)).toBe(ADMIN_USER);
  });

  it('throws a 401 INVALID_ADMIN_TOKEN when Passport reports no user (e.g. missing/invalid/expired token)', () => {
    const thrown = catchThrown(() => guard.handleRequest(null, false));
    expect(thrown).toMatchObject({
      status: 401,
      response: { errorCode: 'INVALID_ADMIN_TOKEN' },
    });
  });

  it('throws the same 401 INVALID_ADMIN_TOKEN when Passport reports an error (e.g. a malformed/tampered JWT)', () => {
    const thrown = catchThrown(() =>
      guard.handleRequest(new Error('jwt malformed'), false),
    );
    expect(thrown).toMatchObject({
      status: 401,
      response: { errorCode: 'INVALID_ADMIN_TOKEN' },
    });
  });
});
