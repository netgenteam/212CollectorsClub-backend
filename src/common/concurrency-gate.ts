/**
 * Story 20.7 round 2: at most `limit` calls run at once and at most `maxWaiting` wait for a turn, each for
 * at most `waitMs`; anything beyond that is refused (`GateRejected`) at once. A heavy endpoint behind it
 * (the admin's usage log query: 30 concurrent heavy queries used the whole pool of ten connections and
 * `GET /categories` took ~3 s) can never hold more than `limit` connections, whoever calls it.
 */
export class GateRejected extends Error {}

export class ConcurrencyGate {
  private active = 0;
  private readonly waiting: { go: () => void; timer: NodeJS.Timeout }[] = [];

  constructor(
    private readonly limit: number,
    private readonly maxWaiting: number,
    private readonly waitMs: number,
  ) {}

  get running(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxWaiting) {
        throw new GateRejected('too many concurrent calls');
      }
      await new Promise<void>((resolve, reject) => {
        const entry = {
          go: () => {
            clearTimeout(entry.timer);
            resolve();
          },
          timer: setTimeout(() => {
            const i = this.waiting.indexOf(entry);
            if (i >= 0) this.waiting.splice(i, 1);
            reject(new GateRejected('waited too long for a turn'));
          }, this.waitMs),
        };
        this.waiting.push(entry);
      });
      // the slot was handed over by `release`: `active` was not decremented
    } else {
      this.active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      if (next)
        next.go(); // hand the slot to the next one in line
      else this.active -= 1;
    }
  }
}
