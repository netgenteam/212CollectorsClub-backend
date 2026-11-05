import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestApplicationContext } from '@nestjs/core';

/** After the signal, connections still open (a request waiting on a database that does not answer) are cut. */
export const SHUTDOWN_GRACE_MS = 5_000;
/** The process exits by itself this long after the signal whatever is still pending. */
export const SHUTDOWN_DEADLINE_MS = 20_000;

interface ClosableServer {
  prependListener?: (
    event: 'request',
    cb: (
      req: unknown,
      res: { setHeader: (k: string, v: string) => void },
    ) => void,
  ) => unknown;
  close?: (cb?: (err?: Error) => void) => unknown;
  closeAllConnections?: () => void;
  closeIdleConnections?: () => void;
}

/** While draining, connections that went idle after their last response are swept this often. */
const IDLE_SWEEP_MS = 25;

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
  const begin = (signal: string): Promise<void> => {
    if (drained) return drained;
    const server = app.getHttpServer() as ClosableServer;
    // a request that still arrives on a kept-alive connection is answered, and its connection then closes
    // (the client does not send the next one into a socket that is about to be swept)
    server.prependListener?.('request', (_req, res) => {
      try {
        res.setHeader('Connection', 'close');
      } catch {
        /* headers already sent */
      }
    });
    drained = new Promise<void>((resolve) => {
      const sweep = setInterval(
        () => server.closeIdleConnections?.(),
        IDLE_SWEEP_MS,
      );
      sweep.unref();
      const done = (): void => {
        clearInterval(sweep);
        resolve();
      };
      try {
        // no new connections; the callback fires when the last open one has ended
        server.close?.(() => done());
      } catch {
        done();
        return;
      }
      if (!server.close) done();
      server.closeIdleConnections?.();
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
