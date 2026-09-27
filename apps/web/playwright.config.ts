import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/**
 * Playwright config for the Studio smoke test.
 *
 * Starts the Vite dev server itself but NOT the API or the worker: those need TimescaleDB and
 * Redis, and a browser test that silently booted a database would hide the one precondition worth
 * being loud about. Bring them up first:
 *
 *   docker compose up -d && pnpm db:migrate
 *   pnpm dev                      # API + worker + web
 *   pnpm --filter @edgelab/web test:smoke
 *
 * The smoke test checks its own preconditions and fails with that instruction rather than a
 * timeout, so a missing stack is diagnosable from the failure alone.
 */
export default defineConfig({
  testDir: './test/smoke',
  testMatch: '**/*.smoke.ts',
  // A real backtest over a month of H1 goes through the queue and a piscina thread; the default
  // 30s is not enough for a cold first run.
  timeout: 180_000,
  expect: { timeout: 20_000 },
  // One worker: the tests share one API, one queue and one database.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${process.env['WEB_PORT'] ?? '5173'}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    // Wide enough that the three panes are all usable, so a layout-dependent selector is not
    // fighting a collapsed column.
    viewport: { width: 1600, height: 1000 },
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        /**
         * Escape hatch for a machine where `npx playwright install` cannot place its own browser —
         * on Windows, antivirus routinely quarantines `chrome-headless-shell.exe` mid-extraction,
         * leaving the directory present but empty. Point this at any working Chromium:
         *
         *   PLAYWRIGHT_CHROMIUM_PATH="…/ms-playwright/chromium-1243/chrome-win64/chrome.exe"
         *
         * Unset on a healthy machine, where Playwright resolves its own download.
         */
        ...(process.env['PLAYWRIGHT_CHROMIUM_PATH'] === undefined
          ? {}
          : { launchOptions: { executablePath: process.env['PLAYWRIGHT_CHROMIUM_PATH'] } }),
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @edgelab/web dev',
    cwd: repoRoot,
    url: `http://localhost:${process.env['WEB_PORT'] ?? '5173'}`,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
