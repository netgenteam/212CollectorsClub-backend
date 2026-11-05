import { describe, expect, it, vi } from 'vitest';
import {
  AdminReadTrailService,
  READ_TRAIL_WINDOW_MS,
} from './admin-read-trail.service.js';

const ADMIN = '44444444-4444-4444-8444-444444444444';

function make(fail = false) {
  const events: Record<string, unknown>[] = [];
  const audit = {
    transaction: vi.fn(
      async (
        fn: (
          tx: never,
          a: { add: (e: Record<string, unknown>) => void },
        ) => Promise<void>,
      ) => {
        if (fail) throw new Error('chain down');
        await fn(undefined as never, { add: (e) => void events.push(e) });
      },
    ),
  };
  return { svc: new AdminReadTrailService(audit as never), events, audit };
}

describe('AdminReadTrailService (Story 20.7 round 2)', () => {
  it('one event per admin and action per window, carrying no filter and no data', async () => {
    vi.useFakeTimers();
    const { svc, events } = make();
    for (let i = 0; i < 20; i++) {
      await svc.note(ADMIN, 'USAGE_LOG_QUERIED', { strict: true });
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      actorType: 'ADMIN',
      actorId: ADMIN,
      action: 'USAGE_LOG_QUERIED',
      entityType: 'UsageLog',
      entityId: 'usage-log',
      after: { windowMinutes: 15 },
    });
    await svc.note(ADMIN, 'AUDIT_EVENTS_QUERIED', { strict: false });
    await svc.note(
      '55555555-5555-4555-8555-555555555555',
      'USAGE_LOG_QUERIED',
      { strict: true },
    );
    expect(events).toHaveLength(3);
    vi.advanceTimersByTime(READ_TRAIL_WINDOW_MS + 1);
    await svc.note(ADMIN, 'USAGE_LOG_QUERIED', { strict: true });
    expect(events).toHaveLength(4);
    vi.useRealTimers();
  });

  it('parallel first queries write ONE event', async () => {
    const { svc, events } = make();
    await Promise.all(
      Array.from({ length: 10 }, () =>
        svc.note(ADMIN, 'USAGE_LOG_QUERIED', { strict: true }),
      ),
    );
    expect(events).toHaveLength(1);
  });

  it('strict: a chain that cannot take the event refuses the read, and the next query tries again', async () => {
    const { svc, audit } = make(true);
    await expect(
      svc.note(ADMIN, 'USAGE_LOG_QUERIED', { strict: true }),
    ).rejects.toThrow('chain down');
    await expect(
      svc.note(ADMIN, 'USAGE_LOG_QUERIED', { strict: true }),
    ).rejects.toThrow('chain down');
    expect(audit.transaction).toHaveBeenCalledTimes(2);
  });

  it('not strict: the failure is logged as an error and the view still answers', async () => {
    const { svc } = make(true);
    const err = vi
      .spyOn(
        (svc as unknown as { logger: { error: () => void } }).logger,
        'error',
      )
      .mockImplementation(() => undefined);
    await expect(
      svc.note(ADMIN, 'AUDIT_EVENTS_QUERIED', { strict: false }),
    ).resolves.toBeUndefined();
    expect(err).toHaveBeenCalledTimes(1);
  });

  it('round 3: concurrent reads while the chain refuses writes ALL fail with the same error, and the window stays open', async () => {
    const { svc, audit } = make(true);
    const out = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        svc.note(ADMIN, 'USAGE_LOG_QUERIED', { strict: true }),
      ),
    );
    expect(out.map((o) => o.status)).toEqual(Array(6).fill('rejected'));
    expect(audit.transaction).toHaveBeenCalledTimes(1);
    // a failure leaves nothing marked: the next read tries again
    await expect(
      svc.note(ADMIN, 'USAGE_LOG_QUERIED', { strict: true }),
    ).rejects.toThrow('chain down');
    expect(audit.transaction).toHaveBeenCalledTimes(2);
  });

  it('round 3: a concurrent read waits for the write to COMMIT before it answers', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const audit = { transaction: vi.fn(() => gate) };
    const svc = new AdminReadTrailService(audit as never);
    let second = false;
    const first = svc.note(ADMIN, 'USAGE_LOG_QUERIED', { strict: true });
    const other = svc
      .note(ADMIN, 'USAGE_LOG_QUERIED', { strict: true })
      .then(() => (second = true));
    await new Promise((r) => setTimeout(r, 20));
    expect(second).toBe(false);
    release();
    await Promise.all([first, other]);
    expect(second).toBe(true);
    expect(audit.transaction).toHaveBeenCalledTimes(1);
  });
});
