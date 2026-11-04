import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEventInput } from '../audit/audit.service.js';
import { AdminLoginFailureSummary } from './admin-login-failure-summary.js';

const sha = (c: string) => c.repeat(64);

function setup(opts: { fail?: () => boolean } = {}) {
  const events: AuditEventInput[] = [];
  const audit = {
    transaction: vi.fn(
      async (
        fn: (
          tx: never,
          a: { add: (e: AuditEventInput) => void },
        ) => Promise<unknown>,
      ) => {
        if (opts.fail?.()) throw new Error('audit down');
        await fn(undefined as never, { add: (e) => void events.push(e) });
      },
    ),
  };
  const svc = new AdminLoginFailureSummary(
    audit as never,
    {
      get: () => undefined,
    } as never,
  );
  vi.spyOn(
    (svc as unknown as { logger: { error: () => void } }).logger,
    'error',
  ).mockImplementation(() => undefined);
  return { svc, events, audit };
}

describe('AdminLoginFailureSummary (Story 20.5 follow-up)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('one summary per window: counts, window and hashed identifiers, then nothing until a new discard', async () => {
    const { svc, events } = setup();
    svc.noteDropped(sha('a'), '203.0.113.1');
    svc.noteDropped(sha('a'), '203.0.113.2');
    svc.noteDropped(sha('b'), '203.0.113.2');
    expect(events).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: 'SYSTEM',
      action: 'LOGIN_ADMIN_FAILED_SUMMARY',
      entityType: 'AdminLogin',
      after: {
        dropped: 3,
        windowSeconds: 60,
        distinctIdentifiers: 2,
        distinctIps: 2,
        identifiersTruncated: false,
        identifierHashes: [sha('a'), sha('b')],
      },
    });
    // no IP and no typed value anywhere in it
    expect(JSON.stringify(events[0])).not.toContain('203.0.113');

    // quiet minute: no event (the cost of an idle server is zero)
    await vi.advanceTimersByTimeAsync(120_000);
    expect(events).toHaveLength(1);

    // a new discard opens a new window: at most one summary per minute
    svc.noteDropped(sha('c'), null);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(events).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(events).toHaveLength(2);
    expect(events[1].after).toMatchObject({ dropped: 1 });
  });

  it('bounds what it keeps: a flood of distinct identifiers lists at most 20 and flags the truncation', async () => {
    const { svc, events } = setup();
    for (let i = 0; i < 1_200; i++) {
      svc.noteDropped(
        i.toString(16).padStart(64, '0'),
        `10.0.${i >> 8}.${i & 255}`,
      );
    }
    await svc.flush();
    const after = events[0].after as {
      dropped: number;
      distinctIdentifiers: number;
      identifiersTruncated: boolean;
      identifierHashes: string[];
    };
    expect(after.dropped).toBe(1_200);
    expect(after.distinctIdentifiers).toBe(1_000);
    expect(after.identifiersTruncated).toBe(true);
    expect(after.identifierHashes).toHaveLength(20);
  });

  it('flush without pending failures writes nothing; concurrent flushes share one write', async () => {
    const { svc, events, audit } = setup();
    await svc.flush();
    expect(audit.transaction).not.toHaveBeenCalled();
    svc.noteDropped(null, null);
    await Promise.all([svc.flush(), svc.flush(), svc.flush()]);
    expect(events).toHaveLength(1);
  });

  it('an audit outage loses nothing: the counts are put back and written in the next window', async () => {
    let down = true;
    const { svc, events } = setup({ fail: () => down });
    svc.noteDropped(sha('a'), null);
    svc.noteDropped(sha('a'), null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(0);
    expect(svc.pending).toBe(2);
    svc.noteDropped(sha('b'), null);
    down = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toHaveLength(1);
    expect(events[0].after).toMatchObject({
      dropped: 3,
      distinctIdentifiers: 2,
    });
    expect(svc.pending).toBe(0);
  });

  it('closing the app flushes what is pending (once) and leaves no timer behind', async () => {
    const { svc, events } = setup();
    svc.noteDropped(sha('a'), null);
    await svc.onModuleDestroy();
    expect(events).toHaveLength(1);
    expect(events[0].after).toMatchObject({ dropped: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closing the app with the audit log down does not hang and leaves no timer behind', async () => {
    const { svc, events } = setup({ fail: () => true });
    svc.noteDropped(sha('a'), null);
    await svc.onModuleDestroy();
    expect(events).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
