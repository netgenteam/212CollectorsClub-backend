import type { PrismaService } from '../prisma/prisma.service.js';
import type { RetentionConfig } from './retention-config.js';

export const RETENTION_CONFIG = Symbol('RETENTION_CONFIG');

/**
 * Session advisory lock of the retention run (AD-101). Distinct from the audit chain lock (2120001)
 * and from the usage purge's per-batch transaction lock (2120003).
 */
export const RETENTION_ADVISORY_KEY = 2120002;

export type RetentionTrigger = 'SCHEDULED' | 'MANUAL';

/** What one task reports; `error` is a short code, NEVER a message (it can carry a value of a row). */
export interface RetentionTaskResult {
  name: string;
  rows: number;
  durationMs: number;
  truncated: boolean;
  error?: string;
}

/** What a task body returns. */
export interface RetentionTaskOutcome {
  rows: number;
  truncated: boolean;
}

export interface RetentionContext {
  prisma: PrismaService;
  /** The `Retention_Runs` row of this run (a run never deletes its own row). */
  runId: string;
  cfg: RetentionConfig;
  /**
   * The clock of the run (`retention-clock.ts`): the database clock, never ahead of the previous run's
   * by more than `RETENTION_MAX_CLOCK_ADVANCE_HOURS`. EVERY cut-off is computed from this and
   * `SAFETY_MARGIN_MS`; no task reads `now()` or `Date.now()` for a cut-off.
   */
  asOf: Date;
  /** True when the run must stop at the next batch boundary: deadline, lost lock or shutdown. */
  shouldStop: () => boolean;
  /** Pause between two batches (`RETENTION_BATCH_PAUSE_MS`). */
  pause: () => Promise<void>;
  /** Counts rows changed so far by the current task, so a task that fails half-way still reports what it did. */
  addRows: (n: number) => void;
}

export interface RetentionTask {
  name: string;
  run(ctx: RetentionContext): Promise<RetentionTaskOutcome>;
}

export type RetentionRunStatus = 'RUNNING' | 'OK' | 'PARTIAL' | 'FAILED';
