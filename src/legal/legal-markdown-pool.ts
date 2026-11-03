import { Worker, type ResourceLimits } from 'node:worker_threads';

/** Facts extracted by `legal-markdown.worker.mjs` (see the header there). */
export type MarkdownFact =
  | ['html', number]
  | ['image', number]
  | ['url', 'link' | 'definition', string, string, number]
  | ['h', 2 | 3, string, number]
  /** Story 19.3a: leftover `[[`/`]]` or template notice in the visible text. */
  | ['residual', 'marker' | 'notice', string, number];

export type PoolFailureKind =
  /** Hard deadline expired: the worker was terminated. */
  | 'TIMEOUT'
  /** The worker crashed, ran out of memory, or answered with an error. */
  | 'FAILED'
  /** All workers busy and the queue is full: rejected without queuing. */
  | 'BUSY'
  /** The pool is shutting down. */
  | 'CLOSED';

export class PoolFailure extends Error {
  constructor(
    readonly kind: PoolFailureKind,
    detail?: string,
  ) {
    super(detail ? `${kind}: ${detail}` : kind);
  }
}

export interface MarkdownPoolOptions {
  /** Workers alive at the same time (each parses one document at a time). */
  maxWorkers: number;
  /** Jobs allowed to wait for a free worker; beyond this: BUSY. */
  maxQueue: number;
  /** Hard deadline for ONE parse, counted from when a worker starts it. */
  timeoutMs: number;
  /** Same, for a diff job (Story 19.2): jsdiff is slower than the parser. */
  diffTimeoutMs: number;
  resourceLimits: ResourceLimits;
  /** Worker script. Only tests override it (crash / out-of-memory simulations). */
  workerUrl: URL;
  /** Worker factory. Only tests override it (count live threads, make it throw). */
  createWorker?: (o: {
    workerUrl: URL;
    resourceLimits: ResourceLimits;
  }) => Worker;
}

export const DEFAULT_POOL_OPTIONS: MarkdownPoolOptions = {
  maxWorkers: 2,
  maxQueue: 16,
  timeoutMs: 3_000,
  diffTimeoutMs: 10_000,
  // A parse of a 200 KB document needs well under 100 MB; the cap only stops a
  // runaway thread from taking the API process down with it.
  resourceLimits: {
    maxOldGenerationSizeMb: 192,
    maxYoungGenerationSizeMb: 32,
    stackSizeMb: 4,
  },
  workerUrl: new URL('./legal-markdown.worker.mjs', import.meta.url),
};

/** Result of a 'diff' job (see `legal-diff.core.mjs`). */
export interface DiffResult {
  stats: { added: number; removed: number };
  hunks: {
    type: 'added' | 'removed' | 'context';
    lines: string[];
    oldStart: number;
    newStart: number;
  }[];
}

interface Job {
  /** Message posted to the worker. */
  request: { id: 0; type: 'markdown' | 'diff'; [k: string]: unknown };
  timeoutMs: number;
  resolve: (result: never) => void;
  reject: (e: PoolFailure) => void;
}

interface Slot {
  worker: Worker;
  job?: Job;
  timer?: NodeJS.Timeout;
  dead: boolean;
  /** Set once the slot is being terminated; resolves when the thread is gone. */
  gone?: Promise<void>;
}

export interface MarkdownPoolStats {
  /** Threads that exist, INCLUDING those still being terminated. */
  alive: number;
  busy: number;
  queued: number;
  spawned: number;
  terminated: number;
}

/**
 * Bounded pool of long-lived `worker_thread`s for Markdown analysis.
 *
 * - INVARIANT: `slots` holds every thread that may still be running, and a
 *   slot only leaves it when `terminate()` has RESOLVED. A worker being
 *   terminated therefore keeps counting against `maxWorkers`, whatever order
 *   timeouts, errors, `exit` events and new requests arrive in. The only place
 *   that creates a worker is `pump()`, and it only does so when
 *   `slots.size < maxWorkers`.
 * - At most `maxQueue` jobs wait; anything more is rejected immediately
 *   (`BUSY`), so a burst of POSTs cannot create unbounded threads or memory.
 * - Every job has a hard deadline: on expiry the thread is `terminate()`d (the
 *   only way to stop a synchronous parser) and a fresh one is created lazily
 *   by `pump()` once the old one is really gone.
 * - A crash, a thrown error or an out-of-memory (`resourceLimits`) kills only
 *   that worker: the job fails with `FAILED`, the process keeps running.
 * - `close()` terminates every thread and fails queued jobs; no thread is left.
 */
export class MarkdownWorkerPool {
  private readonly slots = new Set<Slot>();
  private readonly queue: Job[] = [];
  private closed = false;
  private spawned = 0;
  private terminated = 0;

  constructor(private readonly opts: MarkdownPoolOptions) {}

  stats(): MarkdownPoolStats {
    let busy = 0;
    for (const s of this.slots) if (s.job) busy++;
    return {
      alive: this.slots.size,
      busy,
      queued: this.queue.length,
      spawned: this.spawned,
      terminated: this.terminated,
    };
  }

