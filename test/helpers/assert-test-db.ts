import { assertThrowawayUrl } from './test-db.js';

// Story 20.5: every e2e file starts only if its connection string is a throw-away database.
assertThrowawayUrl(process.env.DATABASE_URL, 'DATABASE_URL');
if (process.env.MIGRATE_DATABASE_URL) {
  assertThrowawayUrl(process.env.MIGRATE_DATABASE_URL, 'MIGRATE_DATABASE_URL');
}
