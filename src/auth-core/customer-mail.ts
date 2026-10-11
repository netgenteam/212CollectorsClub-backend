import type { SendMailOptions } from '../common/mailer/mailer.service.js';

/** Default for local development; every deployed env sets FRONTEND_URL. */
export const DEFAULT_FRONTEND_URL = 'http://localhost:3000';

function link(frontendUrl: string, path: string, token: string): string {
  return `${frontendUrl.replace(/\/+$/, '')}${path}?token=${encodeURIComponent(token)}`;
}

/**
 * Story 12.4 (AD-28): plain functional customer emails. Links point at the
 * storefront (`FRONTEND_URL`), never at this API.
 */
export function verificationEmail(
  to: string,
  name: string,
  frontendUrl: string,
  token: string,
): SendMailOptions {
  const url = link(frontendUrl, '/verify-email', token);
  return {
    to,
    subject: 'Verify your 212CollectorsClub email',
    text: `Hi ${name},\n\nConfirm your email address by opening this link:\n${url}\n\nIf you did not create an account, ignore this message.`,
  };
}

export function resetPasswordEmail(
  to: string,
  name: string,
  frontendUrl: string,
  token: string,
): SendMailOptions {
  const url = link(frontendUrl, '/reset-password', token);
  return {
    to,
    subject: 'Reset your 212CollectorsClub password',
    text: `Hi ${name},\n\nSomeone asked to reset your password. Open this link within 1 hour to choose a new one:\n${url}\n\nIf it was not you, ignore this message; your password is unchanged.`,
  };
}

export function alreadyRegisteredEmail(
  to: string,
  frontendUrl: string,
): SendMailOptions {
  const url = `${frontendUrl.replace(/\/+$/, '')}/login`;
  return {
    to,
    subject: 'You already have a 212CollectorsClub account',
    text: `Someone tried to register this email, but you already have an account.\n\nLog in here: ${url}\nForgot your password? Use the "forgot password" option on the login page.\n\nIf it was not you, ignore this message.`,
  };
}
