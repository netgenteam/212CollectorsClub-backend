import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import { APIError } from 'better-auth/api';
import {
  CUSTOMER_AUTH,
  CUSTOMER_AUTH_IN_TX,
} from '../auth-core/auth-core.constants.js';
import type {
  CustomerAuth,
  CustomerAuthInTx,
} from '../auth-core/customer-auth.factory.js';
import { BackgroundQueue } from '../common/background-queue.js';
import { ApiException } from '../common/api-exception.js';
import { isAnonymizedEmail } from '../common/anonymized-email.js';
import { invalidCustomerTokenException } from '../common/customer-auth.guard.js';
import { isLockWaitExpired } from '../common/lock-timeout.js';
import {
  accountBusyException,
  lockLiveCustomer,
  tryLockLiveCustomer,
  ACCOUNT_LOCK_WAIT_MS,
  withAccountLockWait,
} from '../common/customer-write-lock.js';
import {
  alreadyRegisteredEmail,
  DEFAULT_FRONTEND_URL,
  resetPasswordEmail,
  verificationEmail,
} from '../auth-core/customer-mail.js';
import { MailerService } from '../common/mailer/mailer.service.js';
import type { SendMailOptions } from '../common/mailer/mailer.service.js';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { ConsentService } from '../legal/consent.service.js';
import { ConsentContext } from '../generated/prisma/enums.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CustomerResponseDto } from './dto/customer-response.dto.js';
import type { RegisterCustomerDto } from './dto/register-customer.dto.js';
import type { UpdateCustomerProfileDto } from './dto/update-customer-profile.dto.js';

const PROFILE_SELECT = {
  id: true,
  email: true,
  name: true,
  phone: true,
  emailVerified: true,
} as const;

function invalidCredentialsException(): ApiException {
  return new ApiException(
    HttpStatus.UNAUTHORIZED,
    'INVALID_CUSTOMER_CREDENTIALS',
    'Incorrect email or password.',
  );
}

export const VERIFICATION_PREFIX = 'email-verification:';
const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

function invalidVerificationTokenException(): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'INVALID_VERIFICATION_TOKEN',
    'The verification link is invalid, expired or already used.',
  );
}

function invalidResetTokenException(): ApiException {
  return new ApiException(
    HttpStatus.BAD_REQUEST,
    'INVALID_RESET_TOKEN',
    'The reset link is invalid, expired or already used.',
  );
}

/** Login transactions of ONE account that may wait for a held row at the same time. */
const LOGIN_TX_PER_ACCOUNT = 3;
/** What the logins beyond that wait for a held account row. */
const LOGIN_EXTRA_WAIT_MS = 150;

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex');

/**
 * Story 12.3 (AD-26/AD-28, FR-42): facade over the BetterAuth customer
 * instance. BetterAuth is used through its standard `auth.api.*`; only
 * the error mapping and the anti-enumeration padding are ours.
 */
