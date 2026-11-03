import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

// Story 19.3b: PERFORMANCE assertions (time budgets, event-loop delay). They
// are only meaningful on a quiet machine, so one file at a time, one thread.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.perf.spec.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',
  },
});
