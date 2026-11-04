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
