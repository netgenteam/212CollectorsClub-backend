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
    expect(server.closeIdleConnections).toHaveBeenCalledTimes(1);
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
});
