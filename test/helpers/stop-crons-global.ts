import { CronJob } from 'cron';

/**
 * Story 20.7 round 4 (setup file of the e2e config): `AppModule` registers every real `@Cron` when an app starts,
 * and the 5-minute ones (stock-hold expiry, payment timeout, audit verify) could tick while a test of any other
 * suite runs on the same rows. Here no `CronJob` starts by itself in any e2e file (the jobs are still registered,
 * with their expression and time zone, so `SchedulerRegistry` still shows them and the tests call the methods
 * directly). The suites that test the schedule itself set `globalThis.__E2E_REAL_CRONS__ = true` at the top of
 * their file (`retention`, `tcg-nightly-sync`). `cron` is one instance (`@nestjs/schedule` and `RetentionService`
 * resolve the same `cron@4.4.0`), so patching the prototype reaches all of them.
 */
declare global {
  var __E2E_REAL_CRONS__: boolean | undefined;
}
// eslint-disable-next-line @typescript-eslint/unbound-method -- called back with the job as `this` below
const realStart = CronJob.prototype.start;
CronJob.prototype.start = function (this: CronJob): void {
  if (globalThis.__E2E_REAL_CRONS__) realStart.call(this);
};
