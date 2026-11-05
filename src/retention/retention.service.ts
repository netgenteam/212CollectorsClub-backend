import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import type { OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { adminActor, payload, SYSTEM_ACTOR } from '../audit/audit-events.js';
import { AuditService } from '../audit/audit.service.js';
import { RequestContext } from '../common/request-context.js';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UsageLogPurgeService } from '../usage/usage-purge.service.js';
import { ProductSignalsService } from '../vitrina/product-signals.service.js';
import {
  effectiveClock,
  hostMonotonicSource,
  RETENTION_MONOTONIC,
} from './retention-clock.js';
import type { ClockAnchor, MonotonicSource } from './retention-clock.js';
import type { RetentionConfig } from './retention-config.js';
import { RetentionSessionLock } from './retention-lock.js';
import { RETENTION_ADVISORY_KEY, RETENTION_CONFIG } from './retention.types.js';
import type {
  RetentionContext,
  RetentionRunStatus,
  RetentionTask,
  RetentionTaskResult,
  RetentionTrigger,
} from './retention.types.js';
import {
  anonCartsTask,
  anonWishlistsTask,
} from './tasks/anonymous-baskets.tasks.js';
import { contactInquiriesTask } from './tasks/contact-inquiries.task.js';
import {
  productDailyStatsTask,
  usageLogsTask,
} from './tasks/delegated.tasks.js';
import {
  revokedTokensTask,
  verificationTokensTask,
} from './tasks/expired-tokens.tasks.js';
import { retentionRunsTask } from './tasks/retention-runs.task.js';
import { sessionPiiTask } from './tasks/session-pii.task.js';
import { sessionsExpiredTask } from './tasks/sessions-expired.task.js';

/** The cron name: `SchedulerRegistry` is how `GET /admin/retention/config` finds the next run. */
export const RETENTION_CRON_NAME = 'retention-purge';

/** Database clock and application clock further apart than this: one of them is wrong, nothing is purged. */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
/** Unaudited runs older than this are not chased (the table prunes them anyway). */
const CATCH_UP_DAYS = 30;
const CATCH_UP_MAX_PER_RUN = 5;
/** A running purge is given this long to stop at its next batch when the application shuts down. */
const SHUTDOWN_WAIT_MS = 20_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The only thing about an error that is ever stored or logged: its class and a SQLSTATE / Prisma code. */
export function errorCode(err: unknown): string {
  if (!(err instanceof Error)) return 'UNKNOWN';
  const e = err as { code?: unknown; name?: string };
  const code =
    typeof e.code === 'string' && /^[A-Za-z0-9_]{1,12}$/.test(e.code)
      ? ` ${e.code}`
      : '';
  return `${(e.name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 60)}${code}`;
}

/** A test run must never purge anything but a throw-away clone (`test/helpers/test-db.ts`). */
const THROWAWAY_DB_RE = /^[a-z0-9_]{1,30}_e2e_\d{10}_[0-9a-f]{8}$/;

export class RetentionGuardError extends Error {}

export type StartOutcome =
  | { kind: 'started'; runId: string; done: Promise<RunSummary> }
  | { kind: 'busy' }
  | { kind: 'disabled' };

export interface RunSummary {
  runId: string;
  status: RetentionRunStatus;
  tasks: RetentionTaskResult[];
  audited: boolean;
}

interface PreviousRun {
  id: string;
  trigger: string;
  triggeredById: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  status: string;
  tasks: Prisma.JsonValue;
  effectiveNow: Date | null;
}

/** The clock of the previous run, with the anchor that lets the next one measure the real time between them. */
interface PreviousClockRow {
  effectiveNow: Date;
  bootId: string | null;
  uptimeMs: bigint | number | null;
}

