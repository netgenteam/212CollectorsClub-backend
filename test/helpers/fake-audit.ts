import type {
  AuditCollector,
  AuditEventInput,
  AuditService,
} from '../../src/audit/audit.service.js';

type TxRunner = (cb: (tx: never) => unknown, options?: unknown) => unknown;

/**
 * Story 20.5: a stand-in for `AuditService` in the unit specs of services that emit audit events.
 * `transaction` runs the callback through the (mocked) `prisma.$transaction` exactly as the real
 * service does (same default options), collects what `audit.add` receives in `events` and
 * flushes nothing. The real service (lock, chain, hash) has its own specs.
 */
export function fakeAudit(prisma: { $transaction: unknown }): AuditService & {
  events: AuditEventInput[];
} {
  const run = prisma.$transaction as TxRunner;
  const events: AuditEventInput[] = [];
  const collector: AuditCollector = { add: (ev) => void events.push(ev) };
  const svc = {
    events,
    transaction: (
      fn: (tx: never, audit: AuditCollector) => unknown,
      options: { maxWait?: number; timeout?: number } = {},
    ) =>
      run((tx) => fn(tx, collector), {
        maxWait: options.maxWait ?? 10_000,
        timeout: options.timeout ?? 30_000,
      }),
  };
  return svc as unknown as AuditService & { events: AuditEventInput[] };
}
