import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditVerifyCron, MAX_SLICES } from './audit-verify.cron.js';

/** Story 20.1, QA round 2: the cron never reports OK for a chain it did not read to its end. */
const slice = (o: Record<string, unknown>) => ({
  ok: true,
  mode: 'full',
  checkedFrom: 1,
  checkedTo: 10,
  rows: 10,
  done: true,
  partial: false,
  verificationId: 'v',
  headSeq: 10,
  headHash: 'a'.repeat(64),
  ...o,
});

function setup(
  run: (call: number) => Record<string, unknown>,
  env: Record<string, string> = {},
) {
  let calls = 0;
  const verifier = {
    run: vi.fn(() => Promise.resolve(slice(run(calls++)))),
  };
  const sendMail = vi.fn(() => Promise.resolve());
  const reader = {
    anchorEmailConfigured: () => !!env.AUDIT_ANCHOR_EMAIL,
    head: () =>
      Promise.resolve({ seq: 10, hash: 'a'.repeat(64), count: 10, at: null }),
  };
  const cron = new AuditVerifyCron(
    verifier as never,
    reader as never,
    { sendMail } as never,
    new ConfigService(env),
  );
  return { cron, verifier, sendMail };
}

describe('AuditVerifyCron.runScheduled (Story 20.1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads the chain to its end: OK', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { cron } = setup(() => ({}));
    expect(await cron.runScheduled()).toMatchObject({
      status: 'OK',
      slices: 1,
    });
  });

  it('hits the cap of slices with the chain not finished: INCOMPLETE (never OK), logged as an error, and the anchor mail says so', async () => {
    const err = vi
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const { cron, verifier, sendMail } = setup(
      (n) => ({
        checkedFrom: n === 0 ? 1 : n * 200_000 + 1,
        checkedTo: (n + 1) * 200_000,
        rows: 200_000,
        done: false,
        partial: true,
        nextFromSeq: (n + 1) * 200_000 + 1,
      }),
      { AUDIT_ANCHOR_EMAIL: 'anchor@example.com' },
    );
    const r = await cron.runScheduled();
    expect(verifier.run).toHaveBeenCalledTimes(MAX_SLICES);
    expect(r).toMatchObject({
      status: 'INCOMPLETE',
      slices: MAX_SLICES,
      rows: MAX_SLICES * 200_000,
      anchorEmailSent: true,
    });
    expect(err).toHaveBeenCalledWith(
      expect.stringContaining('VERIFICATION INCOMPLETE'),
    );
    const mail = sendMail.mock.calls[0] as unknown as [
      { subject: string; text: string },
    ];
    expect(mail[0].subject).toContain('VERIFICATION INCOMPLETE');
    expect(mail[0].text).toContain('INCOMPLETE');
    expect(mail[0].text).not.toContain('last verification: OK');
  });

  it('a BROKEN slice stops the run as BROKEN', async () => {
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    const { cron, verifier } = setup((n) =>
      n === 1
        ? {
            ok: false,
            done: false,
            brokenAt: { seq: 5, reason: 'HASH_MISMATCH' },
          }
        : { done: false, nextFromSeq: 11 },
    );
    const r = await cron.runScheduled();
    expect(r).toMatchObject({ status: 'BROKEN', brokenSeq: 5, slices: 2 });
    expect(verifier.run).toHaveBeenCalledTimes(2);
  });
});

describe('AuditVerifyCron boot warning (AUDIT_ANCHOR_EMAIL)', () => {
  const saved = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = saved;
    vi.restoreAllMocks();
  });

  it('warns once at boot in production without AUDIT_ANCHOR_EMAIL; silent in dev or when it is set', () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    process.env.NODE_ENV = 'production';
    setup(() => ({})).cron.onApplicationBootstrap();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('AUDIT_ANCHOR_EMAIL');
    setup(() => ({}), {
      AUDIT_ANCHOR_EMAIL: 'a@b.co',
    }).cron.onApplicationBootstrap();
    process.env.NODE_ENV = 'development';
    setup(() => ({})).cron.onApplicationBootstrap();
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