  run(md: string): Promise<MarkdownFact[]> {
    return this.submit<MarkdownFact[]>(
      { id: 0, type: 'markdown', md },
      this.opts.timeoutMs,
    );
  }

  /** Line diff of two Markdown texts, computed off the event loop. */
  runDiff(from: string, to: string): Promise<DiffResult> {
    return this.submit<DiffResult>(
      { id: 0, type: 'diff', from, to },
      this.opts.diffTimeoutMs,
    );
  }

  private submit<T>(request: Job['request'], timeoutMs: number): Promise<T> {
    if (this.closed) return Promise.reject(new PoolFailure('CLOSED'));
    return new Promise<T>((resolve, reject) => {
      const job: Job = {
        request,
        timeoutMs,
        resolve,
        reject,
      };
      this.queue.push(job);
      this.pump();
      // Still waiting beyond the allowed queue: nobody can take it soon.
      if (this.queue.length > this.opts.maxQueue) {
        const at = this.queue.lastIndexOf(job);
        if (at >= 0) {
          this.queue.splice(at, 1);
          reject(new PoolFailure('BUSY', 'queue is full'));
        }
      }
    });
  }

  /** Terminates every worker and fails the queued and running jobs. */
  async close(): Promise<void> {
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      job.reject(new PoolFailure('CLOSED'));
    }
    await Promise.all([...this.slots].map((s) => this.kill(s, 'CLOSED')));
  }

  /**
   * THE scheduler: gives queued jobs to idle workers and, only while
   * `slots.size < maxWorkers` (dying workers included), creates new ones.
   * Called whenever something may have freed capacity. Never throws.
   */
  private pump(): void {
    while (!this.closed && this.queue.length > 0) {
      const idle = this.idleSlot();
      if (idle) {
        this.dispatch(idle, this.queue.shift()!);
        continue;
      }
      if (this.slots.size >= this.opts.maxWorkers) return;
      const job = this.queue.shift()!;
      let slot: Slot;
      try {
        slot = this.spawn();
      } catch (e) {
        // Cannot create a thread: fail only this job, keep draining.
        job.reject(
          new PoolFailure(
            'FAILED',
            e instanceof Error ? e.message : 'cannot spawn worker',
          ),
        );
        continue;
      }
      this.dispatch(slot, job);
    }
  }

  private idleSlot(): Slot | undefined {
    for (const s of this.slots) if (!s.job && !s.dead) return s;
    return undefined;
  }

  /** Only called from `pump()`, which checked the capacity. May throw. */
  private spawn(): Slot {
    const create =
      this.opts.createWorker ??
      ((o) =>
        new Worker(o.workerUrl, {
          resourceLimits: o.resourceLimits,
          // Never inherit debugger/loader flags from the parent (`--inspect-brk`...).
          execArgv: [],
        }));
    const worker = create({
      workerUrl: this.opts.workerUrl,
      resourceLimits: this.opts.resourceLimits,
    });
    // An idle worker must not keep the process alive.
    worker.unref();
    const slot: Slot = { worker, dead: false };
    this.spawned++;
    this.slots.add(slot);
    worker.on(
      'message',
      (msg: { ok: boolean; result?: unknown; error?: string }) => {
        const job = slot.job;
        if (!job || slot.dead) return;
        this.finish(slot);
        if (msg.ok && msg.result !== undefined)
          job.resolve(msg.result as never);
        else job.reject(new PoolFailure('FAILED', msg.error ?? 'worker error'));
        this.pump();
      },
    );
    worker.on('error', (e: Error) => {
      // Out-of-memory (ERR_WORKER_OUT_OF_MEMORY), uncaught exception...
      void this.kill(slot, 'FAILED', e.message);
    });
    worker.on('exit', () => {
      void this.kill(slot, 'FAILED', 'worker exited');
    });
    return slot;
  }

  private dispatch(slot: Slot, job: Job): void {
    slot.job = job;
    slot.timer = setTimeout(() => {
      void this.kill(slot, 'TIMEOUT', `no answer in ${job.timeoutMs} ms`);
    }, job.timeoutMs);
    try {
      slot.worker.postMessage(job.request);
    } catch (e) {
      void this.kill(slot, 'FAILED', e instanceof Error ? e.message : 'post');
    }
  }

  private finish(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.job = undefined;
  }

  /**
   * Fails the slot's running job and terminates its worker. The slot stays in
   * `slots` (counting against the cap) until the thread is really gone; only
   * then is the queue pumped. Idempotent: later calls get the same promise.
   */
  private kill(
    slot: Slot,
    kind: PoolFailureKind,
    detail?: string,
  ): Promise<void> {
    if (slot.gone) return slot.gone;
    slot.dead = true;
    const job = slot.job;
    this.finish(slot);
    job?.reject(new PoolFailure(kind, detail));
    this.terminated++;
    slot.gone = (async () => {
      try {
        await slot.worker.terminate();
      } catch {
        // already gone
      }
      this.slots.delete(slot);
      this.pump(); // a queued job must not starve because its worker died
    })();
    return slot.gone;
  }
}
