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
  },
});
