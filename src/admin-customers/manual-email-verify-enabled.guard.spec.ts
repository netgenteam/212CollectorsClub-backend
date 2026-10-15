import { NotFoundException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ManualEmailVerifyEnabledGuard } from './manual-email-verify-enabled.guard.js';

const guardWith = (value: string | undefined) =>
  new ManualEmailVerifyEnabledGuard({
    get: () => value,
  } as unknown as ConfigService);

const ctx = {
  switchToHttp: () => ({
    getRequest: () => ({ method: 'POST', originalUrl: '/api/v1/x' }),
  }),
} as unknown as ExecutionContext;

describe('ManualEmailVerifyEnabledGuard (Story 13.1, AC1)', () => {
  it.each([undefined, '', 'false', 'TRUE', '1', 'yes', ' true'])(
    'throws the standard 404 when the flag is %j',
    (v) => {
      expect(() => guardWith(v).canActivate(ctx)).toThrow(NotFoundException);
    },
  );

  it('allows the request only when the flag is exactly "true"', () => {
    expect(guardWith('true').canActivate(ctx)).toBe(true);
  });
});
