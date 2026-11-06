import { defineConfig } from '@playwright/test';

import { E2E } from './e2e/env';

/**
 * End-to-end tests against the real API (e2e/start-api.ts) and the built
 * PWA served by `vite preview`, which proxies /api to it, in Chrome.
 * Needs Postgres at TEST_DATABASE_URL (default: docker compose's, port 5433).
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${E2E.appPort}`,
    channel: process.env.PLAYWRIGHT_CHANNEL ?? 'chrome',
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'allow',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx e2e/start-api.ts',
      url: `http://localhost:${E2E.apiPort}/health`,
      timeout: 120_000,
      reuseExistingServer: false,
      gracefulShutdown: { signal: 'SIGTERM', timeout: 10_000 },
      stdout: 'pipe',
    },
    {
      command: `npm run build && npx vite preview --port ${E2E.appPort} --strictPort`,
      url: `http://localhost:${E2E.appPort}`,
      timeout: 120_000,
      reuseExistingServer: false,
      env: { FARMLEDGE_API_URL: `http://localhost:${E2E.apiPort}` },
    },
  ],
});
