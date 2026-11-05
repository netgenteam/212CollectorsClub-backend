import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { generateIdDocTestEnv } from './test/helpers/iddoc-test-keys.js';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Story 19.4: the consent documents resolve to the SANDBOX slugs
    // (`e2e-terminos`, ...): no e2e ever publishes on a real, immutable document.
    env: { LEGAL_CONSENT_SLUG_PREFIX: 'e2e-', ...generateIdDocTestEnv() },
    setupFiles: [
      './test/helpers/assert-test-db.ts',
      // Story 20.7 round 4: no real `@Cron` ticks during the other suites (see the file).
      './test/helpers/stop-crons-global.ts',
    ],
    // Shared dev Postgres: specs mutate stock/orders, so files run serially (AD-48).
    fileParallelism: false,
    // Story 18.3: keep the real (possibly weeks-old) FX row usable by checkout.
    // Story 18.7: Product_Daily_Stats is restored exactly after the run.
    // Story 18.8: so are the four Vitrina scoring tables.
    globalSetup: [
      // Story 20.5: FIRST (torn down last). Clones the configured database into a
      // throw-away one and points the whole run at it: Audit_Events is immutable.
      './test/helpers/global-test-db.ts',
      './test/helpers/global-fx-fresh.ts',
      './test/helpers/global-daily-stats-snapshot.ts',
      './test/helpers/global-vitrina-snapshot.ts',
      // Story 18.12: legacy landing suites rewrite the real Home entries.
      './test/helpers/global-landing-snapshot.ts',
      // Story 19.4: orphaned (append-only) consent rows created by the run.
      './test/helpers/global-consent-orphans.ts',
      // Story 20.1: no audit_t_* sandbox schema outlives the run.
      './test/helpers/global-audit-sandbox.ts',
    ],
  },
});
