import { Logger } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';

/** After the signal, connections still open (a request waiting on a database that does not answer) are cut. */
export const SHUTDOWN_GRACE_MS = 5_000;
/** The process exits by itself this long after the signal whatever is still pending. */
export const SHUTDOWN_DEADLINE_MS = 20_000;

interface ClosableServer {
  closeAllConnections?: () => void;
  closeIdleConnections?: () => void;
}

/**
 * Story 20.7 round 2: closing with a database that does not answer used to take 136 s (measured by QA; with
 * 12 requests stuck on a paused database the process was still alive after 200 s in this story's own
 * reproduction). `app.close()` first waits for the HTTP server to finish its open requests, and a request
 * waiting on a paused database never does, so the `onModuleDestroy` hooks (the usage log flush, the pool
 * close) never even started. Now, from the first `SIGTERM`/`SIGINT`:
 *
 *   - at once, idle keep-alive connections are closed;
 *   - after `SHUTDOWN_GRACE_MS` (5 s) every connection still open is cut, so the server closes and the
 *     destroy hooks run (each of them has its own short bound: the usage log flush 2 s, its connection 2 s,
 *     Prisma's disconnect 3 s);
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
  let started = false;
  const onSignal = (signal: string): void => {
    if (started) return;
    started = true;
    const server = app.getHttpServer() as ClosableServer;
    server.closeIdleConnections?.();
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
  };
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  process.once('SIGINT', () => onSignal('SIGINT'));
}
