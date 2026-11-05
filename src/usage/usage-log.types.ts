/** One recorded request (Story 20.7). Everything here is already clamped and clean: see `usage-log.middleware.ts`. */
export interface UsageLogRow {
  /** epoch milliseconds, the moment the response finished */
  ts: number;
  method: string;
  /** the route TEMPLATE, or `__unmatched__` */
  route: string;
  status: number;
  durationMs: number;
  actorType: 'ADMIN' | 'CUSTOMER' | 'ANON';
  actorId: string | null;
  /** a valid IPv4/IPv6 text, or null */
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

/** Where a batch goes. The only piece that talks to the database (replaced by a stub in the chaos test). */
export interface UsageLogWriter {
  insert(rows: readonly UsageLogRow[]): Promise<void>;
}

export const USAGE_LOG_WRITER = Symbol('USAGE_LOG_WRITER');
export const USAGE_LOG_CONFIG = Symbol('USAGE_LOG_CONFIG');

export interface UsageLogStats {
  buffered: number;
  droppedSinceBoot: number;
  lastFlushAt: string | null;
  lastFlushError: string | null;
  writtenSinceBoot: number;
}
