import { Worker, type ResourceLimits } from 'node:worker_threads';

/** Facts extracted by `legal-markdown.worker.mjs` (see the header there). */
export type MarkdownFact =
  | ['html', number]
  | ['image', number]
  | ['url', 'link' | 'definition', string, string, number]
  | ['h', 2 | 3, string, number];

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
  resourceLimits: ResourceLimits;
  /** Worker script. Only tests override it (crash / out-of-memory simulations). */
  workerUrl: URL;
}

export const DEFAULT_POOL_OPTIONS: MarkdownPoolOptions = {
  maxWorkers: 2,
  maxQueue: 16,
  timeoutMs: 3_000,
  // A parse of a 200 KB document needs well under 100 MB; the cap only stops a
  // runaway thread from taking the API process down with it.
  resourceLimits: {
    maxOldGenerationSizeMb: 192,
    maxYoungGenerationSizeMb: 32,
    stackSizeMb: 4,
  },
  workerUrl: new URL('./legal-markdown.worker.mjs', import.meta.url),
};

interface Job {
  md: string;
  resolve: (facts: MarkdownFact[]) => void;
  reject: (e: PoolFailure) => void;
}

interface Slot {
  worker: Worker;
  job?: Job;
  timer?: NodeJS.Timeout;
  dead: boolean;
}

export interface MarkdownPoolStats {
  alive: number;
  busy: number;
  queued: number;
  spawned: number;
  terminated: number;
}

/**
 * Bounded pool of long-lived `worker_thread`s for Markdown analysis.
 *
 * - At most `maxWorkers` threads exist; at most `maxQueue` jobs wait; anything
 *   more is rejected immediately (`BUSY`), so a burst of POSTs cannot create
 *   unbounded threads or memory.
 * - Every job has a hard deadline: on expiry the thread is `terminate()`d (the
 *   only way to stop a synchronous parser) and a fresh one is created lazily.
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
    if (this.closed) return Promise.reject(new PoolFailure('CLOSED'));
    return new Promise<MarkdownFact[]>((resolve, reject) => {
      const job: Job = { md, resolve, reject };
      const idle = this.idleSlot();
      if (idle) return this.dispatch(idle, job);
      if (this.slots.size < this.opts.maxWorkers) {
        return this.dispatch(this.spawn(), job);
      }
      if (this.queue.length >= this.opts.maxQueue) {
        return reject(new PoolFailure('BUSY', 'queue is full'));
      }
      this.queue.push(job);
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

  private idleSlot(): Slot | undefined {
    for (const s of this.slots) if (!s.job && !s.dead) return s;
    return undefined;
  }

  private spawn(): Slot {
    const worker = new Worker(this.opts.workerUrl, {
      resourceLimits: this.opts.resourceLimits,
      // Never inherit debugger/loader flags from the parent (`--inspect-brk`...).
      execArgv: [],
    });
    // An idle worker must not keep the process alive.
    worker.unref();
    const slot: Slot = { worker, dead: false };
    this.spawned++;
    this.slots.add(slot);
    worker.on(
      'message',
      (msg: { ok: boolean; facts?: MarkdownFact[]; error?: string }) => {
        const job = slot.job;
        if (!job || slot.dead) return;
        this.finish(slot);
        if (msg.ok && Array.isArray(msg.facts)) job.resolve(msg.facts);
        else job.reject(new PoolFailure('FAILED', msg.error ?? 'worker error'));
        this.next(slot);
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
      void this.kill(slot, 'TIMEOUT', `no answer in ${this.opts.timeoutMs} ms`);
    }, this.opts.timeoutMs);
    try {
      slot.worker.postMessage({ id: 0, md: job.md });
    } catch (e) {
      void this.kill(slot, 'FAILED', e instanceof Error ? e.message : 'post');
    }
  }

  private finish(slot: Slot): void {
    if (slot.timer) clearTimeout(slot.timer);
    slot.timer = undefined;
    slot.job = undefined;
  }

  /** Slot became free: hand it the next queued job, if any. */
  private next(slot: Slot): void {
    if (slot.dead || this.closed) return;
    const job = this.queue.shift();
    if (job) this.dispatch(slot, job);
  }

  /** Removes and terminates a worker; fails its running job; refills from the queue. */
  private async kill(
    slot: Slot,
    kind: PoolFailureKind,
    detail?: string,
  ): Promise<void> {
    if (slot.dead) return;
    slot.dead = true;
    this.slots.delete(slot);
    const job = slot.job;
    this.finish(slot);
    job?.reject(new PoolFailure(kind, detail));
    this.terminated++;
    await slot.worker.terminate().catch(() => undefined);
    // A queued job must not starve because its worker died.
    if (!this.closed) {
      const waiting = this.queue.shift();
      if (waiting) this.dispatch(this.spawn(), waiting);
    }
  }
}
