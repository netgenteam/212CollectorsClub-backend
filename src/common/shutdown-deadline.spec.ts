import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  HANDLER_EXTRA_MS,
  IDLE_MARGIN_MS,
  installShutdownDeadline,
} from './shutdown-deadline.js';

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

  /** A server stand-in that records the listeners the installer registers and lets a test play requests. */
  function fakeHttp() {
    const reqListeners: ((req: unknown, res: unknown) => void)[] = [];
    const connListeners: ((s: unknown) => void)[] = [];
    let serverDone: () => void = () => undefined;
    const server = {
      prependListener: vi.fn(
        (_e: string, cb: (req: unknown, res: unknown) => void) => {
          reqListeners.push(cb);
        },
      ),
      on: vi.fn((_e: string, cb: (s: unknown) => void) => {
        connListeners.push(cb);
      }),
      close: vi.fn((cb: () => void) => {
        serverDone = cb;
      }),
      closeIdleConnections: vi.fn(),
      closeAllConnections: vi.fn(),
    };
    const connect = () => {
      const socket = new EventEmitter();
      for (const l of connListeners) l(socket);
      return socket;
    };
    const request = (socket: EventEmitter, complete = true) => {
      const res = new EventEmitter() as EventEmitter & {
        setHeader: ReturnType<typeof vi.fn>;
        end: () => void;
      };
      res.setHeader = vi.fn();
      res.end = vi.fn<() => void>();
      const req = { socket, complete };
      for (const l of reqListeners) l(req, res);
      return res;
    };
    return { server, connect, request, closeServer: () => serverDone() };
  }

  it('waits for a handler whose client was cut to produce its response before the destroy hooks run (round 4)', async () => {
    const h = fakeHttp();
    const order: string[] = [];
    const app = {
      getHttpServer: () => h.server,
      shutdown: vi.fn(() => {
        order.push('hooks');
        return Promise.resolve();
      }),
    };
    installShutdownDeadline(app as never, {
      graceMs: 1_000,
      deadlineMs: 20_000,
    });
    const sock = h.connect();
    const res = h.request(sock);
    const p = app.shutdown();
    sock.emit('close'); // the client is gone; the handler is still running
    h.closeServer();
    await vi.advanceTimersByTimeAsync(500);
    expect(order).toEqual([]);
    res.end(); // the handler answers (to nobody)
    await p;
    expect(order).toEqual(['hooks']);
  });

  it('waits for the last socket to emit close (server.close calls back before it does) (round 4)', async () => {
    const h = fakeHttp();
    const order: string[] = [];
    const app = {
      getHttpServer: () => h.server,
      shutdown: vi.fn(() => {
        order.push('hooks');
        return Promise.resolve();
      }),
    };
    installShutdownDeadline(app as never, {
      graceMs: 1_000,
      deadlineMs: 20_000,
    });
    const sock = h.connect();
    const p = app.shutdown();
    h.closeServer(); // Node: the server is "closed", the socket has not emitted `close` yet
    await vi.advanceTimersByTimeAsync(10);
    expect(order).toEqual([]);
    sock.emit('close');
    await p;
    expect(order).toEqual(['hooks']);
  });

  it('a handler that outlives the grace by more than HANDLER_EXTRA_MS does not hold the shutdown (round 4)', async () => {
    const h = fakeHttp();
    const order: string[] = [];
    const app = {
      getHttpServer: () => h.server,
      shutdown: vi.fn(() => {
        order.push('hooks');
        return Promise.resolve();
      }),
    };
    installShutdownDeadline(app as never, {
      graceMs: 1_000,
      deadlineMs: 60_000,
    });
    const sock = h.connect();
    h.request(sock); // never answers
    const p = app.shutdown();
    sock.emit('close');
    h.closeServer();
    await vi.advanceTimersByTimeAsync(1_000 + HANDLER_EXTRA_MS - 10);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(20);
    await p;
    expect(order).toEqual(['hooks']);
  });

  it('a request whose body never arrived has no handler: its close does not hold the shutdown (round 4)', async () => {
    const h = fakeHttp();
    let ran = false;
    const app = {
      getHttpServer: () => h.server,
      shutdown: vi.fn(() => {
        ran = true;
        return Promise.resolve();
      }),
    };
    installShutdownDeadline(app as never, {
      graceMs: 1_000,
      deadlineMs: 60_000,
    });
    const sock = h.connect();
    const res = h.request(sock, false);
    const p = app.shutdown();
    res.emit('close');
    sock.emit('close');
    h.closeServer();
    await p; // resolves without advancing any timer
    expect(ran).toBe(true);
  });

  it('does not sweep a connection used less than IDLE_MARGIN_MS ago, and answers with Connection: close once draining (round 4)', async () => {
    const h = fakeHttp();
    const app = {
      getHttpServer: () => h.server,
      shutdown: vi.fn(() => Promise.resolve()),
    };
    installShutdownDeadline(app as never, {
      graceMs: 5_000,
      deadlineMs: 60_000,
    });
    const sock = h.connect();
    const first = h.request(sock);
    expect(first.setHeader).not.toHaveBeenCalled(); // before the signal nothing changes
    first.end();
    void app.shutdown();
    await vi.advanceTimersByTimeAsync(IDLE_MARGIN_MS - 50);
    expect(h.server.closeIdleConnections).not.toHaveBeenCalled();
    const late = h.request(sock);
    expect(late.setHeader).toHaveBeenCalledWith('Connection', 'close');
    late.end();
    await vi.advanceTimersByTimeAsync(IDLE_MARGIN_MS - 50);
    expect(h.server.closeIdleConnections).not.toHaveBeenCalled(); // the late request renewed the margin
    await vi.advanceTimersByTimeAsync(100);
    expect(h.server.closeIdleConnections).toHaveBeenCalled();
  });
});
