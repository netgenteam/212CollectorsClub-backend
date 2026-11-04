import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Story 20.1 (AD-99/AD-100): per-request context. Only `requestId` and `ip`
 * live here (the actor is always passed explicitly to the audit events). It is
 * read by `AuditService` (default `requestId`/`ip` of an event) and available
 * to anything that wants to log or return the request id.
 */
export interface RequestContextData {
  requestId: string;
  ip: string | null;
}

const storage = new AsyncLocalStorage<RequestContextData>();

export const RequestContext = {
  run<T>(data: RequestContextData, fn: () => T): T {
    return storage.run(data, fn);
  },
  /**
   * Runs `fn` OUTSIDE any request context. `AsyncLocalStorage` is captured by whatever is created
   * inside a request (a `setTimeout`, a promise chain): a timer armed by request A fires with A's
   * `requestId` and `ip`. A background job (a timer, a flush) must not carry a stranger's address
   * into the audit chain: wrap its callback with this.
   */
  detached<T>(fn: () => T): T {
    return storage.exit(fn);
  },
  get(): RequestContextData | undefined {
    return storage.getStore();
  },
  requestId(): string | null {
    return storage.getStore()?.requestId ?? null;
  },
  ip(): string | null {
    return storage.getStore()?.ip ?? null;
  },
};
