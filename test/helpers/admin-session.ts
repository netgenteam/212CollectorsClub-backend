import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { AdminAuth } from './../../src/auth-core/admin-auth.factory.js';
import { ADMIN_AUTH } from './../../src/auth-core/auth-core.constants.js';

/**
 * Story 20.5: signs an admin session exactly like `AdminAuthService.login` does, WITHOUT going
 * through `POST /admin/auth/login`. The login now writes `LOGIN_ADMIN_OK` to the audit chain, so a
 * suite whose subject is an EMPTY / hand-built chain (the sandbox audit suites) must get its
 * token this way to leave the chain untouched.
 */
export async function mintAdminToken(
  app: INestApplication,
  adminId: string,
): Promise<string> {
  const adminAuth = app.get<AdminAuth>(ADMIN_AUTH);
  const ctx = await adminAuth.$context;
  const session = await ctx.internalAdapter.createSession(adminId);
  const signature = createHmac('sha256', ctx.secret)
    .update(session.token)
    .digest('base64');
  return `${session.token}.${signature}`;
}
