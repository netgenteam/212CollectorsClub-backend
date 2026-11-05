import dotenv from 'dotenv';

/**
 * Story 20.7 round 2: loads `.env` (the same file, from the same working directory, and with the same "an
 * already-set variable wins" rule as `ConfigModule.forRoot`) at the moment this module is IMPORTED.
 *
 * A `@Cron('<expression>')` decorator is evaluated when its class is defined, which happens while
 * `app.module.ts` imports its modules: BEFORE `ConfigModule.forRoot()` has run and before `.env` is in
 * `process.env`. A cron expression read from `process.env` there therefore saw only what the shell or systemd
 * had exported, and `USAGE_LOG_PURGE_CRON='0 5 6 * * *'` or `RETENTION_PURGE_CRON='15 2 * * *'` in a `.env`
 * file silently kept the default (checked with a test `.env`: the registered job still had `0 15 4 * * *` and
 * `30 4 * * *`). Import this FIRST in a file that reads such a variable at import time.
 */
dotenv.config({ quiet: true });
