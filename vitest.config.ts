import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Each suite creates and drops its own database, so DB-backed tests need
    // more headroom than the 5s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