/**
 * Story 20.8 (AD-101, FR-130..132): the daily retention job.
 *
 *  - ONE run at a time across every instance: a session advisory lock (`pg_try_advisory_lock(2120002)`)
 *    on a dedicated connection, plus a partial unique index on `Retention_Runs` (one `RUNNING` row).
 *    A run that cannot get the lock does nothing (the cron) or answers 409 (`POST /admin/retention/run`).
 *  - Independent tasks, each in its own `try/catch`; each one deletes in short batches (its own
 *    transaction, a bounded lock wait, a pause) and stops at the run's deadline. No task is a
 *    prerequisite of another; a failed one is recorded and the rest still run.
 *  - NOTHING is passed in by the caller that could move a cut-off: the periods come from the boot
 *    configuration, the clock is `retention-clock.ts` (the database clock, capped), the margin is a
 *    constant. The manual endpoint takes no parameter at all.
 *  - Audit (decision, AD-99 "fail-closed" applies to a business action; this is an expiry of data the
 *    Privacy Policy promises to delete): the purge is NOT conditional on the audit log being writable.
 *    Holding back an expiry because the audit chain is down would turn an audit incident into a privacy
 *    breach, and the effects are counters of low-criticality rows (never orders, proofs, consents or the
 *    audit log). So the run purges, then closes the row and writes `RETENTION_PURGE_RUN` in ONE
 *    transaction; if that cannot be written the row is closed anyway (`status` PARTIAL, `auditedAt`
 *    NULL, `errorSummary AUDIT_NOT_WRITTEN`), the error is logged, and the NEXT run writes the missing
 *    event (`lateAudit: true`) before it purges anything: no purge stays unaudited for good.
 *  - Disabled by default outside production (`RETENTION_PURGE_ENABLED`): see `retention-config.ts`.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(RetentionService.name);
  private readonly tasks: RetentionTask[];
  private inflight: Promise<RunSummary> | null = null;
  private stopping = false;
  /** `RETENTION_CLOCK_RESYNC` is honoured once per process (see `retention-clock.ts`). */
  private resyncUsed = false;
  private readonly monotonic: MonotonicSource;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService,
    @Inject(RETENTION_CONFIG) readonly cfg: RetentionConfig,
    usagePurge: UsageLogPurgeService,
    signals: ProductSignalsService,
    private readonly scheduler: SchedulerRegistry,
    @Optional() @Inject(RETENTION_MONOTONIC) monotonic?: MonotonicSource,
  ) {
    this.monotonic = monotonic ?? hostMonotonicSource;
    // The order is the budget: the small tables first, the big one (usage log) last, so a backlog in
    // it cannot starve the others of the run's time.
    this.tasks = [
      sessionsExpiredTask,
      sessionPiiTask,
      revokedTokensTask,
      verificationTokensTask,
      contactInquiriesTask,
      anonCartsTask,
      anonWishlistsTask,
      productDailyStatsTask(signals),
      retentionRunsTask,
      usageLogsTask(usagePurge),
    ];
  }

  taskNames(): string[] {
    return this.tasks.map((t) => t.name);
  }

  /** The next time the cron fires, or null (cron off, job disabled, not registered in this process). */
  nextRunAt(): Date | null {
    if (!this.cfg.enabled || this.cfg.cron === 'off') return null;
    try {
      const next: unknown = this.scheduler
        .getCronJob(RETENTION_CRON_NAME)
        .nextDate();
      if (next instanceof Date) return next;
      const js = (next as { toJSDate?: () => Date } | null)?.toJSDate?.();
      return js ?? null;
    } catch {
      return null;
    }
  }

  isRunning(): boolean {
    return this.inflight !== null;
  }

  /**
   * The ONE schedule of the purge, `RETENTION_PURGE_CRON` (default `30 4 * * *`, UTC, after the TCG (03:00) and
   * FX (03:30) jobs). It is registered here, from the validated configuration, and not with a `@Cron(...)`
   * decorator: a decorator is evaluated when the class is imported, before the configuration is read, and
   * `GET /admin/retention/config` could then show a cron that was not the one running. The usage log has no
   * schedule of its own any more (`UsageLogPurgeService`): this job purges it.
   */
  onModuleInit(): void {
    const production = process.env.NODE_ENV === 'production';
    if (!this.cfg.enabled) {
      this.logger.log(
        'retention job is DISABLED (RETENTION_PURGE_ENABLED, or NODE_ENV is not production): nothing is purged, the usage log included',
      );
      return;
    }
    if (this.cfg.cron === 'off') {
      const msg =
        'RETENTION_PURGE_CRON=off: the retention job has NO schedule; the usage log (IP and user agent of every visitor, promised to be deleted after 7 days) and every other expiry are only purged by POST /admin/retention/run';
      if (production) this.logger.warn(msg);
      else this.logger.log(msg);
      return;
    }
    const job = CronJob.from({
      cronTime: this.cfg.cron,
      onTick: () => {
        void this.scheduled();
      },
      start: false,
      timeZone: 'UTC',
    });
    this.scheduler.addCronJob(RETENTION_CRON_NAME, job);
    // A test process never schedules anything by itself (the e2e calls `scheduled()` directly).
    if (process.env.NODE_ENV !== 'test') {
      job.start();
      this.logger.log(`retention job scheduled: "${this.cfg.cron}" (UTC)`);
    }
  }

  /** One tick of the schedule (also what the e2e calls). */
  async scheduled(): Promise<void> {
    if (!this.cfg.enabled || this.cfg.cron === 'off') return;
    // A background job must not carry a request's id or address into the audit chain.
    await RequestContext.detached(async () => {
      try {
        const out = await this.start('SCHEDULED');
        if (out.kind === 'busy') {
          this.logger.warn(
            'retention run skipped: another run holds the lock (another instance, or a run that is still going)',
          );
        } else if (out.kind === 'started') {
          await out.done;
        }
      } catch (err) {
        this.logger.error(
          err instanceof RetentionGuardError
            ? `retention run could not start: ${err.message}`
            : `retention run could not start: ${errorCode(err)}`,
        );
      }
    });
  }

  /**
   * Takes the lock and writes the `RUNNING` row (so the caller can hand back `runId`), then runs the tasks
   * in the background: `done` resolves with the summary and never rejects.
   */
  async start(
    trigger: RetentionTrigger,
    adminId: string | null = null,
  ): Promise<StartOutcome> {
    if (!this.cfg.enabled || this.stopping) return { kind: 'disabled' };
    const url = this.config.getOrThrow<string>('DATABASE_URL');
    const lock = await RetentionSessionLock.tryAcquire(
      url,
      RETENTION_ADVISORY_KEY,
    );
    if (!lock) return { kind: 'busy' };

    let runId: string;
    let asOf: Date;
    let clamped: boolean;
    let skewMs: number;
    try {
      await this.assertSafeDatabase(lock);
      // We hold the lock, so any row still `RUNNING` belongs to a run that died with its connection.
      await this.failOrphanedRuns();
      const dbNow = await this.databaseNow();
      skewMs = Math.abs(dbNow.getTime() - Date.now());
      const previous = await this.previousClock();
      const anchor = this.monotonic.anchor();
      const clock = effectiveClock({
        dbNow,
        previous,
        current: anchor,
        maxAdvanceHours: this.cfg.maxClockAdvanceHours,
        resync: this.cfg.clockResync && !this.resyncUsed,
      });
      asOf = clock.asOf;
      clamped = clock.clamped;
      this.reportClock(clock, dbNow);
      const row = await this.prisma.retentionRun.create({
        data: {
          trigger,
          triggeredById: adminId,
          status: 'RUNNING',
          effectiveNow: asOf,
          clockClamped: clamped,
          bootId: anchor.bootId,
          uptimeMs: anchor.uptimeMs === null ? null : BigInt(anchor.uptimeMs),
        },
        select: { id: true },
      });
      runId = row.id;
    } catch (err) {
      await lock.release(RETENTION_ADVISORY_KEY);
      // The second wall: a RUNNING row already exists (the lock was lost by another run).
      if (isUniqueViolation(err)) return { kind: 'busy' };
      throw err;
    }

    const done = this.execute({
      runId,
      trigger,
      adminId,
      asOf,
      clamped,
      skewMs,
      lock,
    }).finally(() => {
      this.inflight = null;
    });
    this.inflight = done;
    return { kind: 'started', runId, done };
  }

  /** Test, development and any process that is not meant to purge must not reach a real database. */
  private async assertSafeDatabase(lock: RetentionSessionLock): Promise<void> {
    if (process.env.NODE_ENV !== 'test') return;
    const db = await lock.currentDatabase();
    if (!THROWAWAY_DB_RE.test(db)) {
      throw new RetentionGuardError(
        `the retention job refuses to run under NODE_ENV=test on database "${db}": it is not a throw-away e2e clone`,
      );
    }
  }

  /**
   * The database clock as an epoch (`extract(epoch ...)`): an integer no session time zone and no driver parser
   * can shift. (Reading `now()` as a `timestamptz` through Prisma came back offset by the zone of the session:
   * every run aborted with CLOCK_SKEW. The connections now run in UTC as well, `prisma/db-session.ts`.)
   */
  private async databaseNow(): Promise<Date> {
    const r = await this.prisma.$queryRaw<
      { ms: bigint }[]
    >`SELECT (floor(extract(epoch FROM now()) * 1000))::bigint AS ms`;
    return new Date(Number(r[0].ms));
  }

  private async previousClock(): Promise<
    (ClockAnchor & { effectiveNow: Date }) | null
  > {
    const r = await this.prisma.$queryRaw<PreviousClockRow[]>`
      SELECT "effectiveNow", "bootId", "uptimeMs" FROM "Retention_Runs"
       WHERE "effectiveNow" IS NOT NULL ORDER BY "startedAt" DESC LIMIT 1`;
    const p = r[0];
    if (!p) return null;
    return {
      effectiveNow: p.effectiveNow,
      bootId: p.bootId,
      uptimeMs: p.uptimeMs === null ? null : Number(p.uptimeMs),
    };
  }

  /** WARN every time the clock was capped or resynchronised, with the lag, so it is never silent. */
  private reportClock(
    clock: ReturnType<typeof effectiveClock>,
    dbNow: Date,
  ): void {
    const lagH = (clock.lagMs / 3_600_000).toFixed(1);
    if (clock.basis === 'resync') {
      this.resyncUsed = true;
      this.logger.warn(
        `retention clock RESYNCHRONISED to the database clock (${dbNow.toISOString()}) because RETENTION_CLOCK_RESYNC=true; remove that variable now`,
      );
    } else if (clock.clamped) {
      this.logger.warn(
        `retention clock capped (clockClamped=true): the database clock is ${lagH} h ahead of what the time elapsed since the previous run allows ` +
          `(${clock.basis === 'verified' ? 'elapsed time measured with the host uptime counter' : 'elapsed time not verifiable: other boot, other machine or no anchor, advance limited to RETENTION_MAX_CLOCK_ADVANCE_HOURS'}); ` +
          `purging as of ${clock.asOf.toISOString()}. If the machine really was down that long, set RETENTION_CLOCK_RESYNC=true and restart once (docs/deployment.md 20.5)`,
      );
    }
  }

  /** `RUNNING` rows left by a dead run -> `FAILED` (AC6 asks for 30 minutes; holding the lock proves death sooner). */
  private async failOrphanedRuns(): Promise<void> {
    const n = await this.prisma.$executeRaw`
      UPDATE "Retention_Runs"
         SET "status" = 'FAILED', "finishedAt" = now(),
             "errorSummary" = 'INTERRUPTED: the process of the run ended before it finished'
       WHERE "status" = 'RUNNING'`;
    if (n > 0) {
      this.logger.warn(
        `${n} retention run(s) left RUNNING by a dead process marked FAILED`,
      );
    }
  }

  private async execute(p: {
    runId: string;
    trigger: RetentionTrigger;
    adminId: string | null;
    asOf: Date;
    clamped: boolean;
    skewMs: number;
    lock: RetentionSessionLock;
  }): Promise<RunSummary> {
    const results: RetentionTaskResult[] = [];
    const t0 = Date.now();
    const deadline = t0 + this.cfg.maxRunMs;
    let runError: string | null = null;
    try {
      if (p.skewMs > MAX_CLOCK_SKEW_MS) {
        // One of the two clocks is wrong and the purge cannot know which: nothing is deleted.
        runError =
          'CLOCK_SKEW: database and application clocks differ; nothing was purged';
        this.logger.error(
          `retention run ${p.runId} aborted: ${runError} (${Math.round(p.skewMs / 1000)} s)`,
        );
      } else {
        await this.writeLateAudits();
        let rowsOfTask = 0;
        const ctx: RetentionContext = {
          prisma: this.prisma,
          runId: p.runId,
          cfg: this.cfg,
          asOf: p.asOf,
          shouldStop: () =>
            Date.now() >= deadline || p.lock.lost() || this.stopping,
          pause: () => sleep(this.cfg.batchPauseMs),
          addRows: (n) => {
            rowsOfTask += n;
          },
        };
        for (const task of this.tasks) {
          rowsOfTask = 0;
          const started = Date.now();
          try {
            const o = await task.run(ctx);
            results.push({
              name: task.name,
              rows: o.rows,
              durationMs: Date.now() - started,
              truncated: o.truncated,
            });
          } catch (err) {
            const code = errorCode(err);
            this.logger.error(
              `retention task ${task.name} failed (${code}); the other tasks continue`,
            );
            results.push({
              name: task.name,
              rows: rowsOfTask,
              durationMs: Date.now() - started,
              truncated: false,
              error: code,
            });
          }
          await this.saveProgress(p.runId, results);
        }
        if (p.lock.lost())
          runError =
            'LOCK_LOST: the connection holding the run lock dropped; the run stopped';
      }
    } catch (err) {
      runError = `RUN_ERROR ${errorCode(err)}`;
      this.logger.error(`retention run ${p.runId} failed: ${runError}`);
    }

    const failedTasks = results.filter((r) => r.error).length;
    let status: RetentionRunStatus;
    if (runError && results.length === 0) status = 'FAILED';
    else if (failedTasks === 0 && !runError) status = 'OK';
    else if (failedTasks === results.length && results.length > 0)
      status = 'FAILED';
    else status = 'PARTIAL';

    let audited = false;
    try {
      audited = await this.closeAndAudit(p, status, results, runError);
    } catch (err) {
      // The audit log (or the database) is unavailable: the effects stay, the row is closed without the event.
      this.logger.error(
        `RETENTION_PURGE_RUN of ${p.runId} could not be written (${errorCode(err)}); closing the run without it, the next run writes it`,
      );
      try {
        await this.closeWithoutAudit(p.runId, status, results, runError);
      } catch (err2) {
        this.logger.error(
          `retention run ${p.runId} could not be closed (${errorCode(err2)}); it stays RUNNING until the next run reconciles it`,
        );
      }
    } finally {
      await p.lock.release(RETENTION_ADVISORY_KEY);
    }
    const total = results.reduce((n, r) => n + r.rows, 0);
    // WARN when the clock was capped: it must stand out in the log (and is on the run row and in the audit event).
    const summary =
      `retention run ${p.runId} (${p.trigger}) ${status}: ${total} rows in ${Date.now() - t0} ms; ` +
      results
        .map(
          (r) =>
            `${r.name}=${r.rows}${r.truncated ? '+' : ''}${r.error ? '!' : ''}`,
        )
        .join(' ') +
      (p.clamped ? ' [clockClamped=true]' : '');
    if (p.clamped) this.logger.warn(summary);
    else this.logger.log(summary);
    return { runId: p.runId, status, tasks: results, audited };
  }

  /** Progress of a run that is still going (visible in the admin view, and what a crash leaves behind). Best effort. */
  private async saveProgress(
    runId: string,
    results: RetentionTaskResult[],
  ): Promise<void> {
    try {
      await this.prisma.$executeRaw`
        UPDATE "Retention_Runs" SET "tasks" = ${JSON.stringify(results)}::jsonb
         WHERE "id" = ${runId}::uuid AND "status" = 'RUNNING'`;
    } catch (err) {
      this.logger.warn(`retention progress not saved (${errorCode(err)})`);
    }
  }

  private summaryPayload(
    run: {
      runId: string;
      trigger: string;
      status: string;
      startedAt: Date;
      finishedAt: Date;
      clockClamped: boolean;
      tasks: unknown;
    },
    lateAudit: boolean,
  ) {
    return payload({
      runId: run.runId,
      trigger: run.trigger,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      clockClamped: run.clockClamped,
      lateAudit,
      tasks: run.tasks,
    });
  }

  /**
   * Closes the row and writes `RETENTION_PURGE_RUN` (counters only) in ONE short transaction: the row
   * update first, the audit INSERT last (it takes the chain-head lock and holds it only to COMMIT).
   */
  private async closeAndAudit(
    p: {
      runId: string;
      trigger: RetentionTrigger;
      adminId: string | null;
      clamped: boolean;
    },
    status: RetentionRunStatus,
    results: RetentionTaskResult[],
    runError: string | null,
  ): Promise<boolean> {
    await this.audit.transaction(async (tx, audit) => {
      const rows = await tx.$queryRaw<{ startedAt: Date; finishedAt: Date }[]>`
        UPDATE "Retention_Runs"
           SET "status" = ${status}, "finishedAt" = now(), "tasks" = ${JSON.stringify(results)}::jsonb,
               "errorSummary" = ${runError ? runError.slice(0, 200) : null}, "auditedAt" = now()
         WHERE "id" = ${p.runId}::uuid
         RETURNING "startedAt", "finishedAt"`;
      const row = rows[0];
      audit.add({
        ...(p.adminId ? adminActor({ id: p.adminId }) : SYSTEM_ACTOR),
        action: 'RETENTION_PURGE_RUN',
        entityType: 'RetentionRun',
        entityId: p.runId,
        after: this.summaryPayload(
          {
            runId: p.runId,
            trigger: p.trigger,
            status,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
            clockClamped: p.clamped,
            tasks: results,
          },
          false,
        ),
      });
    });
    return true;
  }

  private async closeWithoutAudit(
    runId: string,
    status: RetentionRunStatus,
    results: RetentionTaskResult[],
    runError: string | null,
  ): Promise<void> {
    const note =
      'AUDIT_NOT_WRITTEN: RETENTION_PURGE_RUN could not be written; the next run writes it';
    const final = status === 'OK' ? 'PARTIAL' : status;
    await this.prisma.$executeRaw`
      UPDATE "Retention_Runs"
         SET "status" = ${final}, "finishedAt" = now(), "tasks" = ${JSON.stringify(results)}::jsonb,
             "errorSummary" = ${(runError ? `${runError} | ${note}` : note).slice(0, 200)}, "auditedAt" = NULL
       WHERE "id" = ${runId}::uuid`;
  }

  /**
   * The runs that closed without their event (audit log down at the time) get it now, before this run
   * purges anything. One transaction per run: `auditedAt` is set only together with the INSERT.
   */
  private async writeLateAudits(): Promise<void> {
    let pending: PreviousRun[];
    try {
      pending = await this.prisma.$queryRaw<PreviousRun[]>`
        SELECT "id", "trigger", "triggeredById", "startedAt", "finishedAt", "status", "tasks", "effectiveNow"
          FROM "Retention_Runs"
         WHERE "finishedAt" IS NOT NULL AND "auditedAt" IS NULL
           AND "startedAt" > now() - make_interval(days => ${CATCH_UP_DAYS}::int)
         ORDER BY "startedAt" LIMIT ${CATCH_UP_MAX_PER_RUN}::int`;
    } catch (err) {
      this.logger.warn(`late audits not looked up (${errorCode(err)})`);
      return;
    }
    for (const r of pending) {
      try {
        await this.audit.transaction(async (tx, audit) => {
          const claimed = await tx.$executeRaw`
            UPDATE "Retention_Runs" SET "auditedAt" = now()
             WHERE "id" = ${r.id}::uuid AND "auditedAt" IS NULL`;
          if (claimed === 0) return;
          audit.add({
            ...(r.triggeredById
              ? adminActor({ id: r.triggeredById })
              : SYSTEM_ACTOR),
            action: 'RETENTION_PURGE_RUN',
            entityType: 'RetentionRun',
            entityId: r.id,
            after: this.summaryPayload(
              {
                runId: r.id,
                trigger: r.trigger,
                status: r.status,
                startedAt: r.startedAt,
                finishedAt: r.finishedAt as Date,
                clockClamped: false,
                tasks: r.tasks,
              },
              true,
            ),
          });
        });
      } catch (err) {
        this.logger.warn(
          `late RETENTION_PURGE_RUN of ${r.id} not written (${errorCode(err)})`,
        );
        return; // the audit log is still down: do not hammer it
      }
    }
  }

  /** Shutdown: the run stops at its next batch; wait a little so its row is closed. */
  async onApplicationShutdown(): Promise<void> {
    this.stopping = true;
    try {
      void this.scheduler.getCronJob(RETENTION_CRON_NAME).stop();
      this.scheduler.deleteCronJob(RETENTION_CRON_NAME);
    } catch {
      /* never registered (disabled, off, or already removed by the scheduler) */
    }
    const running = this.inflight;
    if (running) {
      await Promise.race([
        running.catch(() => undefined),
        sleep(SHUTDOWN_WAIT_MS),
      ]);
    }
  }
}

function isUniqueViolation(err: unknown): boolean {
  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === 'P2002'
  )
    return true;
  const e = err as { code?: unknown; cause?: unknown; meta?: unknown } | null;
  if (!e) return false;
  if (e.code === '23505') return true;
  try {
    if (JSON.stringify(e.meta ?? '').includes('23505')) return true;
  } catch {
    /* ignore */
  }
  return e.cause !== undefined && isUniqueViolation(e.cause);
}
