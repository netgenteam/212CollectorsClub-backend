import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import { generateIdDocTestEnv } from './test/helpers/iddoc-test-keys.js';

// Story 19.3b: PERFORMANCE assertions (time budgets, event-loop delay). They
// are only meaningful on a quiet machine, so one file at a time, one thread.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.perf.spec.ts'],
    // Story 20.2: run-time generated, throw-away ID document keys.
    env: generateIdDocTestEnv(),
    globalSetup: ['./test/helpers/global-audit-sandbox.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    pool: 'forks',
  },
});
