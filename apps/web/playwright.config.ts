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
/**
 * Where the tests point, and who they log in as.
 *
 * `E2E_BASE_URL` retargets the whole suite at a DEPLOYED instance — the point being that the
 * journey test is the same test whether it runs against Vite on this laptop or against the server
 * behind Traefik. A deployment that passes a different test from the one CI runs has not been
 * verified by CI.
 *
 * When it is set, Vite is NOT started: the app under test is already running somewhere else, and a
 * local dev server would quietly serve the assertions instead.
 */
const REMOTE_BASE_URL = process.env['E2E_BASE_URL'];
const LOCAL_BASE_URL = `http://localhost:${process.env['WEB_PORT'] ?? '5173'}`;

/**
 * Basic auth, as Traefik asks for it in production (spec 07).
 *
 * Playwright's `httpCredentials` answers the 401 challenge for every request including the SSE
 * stream, which a hand-written Authorization header on `page.goto` would not — the EventSource the
 * progress bar opens is a separate request and would be refused on its own.
 */
const BASIC_AUTH_USER = process.env['E2E_BASIC_AUTH_USER'];
const BASIC_AUTH_PASSWORD = process.env['E2E_BASIC_AUTH_PASSWORD'];

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
    baseURL: REMOTE_BASE_URL ?? LOCAL_BASE_URL,
    ...(BASIC_AUTH_USER === undefined || BASIC_AUTH_PASSWORD === undefined
      ? {}
      : {
          httpCredentials: {
            username: BASIC_AUTH_USER,
            password: BASIC_AUTH_PASSWORD,
          },
        }),
    // A deployed instance is reached over TLS that Traefik terminates; a staging certificate
    // should fail loudly rather than be waved through, so this is NOT relaxed.
    ignoreHTTPSErrors: false,
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
  // Omitted entirely when targeting a deployed instance: there is nothing local to start, and
  // starting Vite anyway would serve the tests from the wrong build.
  ...(REMOTE_BASE_URL === undefined
    ? {
        webServer: {
          command: 'pnpm --filter @edgelab/web dev',
          cwd: repoRoot,
          url: LOCAL_BASE_URL,
          reuseExistingServer: true,
          timeout: 120_000,
        },
      }
    : {}),
});
