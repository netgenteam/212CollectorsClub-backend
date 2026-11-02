import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    // Shared dev Postgres: specs mutate stock/orders, so files run serially (AD-48).
    fileParallelism: false,
    // Story 18.3: keep the real (possibly weeks-old) FX row usable by checkout.
    // Story 18.7: Product_Daily_Stats is restored exactly after the run.
    // Story 18.8: so are the four Vitrina scoring tables.
    globalSetup: [
      './test/helpers/global-fx-fresh.ts',
      './test/helpers/global-daily-stats-snapshot.ts',
      './test/helpers/global-vitrina-snapshot.ts',
    ],
  },
});
