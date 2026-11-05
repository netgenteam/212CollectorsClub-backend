import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installShutdownDeadline } from './shutdown-deadline.js';

describe('installShutdownDeadline (Story 20.7 round 2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.removeAllListeners('SIGTERM');
  });

  it('closes idle connections at once, every connection after the grace, and exits by itself at the deadline', () => {
    const server = {
      close: vi.fn(),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    installShutdownDeadline({ getHttpServer: () => server } as never, {
      graceMs: 1_000,
      deadlineMs: 5_000,
    });
    process.emit('SIGTERM');
    process.emit('SIGTERM'); // a second signal changes nothing
    expect(server.closeIdleConnections).toHaveBeenCalled();
    expect(server.closeAllConnections).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4_000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('does nothing until a signal arrives', () => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    installShutdownDeadline({ getHttpServer: () => ({}) } as never, {
      graceMs: 10,
      deadlineMs: 20,
    });
    vi.advanceTimersByTime(60_000);
    expect(exit).not.toHaveBeenCalled();
  });

  it('shutdown waits for the HTTP server to be empty BEFORE the destroy hooks run (round 3)', async () => {
    let serverDone: () => void = () => undefined;
    const server = {
      close: vi.fn((cb: () => void) => {
        serverDone = cb;
      }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    const order: string[] = [];
    const app = {
      getHttpServer: () => server,
      shutdown: vi.fn(() => {
        order.push('hooks');
        return Promise.resolve();
      }),
    };
    installShutdownDeadline(app as never, {
      graceMs: 1_000,
      deadlineMs: 5_000,
    });
    const p = app.shutdown();
    await vi.advanceTimersByTimeAsync(500);
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(order).toEqual([]); // a request is still in flight
    order.push('last response finished');
    serverDone();
    await p;
    expect(order).toEqual(['last response finished', 'hooks']);
    expect(server.closeAllConnections).not.toHaveBeenCalled();
  });

  it('a request that does not finish is cut after the grace', async () => {
    const server = {
      close: vi.fn(),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    const app = {
      getHttpServer: () => server,
      shutdown: vi.fn(() => Promise.resolve()),
    };
    installShutdownDeadline(app as never, {
      graceMs: 1_000,
      deadlineMs: 5_000,
    });
    const hooks = app.shutdown;
    void app.shutdown();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(server.closeAllConnections).toHaveBeenCalledTimes(1);
    expect(hooks).toBeDefined();
  });
});
