/**
 * Story 20.6a (second round): a bounded queue for best-effort background work that touches the
 * database or the network after the response was sent (a reset or verification token and its email).
 *
 * Without it every request started its own job: 30 concurrent `resend-verification` for ONE account
 * became 30 transactions queued on the same advisory lock, all holding a pooled connection while they
 * waited (`GET /categories` took 1.3 s). Here
 *   - at most `concurrency` jobs run at a time (so they never take more than a few of the pool's
 *     connections),
 *   - at most `maxQueued` wait; past that a job is dropped (the person can ask again, and the
 *     response never said it would be sent), and
 *   - a job with a `key` that is already queued or running is not started twice (a flood of requests for
 *     the same account yields one token and one email).
 * `run` never throws and never waits for the job.
 */
export type BackgroundOutcome = 'started' | 'queued' | 'duplicate' | 'dropped';

export class BackgroundQueue {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  private readonly keys = new Set<string>();
  droppedTotal = 0;

  constructor(
    private readonly concurrency = 3,
    private readonly maxQueued = 200,
  ) {}

  get pending(): number {
    return this.active + this.waiting.length;
  }

  run(key: string | null, job: () => Promise<void>): BackgroundOutcome {
    if (key !== null && this.keys.has(key)) return 'duplicate';
    if (
      this.active >= this.concurrency &&
      this.waiting.length >= this.maxQueued
    ) {
      this.droppedTotal += 1;
      return 'dropped';
    }
    if (key !== null) this.keys.add(key);
    const start = () => {
      this.active += 1;
      void Promise.resolve()
        .then(job)
        .catch(() => undefined)
        .finally(() => {
          this.active -= 1;
          if (key !== null) this.keys.delete(key);
          this.waiting.shift()?.();
        });
    };
    if (this.active < this.concurrency) {
      start();
      return 'started';
    }
    this.waiting.push(start);
    return 'queued';
  }
}
