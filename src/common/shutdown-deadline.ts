import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestApplicationContext } from '@nestjs/core';

/** After the signal, connections still open (a request waiting on a database that does not answer) are cut. */
export const SHUTDOWN_GRACE_MS = 5_000;
/** The process exits by itself this long after the signal whatever is still pending. */
export const SHUTDOWN_DEADLINE_MS = 20_000;

/** What this file needs of a socket, a request and a response (a unit test hands in plain stand-ins). */
interface SocketLike {
  once: (event: 'close', cb: () => void) => unknown;
}
interface ReqLike {
  socket?: SocketLike;
  complete?: boolean;
}
interface ResLike {
  setHeader: (k: string, v: string) => void;
  end?: (...args: unknown[]) => unknown;
  once?: (event: 'close', cb: () => void) => unknown;
}

interface ClosableServer {
  prependListener?: (
    event: 'request',
    cb: (req: ReqLike, res: ResLike) => void,
  ) => unknown;
  on?: (event: 'connection', cb: (socket: SocketLike) => void) => unknown;
  close?: (cb?: (err?: Error) => void) => unknown;
  closeAllConnections?: () => void;
  closeIdleConnections?: () => void;
}

/** While draining, connections that went idle after their last response are swept this often. */
const IDLE_SWEEP_MS = 25;
/**
 * Story 20.7 round 4: a connection used less than this long ago is not swept yet. A client that has just
 * read a response on a kept-alive connection is usually writing its next request at that very moment:
 * sweeping it then is the `ECONNRESET` with the POST already sent (150 keep-alive clients: 22 and 36 of
 * them). Once the signal has come every response carries `Connection: close`, so such a client does not
 * reuse the connection; the margin only has to cover the requests already on the wire.
 */
export const IDLE_MARGIN_MS = 250;
/**
 * Story 20.7 round 4: handlers that are still running when the grace ends (their client was cut, or the
 * connections were cut by `closeAllConnections`) get this much longer before the destroy hooks run: the
 * handler's NEXT query would otherwise find the pool closed (the contact form: the row was created, the
 * `emailStatus` update after the e-mail attempt failed with "pool closed"). Bounded: a handler that waits
 * for a database that does not answer does not hold the process beyond `graceMs + this`.
 */
export const HANDLER_EXTRA_MS = 2_000;

/**
 * Story 20.7 round 2/3: closing with a database that does not answer used to take 136 s (measured by QA; with
 * 12 requests stuck on a paused database the process was still alive after 200 s in this story's own
 * reproduction), and (round 3) closing under load cut requests that were healthy. In Nest 12
 * `NestApplicationContext.shutdown` runs, in this order: `onModuleDestroy` of every provider (the usage log
 * flush, Prisma's `$disconnect`), `beforeApplicationShutdown`, and ONLY THEN the HTTP adapter's `close()`
 * (which also destroys every open socket). So on a SIGTERM the pool was closed under requests that were still
 * running (at ~130 checkouts/s: 8 x 503, 1 x 500, 4 cut connections). Now, from the first
 * `SIGTERM`/`SIGINT` (or any `app.close()` once this is installed):
 *
 *   - the HTTP server stops accepting (`server.close()`) and the connections that are idle are closed, again
 *     every 25 ms as the ones that were serving a request finish their response;
 *   - `app.shutdown` WAITS for the server to be empty before it starts the destroy hooks, so the usage log
 *     flush and the pool close run when nothing is in flight any more;
 *   - after `SHUTDOWN_GRACE_MS` (5 s, the same bound as before) every connection still open is cut (a request
 *     waiting on a database that does not answer), the server then closes and the destroy hooks run (each
 *     has its own short bound: the usage log flush 2 s, Prisma's disconnect 3 s);
 *   - after `SHUTDOWN_DEADLINE_MS` (20 s) the process exits with code 1 and says so. A clean close exits
 *     with 0 well before that and the timers (unref'ed) never fire.
 */
