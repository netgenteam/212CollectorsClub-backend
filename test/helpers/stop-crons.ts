import type { INestApplication } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';

/**
 * Story 20.7 round 3: `AppModule` registers every real `@Cron` when the app starts, so an e2e that calls a
 * cron's method directly (`runTimeoutCheck`) could also see the real tick run on the same rows ("ordersFailed
 * is 0, not 1"). Stops every registered job right after `app.init()`; the suites that test the schedule itself
 * (retention, TCG nightly sync) do not call this.
 */
export function stopAllCrons(app: INestApplication): void {
  const registry = app.get(SchedulerRegistry);
  for (const job of registry.getCronJobs().values()) void job.stop();
}
