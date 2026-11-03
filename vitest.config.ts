import { configDefaults, defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  // Resolves the path aliases declared in tsconfig.json, including the ones
  // added by `nest g library`.
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['**/*.spec.ts'],
    // Story 19.3b: `pnpm test` is correctness only; time budgets live in
    // `*.perf.spec.ts` (run them with `pnpm test:perf`).
    exclude: [...configDefaults.exclude, '**/*.perf.spec.ts'],
  },
});