@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(CUSTOMER_AUTH) private readonly customerAuth: CustomerAuth,
    private readonly mailer: MailerService,
    private readonly config: ConfigService,
    private readonly consent: ConsentService,
    private readonly audit: AuditService,
    @Inject(CUSTOMER_AUTH_IN_TX) private readonly authInTx: CustomerAuthInTx,
  ) {}

  /**
   * Story 20.6a (second round): the token and email jobs that run after the response. Bounded: a few
   * at a time, a short queue, and one job per key (see `BackgroundQueue`).
   */
  private readonly background = new BackgroundQueue(3, 200);
  /** Story 20.6a: login transactions (correct credentials) in flight per account. */
  private readonly loginTxInFlight = new Map<string, number>();

  private get frontendUrl(): string {
    return this.config.get<string>('FRONTEND_URL', DEFAULT_FRONTEND_URL);
  }

  /**
   * Best-effort and NOT awaited: delivery (or its failure) never alters an
   * HTTP response nor its timing (anti-enumeration, AC1).
   */
  private sendBestEffort(mail: SendMailOptions): void {
    this.mailer.sendMail(mail).catch((err: unknown) => {
      this.logger.error(
        `Customer email "${mail.subject}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Anti-enumeration: a new and an already-registered email yield the very
   * same (void) outcome. BetterAuth rejects the duplicate BEFORE hashing, so
   * that branch pays a dummy Argon2id hash to match the cost of the new
   * account branch. No session is ever created (`autoSignIn:false`).
   * The new owner gets a verification email; the existing owner gets an
   * "you already have an account" email (Story 12.4), both best-effort.
   */
  async register(dto: RegisterCustomerDto): Promise<void> {
    // Story 20.6: the DTO already refuses it; this is the same rule for any caller that skips it.
    // It depends on the domain only, never on whether an account exists (no oracle).
    if (isAnonymizedEmail(dto.email)) {
      throw new ApiException(
        HttpStatus.BAD_REQUEST,
        'EMAIL_DOMAIN_NOT_ALLOWED',
        'That email domain cannot be registered.',
      );
    }
    // Constant-time floor: a real signup writes user+account rows that the
    // duplicate branch skips (~10 ms). Padding both to a common minimum hides
    // that residue; the floor sits well above the Argon2id cost.
    const floor = this.config.get<number>('REGISTER_MIN_DURATION_MS', 300);
    const startedAt = performance.now();
    try {
      await this.registerInner(dto);
    } finally {
      const wait = floor - (performance.now() - startedAt);
      if (wait > 0) {
        await new Promise((resolve) => setTimeout(resolve, wait));
      }
    }
  }

  private async registerInner(dto: RegisterCustomerDto): Promise<void> {
    // Story 19.4 (AD-92, FR-112): BEFORE any account is created, and
    // independent of the email, so it opens no enumeration oracle (a duplicate
    // and a new email get the same 400/409). It runs inside the timing floor.
    const accepted = await this.consent.assertAccepted(
      this.prisma,
      {
        terms: dto.acceptedTermsVersion,
        privacy: dto.acceptedPrivacyVersion,
      },
      { declared: dto.ageDeclared },
    );
    let created;
    try {
      created = await this.customerAuth.api.signUpEmail({
        body: { email: dto.email, password: dto.password, name: dto.name },
      });
    } catch (err) {
      if (!(await this.isDuplicateRegistration(err, dto.email))) {
        // BetterAuth's own validation of the address (it depends on the input only, never on
        // whether an account exists): a 400, not a 500.
        if (
          err instanceof APIError &&
          String(err.body?.code ?? '').startsWith('INVALID_EMAIL')
        ) {
          throw new ApiException(
            HttpStatus.BAD_REQUEST,
            'INVALID_EMAIL',
            'That email address is not valid.',
          );
        }
        throw err;
      }
      await argon2.hash(dto.password, { type: argon2.argon2id });
      this.sendBestEffort(alreadyRegisteredEmail(dto.email, this.frontendUrl));
      return;
    }
    // BetterAuth answers a duplicate email with a SYNTHETIC success (a fake
    // user that was never stored) after paying the hash cost. A real new
    // account exists in the DB; the fake one does not.
    const isNew =
      (await this.prisma.customer.count({ where: { id: created.user.id } })) >
      0;
    if (!isNew) {
      this.sendBestEffort(alreadyRegisteredEmail(dto.email, this.frontendUrl));
      return;
    }
    // Story 19.4 (A77): BetterAuth creates the Customer in its own
    // transaction, so the evidence is written right after, in one small tx.
    // If it cannot be written the brand-new account is removed (no account
    // without evidence) and the caller gets a 500; if the process dies in
    // between, the account is simply "pending" for FR-115 (safe degradation).
    // The duplicate-email branches above never write anything.
    try {
      // Story 20.5: the `CONSENT_RECORDED` event commits (or fails) with the evidence rows.
      // An audit failure is handled like any other failure here: the account is removed.
      await this.audit.transaction(async (tx, audit) => {
        // Story 20.6: the same account write lock as every other write of the account.
        await lockLiveCustomer(tx, created.user.id, 'SHARE');
        return this.consent.recordConsents(tx, {
          context: ConsentContext.REGISTER,
          customerId: created.user.id,
          accepted,
          keys: ['terms', 'privacy'],
          age: true,
          audit,
        });
      });
    } catch (err) {
      this.logger.error(
        `Consent evidence for new customer ${created.user.id} could not be written; removing the account: ${err instanceof Error ? err.message : String(err)}`,
      );
      await this.prisma.customer
        .delete({ where: { id: created.user.id } })
        .catch((delErr: unknown) => {
          this.logger.error(
            `Could not remove customer ${created.user.id} after a consent failure: ${delErr instanceof Error ? delErr.message : String(delErr)}`,
          );
        });
      // An audit outage is a clean 503 `AUDIT_UNAVAILABLE` (the account is gone, retry later).
      if (err instanceof ApiException) throw err;
      throw new ApiException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'CONSENT_RECORD_FAILED',
        'The account could not be created. Please try again.',
      );
    }
    // Account committed. Token + email run in the background so this branch
    // awaits exactly what the duplicate branch awaits (no timing oracle) and
    // a failure here never alters the 201 (AC1).
    this.queueVerificationMail(created.user.id, dto.email, dto.name);
  }

  /**
   * The verification token and its email, after the response (best effort, bounded: see
   * `BackgroundQueue`). The transaction of the token holds a connection for statements only and the
   * email is sent after it committed.
   */
  private queueVerificationMail(
    customerId: string,
    email: string,
    name: string,
  ): void {
    const out = this.background.run(null, async () => {
      try {
        const token = await this.issueVerificationToken(customerId);
        if (token !== null) {
          this.sendBestEffort(
            verificationEmail(email, name, this.frontendUrl, token),
          );
        }
      } catch (err) {
        this.logger.error(
          `Verification token failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
    if (out === 'dropped') {
      this.logger.warn(
        'Verification token not issued: the background queue is full (the person can ask again).',
      );
    }
  }

  /**
   * One-time token: only its SHA-256 is stored (a DB leak yields no usable
   * link). Row lives in `Customer_Verifications`; consuming deletes it.
   * Story 12.6: issuing a new one invalidates the customer's previous unused
   * verification tokens (same transaction; an advisory lock serializes
   * concurrent issuers so exactly one live token remains).
   */
  private async issueVerificationToken(
    customerId: string,
  ): Promise<string | null> {
    const token = randomBytes(32).toString('base64url');
    const issued = await this.prisma.$transaction(async (tx) => {
      // Story 20.6: the account's row lock first; an anonymized account never gets a token (the
      // anonymization deleted them all and a new one would outlive it).
      if (!(await tryLockLiveCustomer(tx, customerId, 'SHARE'))) return false;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${'verify:' + customerId}, 0))`;
      await tx.customerVerification.deleteMany({
        where: {
          value: customerId,
          identifier: { startsWith: VERIFICATION_PREFIX },
        },
      });
      await tx.customerVerification.create({
        data: {
          identifier: VERIFICATION_PREFIX + sha256(token),
          value: customerId,
          expiresAt: new Date(Date.now() + VERIFICATION_TTL_MS),
        },
      });
      return true;
    });
    return issued ? token : null;
  }

  /**
   * Story 12.6 (AC11, FR-43). Always resolves the same way. The three
   * branches (unknown / already verified / unverified) await exactly ONE
   * identical lookup; token issuance and mail run in the background for the
   * unverified one only (same equal-cost pattern as 12.4), so neither the
   * response nor its timing reveals which branch ran.
   */
  async resendVerification(email: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        emailVerified: true,
        anonymizedAt: true,
      },
    });
    // Story 20.6: an anonymized account (its placeholder address cannot receive mail) never
    // gets a token; the answer and the cost are those of "unknown email".
    if (!customer || customer.emailVerified || customer.anonymizedAt) {
      return;
    }
    this.queueVerificationMail(customer.id, email, customer.name);
  }

  /** Uniform 400 INVALID_VERIFICATION_TOKEN for unknown/used/expired/tampered. */
  async verifyEmail(token: string): Promise<void> {
    const identifier = VERIFICATION_PREFIX + sha256(token);
    const row = await this.prisma.customerVerification.findFirst({
      where: { identifier },
    });
    if (!row) {
      throw invalidVerificationTokenException();
    }
    // Atomic consume: of two concurrent uses only one deletes the row.
    const consumed = await this.prisma.customerVerification.deleteMany({
      where: { id: row.id },
    });
    if (consumed.count !== 1 || row.expiresAt.getTime() <= Date.now()) {
      throw invalidVerificationTokenException();
    }
    await this.prisma.customer.updateMany({
      // Story 20.6: a verification token that raced the anonymization must not revive the flag.
      where: { id: row.value, anonymizedAt: null },
      data: { emailVerified: true },
    });
  }

  /**
   * Always resolves the same way. Only an existing account triggers the
   * (non-awaited) reset email through BetterAuth's one-time token.
   */
  async forgotPassword(email: string): Promise<void> {
    // Story 20.6: an anonymized account counts as "no account" (one lookup either way).
    const found = await this.prisma.customer.findFirst({
      where: { email, anonymizedAt: null },
      select: { id: true },
    });
    if (!found) {
      return;
    }
    // Background (not awaited): both branches return after the same single
    // lookup, so response time does not reveal whether the account exists.
    const out = this.background.run(`forgot:${found.id}`, () =>
      this.requestReset(found.id, email),
    );
    if (out === 'dropped') {
      this.logger.warn(
        'Password reset not issued: the background queue is full (the person can ask again).',
      );
    }
  }

  /**
   * Story 20.6a (second round): the token is written by BetterAuth INSIDE a short transaction that
   * holds `FOR KEY SHARE` on the account (see `whileAccountLive`): the anonymization (FOR UPDATE)
   * either committed before (then no token is written at all) or waits until the token exists and then
   * deletes it. No token can outlive the anonymization. The EMAIL is not part of that transaction:
   * BetterAuth hands it to `onResetMail` (collected), and it is sent after the commit, so a slow or
   * hung SMTP server holds no database connection, and never sends a mail for a token that was rolled
   * back or belongs to an account that is gone.
   */
  private async requestReset(customerId: string, email: string): Promise<void> {
    const mails: { user: { email: string; name: string }; token: string }[] =
      [];
    try {
      const done = await this.whileAccountLive(customerId, (tx) =>
        this.authInTx(tx, {
          onResetMail: (user, token) => mails.push({ user, token }),
        }).api.requestPasswordReset({ body: { email } }),
      );
      if (!done.live) return;
    } catch (err) {
      const busy = err instanceof ApiException && err.getStatus() === 409;
      this.logger[busy ? 'warn' : 'error'](
        `Password reset request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    // committed: now (and only now) the email
    for (const m of mails) {
      this.sendBestEffort(
        resetPasswordEmail(
          m.user.email,
          m.user.name,
          this.frontendUrl,
          m.token,
        ),
      );
    }
  }

  /**
   * Story 20.6a: runs `fn` (BetterAuth bound to THIS transaction: it writes a credential of the account
   * on the transaction's own connection, no second pooled connection, no I/O outside the database)
   * while this transaction holds `SELECT ... FOR KEY SHARE` on the Customers row. That lock conflicts
   * with the `FOR UPDATE` of the anonymization but not with the `UPDATE` of non-key columns BetterAuth
   * may run on the same row, so there is no self-wait. An anonymized (or gone) account does not run
   * `fn` and answers `{ live: false }`. The wait for the lock is bounded (2.5 s, 409 `ACCOUNT_BUSY`).
   */
  private async whileAccountLive<T>(
    customerId: string,
    fn: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<{ live: true; value: T } | { live: false }> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await withAccountLockWait(
          tx,
          () =>
            tx.$queryRaw<
              { anonymizedAt: Date | null }[]
            >`SELECT "anonymizedAt" FROM "Customers" WHERE "id" = ${customerId}::uuid FOR KEY SHARE`,
        );
        if (!rows[0] || rows[0].anonymizedAt !== null) return { live: false };
        return { live: true, value: await fn(tx) };
      },
      { maxWait: 5_000, timeout: 10_000 },
    );
  }

  /**
   * The customer a reset token belongs to (BetterAuth stores it as a hash of `reset-password:<token>`
   * pointing at the user id; its own adapter does the lookup). `null` for an unknown/expired token or
   * when the lookup fails: the audit then has nobody to name, never a reason to refuse the reset.
   */
  private async resetTokenOwner(
    token: string,
  ): Promise<{ value: string } | null> {
    try {
      const ctx = await this.customerAuth.$context;
      const v = await ctx.internalAdapter.findVerificationValue(
        `reset-password:${token}`,
      );
      return v && v.expiresAt > new Date() ? { value: v.value } : null;
    } catch (err) {
      this.logger.error(`reset token owner lookup failed: ${String(err)}`);
      return null;
    }
  }

  /**
   * BetterAuth deletes the token, hashes (Argon2id) and revokes all sessions.
   *
   * Story 20.5: a reset is account takeover material, so it leaves `CUSTOMER_PASSWORD_RESET`
   * (actor: the customer who used the emailed token, no email, no token). BetterAuth works on its
   * own connection, so the event cannot share its transaction: the owner of the token is read
   * first (`resetTokenOwner`), and the event is written
   * right after the reset succeeded. If the audit write fails the password HAS already changed and
   * its sessions are revoked: answering an error would send the person back for a used token, so
   * the failure is logged as an error (never silent) and the reset answers OK.
   */
  async resetPassword(token: string, password: string): Promise<void> {
    const owner = await this.resetTokenOwner(token);
    try {
      if (!owner) {
        await this.customerAuth.api.resetPassword({
          body: { token, newPassword: password },
        });
        return;
      }
      // The Argon2id hash is computed BEFORE the transaction: it holds its connection for statements only.
      const hashed = await argon2.hash(password, { type: argon2.argon2id });
      const reset = (tx: Prisma.TransactionClient) =>
        this.authInTx(tx, {
          password: { hash: () => Promise.resolve(hashed) },
        }).api.resetPassword({
          body: { token, newPassword: password },
        });
      // Story 20.6a: for an anonymized account the answer is the one of an invalid token, with
      // no effect (no password, no session, no event) and the token is dropped.
      const done = await this.whileAccountLive(owner.value, reset);
      if (!done.live) {
        await this.scrubIfAnonymized(owner.value);
        throw invalidResetTokenException();
      }
    } catch (err) {
      if (err instanceof APIError) {
        throw invalidResetTokenException();
      }
      throw err;
    }
    try {
      await this.audit.transaction((_tx, audit) => {
        audit.add({
          actorType: 'CUSTOMER',
          actorId: owner.value,
          action: 'CUSTOMER_PASSWORD_RESET',
          entityType: 'Customer',
          entityId: owner.value,
          after: {
            customerId: owner.value,
            via: 'EMAIL_TOKEN',
            sessionsRevoked: true,
          },
        });
        return Promise.resolve();
      });
    } catch (err) {
      this.logger.error(
        `CUSTOMER_PASSWORD_RESET for customer ${owner.value} could not be audited (the password HAS changed): ${String(err)}`,
      );
    }
  }

  /**
   * True when `err` means "this email is already registered": BetterAuth's
   * own pre-check, or the loser of a concurrent registration of the same
   * email (BetterAuth reports the unique-index hit as
   * FAILED_TO_CREATE_USER; a raw P2002 is also accepted). The race cases are
   * only trusted if the customer row really exists.
   */
  private async isDuplicateRegistration(
    err: unknown,
    email: string,
  ): Promise<boolean> {
    const code = err instanceof APIError ? String(err.body?.code ?? '') : '';
    if (code.startsWith('USER_ALREADY_EXISTS')) {
      return true;
    }
    // Duck-typed: BetterAuth's adapter throws errors from its own copy of
    // @prisma/client, so `instanceof` against our generated client fails.
    const raw =
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: unknown }).code === 'P2002';
    if (code === 'FAILED_TO_CREATE_USER' || raw) {
      return (await this.prisma.customer.count({ where: { email } })) > 0;
    }
    return false;
  }

  /**
   * Returns the profile and BetterAuth's `Set-Cookie` values (the signed
   * `cc_session`). Unknown email and wrong password are the same 401;
   * BetterAuth itself runs a full password hash for an unknown email, so
   * both branches cost one Argon2id operation.
   */
  async login(
    email: string,
    password: string,
  ): Promise<{ customer: CustomerResponseDto; setCookies: string[] }> {
    // Story 20.6: nobody logs in as a placeholder address of an anonymized account. Same 401 and
    // the same cost (one Argon2id hash) as an unknown email: no oracle.
    if (isAnonymizedEmail(email)) {
      await argon2.hash(password, { type: argon2.argon2id });
      throw invalidCredentialsException();
    }
    // Story 20.6a (second round): BetterAuth's session INSERT needs a share lock on the Customers row
    // (foreign key) and has no `lock_timeout` of its own: an account whose row is held (the
    // anonymization, a long operation) left the login waiting for minutes. So the work is split:
    //   1. the credential check (the Argon2id hash or verify, the same cost for an unknown email, a
    //      wrong password and a good one) runs with NO connection held;
    //   2. BetterAuth's own sign-in runs bound to a short transaction whose lock wait is capped at
    //      2.5 s (`withAccountLockWait`), with the verdict of step 1 and a no-op hash.
    // The only login that reaches a lock wait is one with CORRECT credentials, so a 409 reveals nothing
    // an attacker could not learn from the 200 of the same request, and the unknown-email and
    // wrong-password answers (401, same cost, no lock) never differ with the state of any account.
    const {
      ok: verdict,
      userId,
      hash: checkedHash,
    } = await this.checkCredential(email, password);
    // A held account row makes every login of that account wait the cap holding a pooled connection:
    // the first LOGIN_TX_PER_ACCOUNT of them wait the full 2.5 s, the ones beyond wait only
    // LOGIN_EXTRA_WAIT_MS (with no lock held they all go through, as six simultaneous logins always did).
    // Only requests with correct credentials count (the others never reach a lock).
    const slotKey = verdict && userId !== null ? userId : null;
    let waitMs = ACCOUNT_LOCK_WAIT_MS;
    if (slotKey !== null) {
      const n = this.loginTxInFlight.get(slotKey) ?? 0;
      if (n >= LOGIN_TX_PER_ACCOUNT) waitMs = LOGIN_EXTRA_WAIT_MS;
      this.loginTxInFlight.set(slotKey, n + 1);
    }
    let result;
    try {
      result = await this.prisma.$transaction(
        (tx) =>
          withAccountLockWait(
            tx,
            async () => {
              const signedIn = await this.authInTx(tx, {
                password: {
                  verify: () => Promise.resolve(verdict),
                  hash: () => Promise.resolve('unused'),
                },
              }).api.signInEmail({
                body: { email, password },
                returnHeaders: true,
              });
              // Story 20.6a (round 3): the password was verified OUTSIDE this transaction, and the session
              // was inserted after a lock wait of up to 2.5 s: a password changed in between left a live
              // session opened with the OLD password (200 with the row held 2 s). Re-read the credential
              // now, in this transaction and `FOR SHARE` (a change that has not committed yet waits for us),
              // and refuse if it is not the one that was verified: the transaction rolls back, no session.
              if (verdict && userId !== null) {
                const cur = await tx.$queryRaw<{ password: string | null }[]>`
                  SELECT "password" FROM "Customer_Accounts"
                  WHERE "userId" = ${userId}::uuid AND "providerId" = 'credential'
                  FOR SHARE`;
                if (cur.length === 0 || cur[0].password !== checkedHash) {
                  throw invalidCredentialsException();
                }
              }
              return signedIn;
            },
            waitMs,
          ),
        { maxWait: 3_000, timeout: 8_000 },
      );
    } catch (err) {
      if (err instanceof ApiException) throw err;
      if (isLockWaitExpired(err)) throw accountBusyException();
      if (err instanceof APIError) {
        // BetterAuth wraps a failed session insert; a lock wait that expired inside it is "busy".
        if (verdict && isLockWaitExpired(err.cause ?? err.body)) {
          throw accountBusyException();
        }
        throw invalidCredentialsException();
      }
      throw err;
    } finally {
      if (slotKey !== null) {
        const n = (this.loginTxInFlight.get(slotKey) ?? 1) - 1;
        if (n <= 0) this.loginTxInFlight.delete(slotKey);
        else this.loginTxInFlight.set(slotKey, n);
      }
    }
    const found = await this.prisma.customer.findUnique({
      where: { id: result.response.user.id },
      select: { ...PROFILE_SELECT, anonymizedAt: true },
    });
    if (!found) {
      throw invalidCredentialsException();
    }
    // Story 20.6: a login that read the credential just before the anonymization committed would
    // otherwise end with a live session on an anonymized account (the session insert waits for
    // the `FOR UPDATE` and then succeeds: the row is kept). Revoke what it created, answer the
    // generic 401. (`CustomerAuthGuard` also refuses such a session on its own.)
    if (found.anonymizedAt) {
      await this.scrubIfAnonymized(found.id);
      throw invalidCredentialsException();
    }
    // `anonymizedAt` is internal: the profile keeps its documented shape.
    const customer: CustomerResponseDto = {
      id: found.id,
      email: found.email,
      name: found.name,
      phone: found.phone,
      emailVerified: found.emailVerified,
    };
    return { customer, setCookies: result.headers.getSetCookie() };
  }

  /**
   * The password check BetterAuth's sign-in does, without a connection held while it hashes. One
   * Argon2id operation in every case: a verify for an account with a password, a hash for anything else.
   */
  private async checkCredential(
    email: string,
    password: string,
  ): Promise<{ ok: boolean; userId: string | null; hash: string | null }> {
    // A database error here is a 500, like any other: it must not read as "wrong password".
    const ctx = await this.customerAuth.$context;
    const found = await ctx.internalAdapter.findUserByEmail(email, {
      includeAccounts: true,
    });
    const hash =
      found?.accounts?.find((a) => a.providerId === 'credential')?.password ??
      null;
    const userId = found?.user.id ?? null;
    if (hash === null) {
      await argon2.hash(password, { type: argon2.argon2id });
      return { ok: false, userId, hash };
    }
    try {
      return { ok: await argon2.verify(hash, password), userId, hash };
    } catch {
      return { ok: false, userId, hash };
    }
  }

  /**
   * Story 20.6: deletes the credentials and sessions of `customerId` if (and only if) the account
   * is anonymized. Covers the two races the anonymization transaction cannot see: a login or a
   * reset-password that finished on BetterAuth's own connection after the commit.
   */
  private async scrubIfAnonymized(customerId: string): Promise<void> {
    try {
      await this.prisma
        .$executeRaw`DELETE FROM "Customer_Sessions" WHERE "userId" = ${customerId}::uuid
        AND EXISTS (SELECT 1 FROM "Customers" WHERE "id" = ${customerId}::uuid AND "anonymizedAt" IS NOT NULL)`;
      await this.prisma
        .$executeRaw`DELETE FROM "Customer_Verifications" WHERE "value" = ${customerId}
        AND EXISTS (SELECT 1 FROM "Customers" WHERE "id" = ${customerId}::uuid AND "anonymizedAt" IS NOT NULL)`;
      await this.prisma
        .$executeRaw`DELETE FROM "Customer_Accounts" WHERE "userId" = ${customerId}::uuid
        AND EXISTS (SELECT 1 FROM "Customers" WHERE "id" = ${customerId}::uuid AND "anonymizedAt" IS NOT NULL)`;
    } catch (err) {
      this.logger.error(
        `Could not scrub credentials of anonymized customer ${customerId}: ${String(err)}`,
      );
    }
  }

  async updateProfile(
    customerId: string,
    dto: UpdateCustomerProfileDto,
  ): Promise<CustomerResponseDto> {
    try {
      // Story 20.6: FIRST statement = the Customers row lock; an anonymized account is 401 and
      // keeps its placeholder name and no phone (FOR UPDATE: this transaction updates that row).
      return await this.prisma.$transaction(async (tx) => {
        await lockLiveCustomer(tx, customerId, 'UPDATE');
        return tx.customer.update({
          where: { id: customerId },
          data: {
            ...(dto.name !== undefined ? { name: dto.name } : {}),
            ...(dto.phone !== undefined ? { phone: dto.phone } : {}),
          },
          select: PROFILE_SELECT,
        });
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw invalidCustomerTokenException();
      }
      throw err;
    }
  }

  /** Idempotent: a concurrent logout that already removed the row is fine. */
  async logout(sessionToken: string): Promise<void> {
    await this.prisma.customerSession.deleteMany({
      where: { token: sessionToken },
    });
  }
}