export function installShutdownDeadline(
  app: INestApplication,
  opts: { graceMs?: number; deadlineMs?: number } = {},
): void {
  const graceMs = opts.graceMs ?? SHUTDOWN_GRACE_MS;
  const deadlineMs = opts.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  const log = new Logger('Shutdown');
  let drained: Promise<void> | null = null;
  let draining = false;
  const server = app.getHttpServer() as ClosableServer;

  // What is open and what is running, from the first request on (not only after the signal: the requests
  // that are already in flight when it arrives are exactly the ones that matter).
  const sockets = new Set<SocketLike>();
  const lastUse = new Map<SocketLike, number>();
  let inFlight = 0;
  let onQuiet: (() => void) | null = null;
  const quiet = (): boolean => sockets.size === 0 && inFlight === 0;
  const checkQuiet = (): void => {
    if (onQuiet && quiet()) onQuiet();
  };
  server.on?.('connection', (socket) => {
    sockets.add(socket);
    lastUse.set(socket, Date.now());
    // Registered at connect, before the usage log middleware's own listener (first request): when this
    // runs, the rest of the `close` listeners of that socket run in the same synchronous `emit`.
    socket.once('close', () => {
      sockets.delete(socket);
      lastUse.delete(socket);
      checkQuiet();
    });
  });
  server.prependListener?.('request', (req, res) => {
    const socket = req.socket;
    if (socket && sockets.has(socket)) lastUse.set(socket, Date.now());
    // a request that still arrives on a kept-alive connection is answered, and its connection then closes
    // (the client does not send the next one into a socket that is about to be swept)
    if (draining) {
      try {
        res.setHeader('Connection', 'close');
      } catch {
        /* headers already sent */
      }
    }
    // "In flight" = the application has not produced its response yet, whatever the socket did: `res.end` is
    // called by Express for every answer, including the ones that can no longer be delivered (the client was
    // cut while the handler ran). A request whose body never arrived has no handler: its `close` ends it.
    inFlight += 1;
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      if (socket && sockets.has(socket)) lastUse.set(socket, Date.now());
      inFlight -= 1;
      checkQuiet();
    };
    const end = res.end;
    if (typeof end === 'function') {
      res.end = function (this: unknown, ...args: unknown[]): unknown {
        finish();
        return end.apply(this, args);
      };
    }
    res.once?.('close', () => {
      if (req.complete === false) finish();
    });
  });
  const recentlyUsed = (): boolean => {
    const now = Date.now();
    for (const t of lastUse.values()) if (now - t < IDLE_MARGIN_MS) return true;
    return false;
  };
  const begin = (signal: string): Promise<void> => {
    if (drained) return drained;
    draining = true;
    const signalAt = Date.now();
    drained = new Promise<void>((resolve) => {
      const sweep = setInterval(() => {
        if (!recentlyUsed()) server.closeIdleConnections?.();
      }, IDLE_SWEEP_MS);
      sweep.unref();
      const done = (): void => {
        clearInterval(sweep);
        // `server.close()` calls back when the last socket is destroyed, BEFORE that socket emits `close` (the
        // usage log records a cut client there: the row used to be pushed 3 ms after the final flush ran), and
        // while a handler whose client is gone may still be running. Wait for both, bounded.
        if (quiet()) return resolve();
        const finishWaiting = (): void => {
          clearTimeout(stop);
          onQuiet = null;
          resolve();
        };
        onQuiet = finishWaiting;
        const stop = setTimeout(
          () => {
            if (inFlight > 0) {
              log.warn(
                `${inFlight} request(s) still running ${graceMs + HANDLER_EXTRA_MS} ms after ${signal}: closing anyway`,
              );
            }
            finishWaiting();
          },
          Math.max(0, graceMs + HANDLER_EXTRA_MS - (Date.now() - signalAt)),
        );
        stop.unref();
      };
      try {
        // no new connections; the callback fires when the last open one has ended
        server.close?.(() => done());
      } catch {
        done();
        return;
      }
      if (!server.close) done();
      if (!recentlyUsed()) server.closeIdleConnections?.();
    });
    setTimeout(() => {
      log.warn(
        `still closing ${graceMs} ms after ${signal}: cutting the connections that are still open`,
      );
      server.closeAllConnections?.();
    }, graceMs).unref();
    setTimeout(() => {
      log.error(
        `did not finish within ${deadlineMs} ms of ${signal} (a database or a socket that does not answer): exiting now`,
      );
      process.exit(1);
    }, deadlineMs).unref();
    return drained;
  };
  // The drain goes BEFORE the destroy hooks: Nest closes HTTP after them.
  const target = app as unknown as {
    shutdown?: (signal?: string) => Promise<void>;
  };
  // The real method, not `app.shutdown`: Nest hands back the application behind a proxy whose `get` returns a
  // thunk that looks the property up again at call time, which, once overridden, is this very wrapper (an
  // endless recursion that ate 4 GB in 20 s). A plain object (a unit test's stand-in) has its own function.
  const original =
    app instanceof NestApplicationContext
      ? (
          NestApplicationContext.prototype as unknown as {
            shutdown: (signal?: string) => Promise<void>;
          }
        ).shutdown
      : target.shutdown;
  if (original) {
    // `Object.defineProperty`, not an assignment: the application Nest hands back is wrapped in proxies
    // whose `set` trap ignores the value, so `app.shutdown = ...` silently did nothing.
    Object.defineProperty(app, 'shutdown', {
      configurable: true,
      writable: true,
      value: async function (this: unknown, signal?: string): Promise<void> {
        await begin(signal ?? 'close');
        // `this` is the application itself when Nest calls it (a proxy would refuse its `set`s)
        return original.call(this ?? app, signal);
      },
    });
  }
  process.once('SIGTERM', () => void begin('SIGTERM'));
  process.once('SIGINT', () => void begin('SIGINT'));
}
