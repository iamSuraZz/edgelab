import { expect, test, type Page } from '@playwright/test';

/**
 * The slice-C smoke test: load a fixture → run EURUSD H1 for January 2024 → KPIs visible → click a
 * trade → the chart scrolls to it.
 *
 * It also checks that the KPIs ON SCREEN match what the API returned, which is the assertion with
 * teeth. "A number appeared" would pass just as happily against a formatting bug that dropped a
 * decimal place or rendered null as 0.
 *
 * PRECONDITIONS — the test fails with this instruction rather than a timeout if they are missing:
 *   docker compose up -d && pnpm db:migrate
 *   pnpm ingest EURUSD dukascopy 2024-01-01 2024-02-01
 *   pnpm dev
 */

const SYMBOL = 'EURUSD';
const TIMEFRAME = 'H1';

test.describe('Studio', () => {
  test.beforeEach(async ({ page }) => {
    // A persisted store from a previous session would otherwise decide which fixture is loaded
    // and which range is set, making the run non-deterministic.
    //
    // Clear ONCE per test, not on every document. `addInitScript` re-runs on `page.reload()`, so
    // an unguarded clear wipes the very state a test set up before reloading — which is how the
    // no-data test ended up pressing Run with an empty editor and getting "Nothing to run"
    // instead of the API's message. The sentinel lives in sessionStorage, which survives a
    // reload but not a new context, so each test still starts clean.
    await page.addInitScript(() => {
      if (window.sessionStorage.getItem('smoke:cleared') === null) {
        window.localStorage.clear();
        window.sessionStorage.setItem('smoke:cleared', '1');
      }
    });

    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[browser] ${message.text()}`);
    });

    await page.goto('/studio');
    await expect(page.getByTestId('studio')).toBeVisible();
  });

  test('preconditions: the API is up and EURUSD has stored bars', async ({ page }) => {
    const symbols = await page.request.get('/api/symbols');
    expect(
      symbols.ok(),
      'The API is not reachable. Run `docker compose up -d && pnpm db:migrate` then `pnpm dev`.',
    ).toBe(true);

    const body = (await symbols.json()) as { symbol: string; coverage: { barCount: number } }[];
    const eurusd = body.find((s) => s.symbol === SYMBOL);

    expect(eurusd, `${SYMBOL} is not seeded. Run \`pnpm db:migrate\`.`).toBeDefined();
    expect(
      eurusd!.coverage.barCount,
      `No ${SYMBOL} bars stored. Run \`pnpm ingest ${SYMBOL} dukascopy 2024-01-01 2024-02-01\`.`,
    ).toBeGreaterThan(10_000);
  });

  test('load a fixture, run it, read the KPIs, click a trade and land on the chart', async ({
    page,
  }) => {
    /* ---------------------------------------------------- 1. load a fixture */

    await page.getByTestId('fixtures-menu').click();
    await page.getByTestId('fixture-ema-cross').click();

    // The compile round trip has to finish before Run is enabled, and its badge is the signal.
    await expect(page.getByTestId('compile-status')).toContainText(/compiles|warning/, {
      timeout: 30_000,
    });

    // The Inputs form is generated from the script's own InputSpec list, so its presence proves
    // the compile response carried inputs through.
    await expect(page.getByTestId('inputs-form')).toBeVisible();

    /* ------------------------------------------------ 2. configure the run */

    await page.getByTestId(`symbol-${SYMBOL}`).click();
    await page.getByTestId(`tf-${TIMEFRAME}`).click();
    await page.getByTestId('date-from').fill('2024-01-01');
    await page.getByTestId('date-to').fill('2024-02-01');

    /* -------------------------------------------------------------- 3. run */

    await page.getByTestId('run-backtest').click();

    // Progress must actually appear: it is the proof that the SSE bridge out of the piscina
    // thread reaches the browser.
    await expect(page.getByTestId('run-progress')).toBeVisible({ timeout: 30_000 });

    // Then it must go away, which only happens on the server's explicit `end` frame.
    await expect(page.getByTestId('run-progress')).toBeHidden({ timeout: 150_000 });

    // A failure toast carries the API's real message; surfacing it here turns an opaque
    // assertion failure into a diagnosis.
    const errorToast = page.getByTestId('toast-error');
    if (await errorToast.isVisible().catch(() => false)) {
      throw new Error(`The run failed: ${await errorToast.innerText()}`);
    }

    /* --------------------------------------------------------- 4. the KPIs */

    const kpis = page.getByTestId('kpi-strip');
    await expect(kpis).toBeVisible({ timeout: 60_000 });

    await expect(page.getByTestId('kpi-net-profit')).not.toContainText('—');
    await expect(page.getByTestId('kpi-trades')).not.toContainText('—');

    /* ------------------------ 5. the KPIs on screen match what the API says */

    const runId = await currentRunId(page);
    const apiRun = (await (await page.request.get(`/api/backtests/${runId}`)).json()) as {
      state: string;
      kpis: { netProfit: number; closedTrades: number; totalReturnPct: number };
      crossCheck: { ok: boolean };
    };

    expect(apiRun.state).toBe('completed');
    expect(apiRun.crossCheck.ok, 'the zero-cost cross-check must pass').toBe(true);

    // Compare the rendered text against the same value formatted the way the UI formats it, so a
    // regression in the formatter is caught rather than papered over by a loose regex.
    const netProfitText = (await page.getByTestId('kpi-net-profit').innerText()).trim();
    expect(netProfitText).toContain(expectedCurrency(apiRun.kpis.netProfit));

    const tradesText = (await page.getByTestId('kpi-trades').innerText()).trim();
    expect(tradesText).toContain(String(apiRun.kpis.closedTrades));

    /* ------------------------------------------------------- 6. the trades */

    await page.getByTestId('tab-trades').click();
    await expect(page.getByTestId('trades-count')).toContainText(
      `${String(apiRun.kpis.closedTrades)} trades`,
    );

    const firstRow = page.getByTestId('trade-row-1');
    await expect(firstRow).toBeVisible();
    await firstRow.click();

    /* ------------- 7. the chart follows the trade the user clicked */

    await page.getByTestId('tab-chart').click();
    await expect(page.getByTestId('price-chart')).toBeVisible();

    // The badge is the observable proof that the chart is showing THAT trade: the canvas itself
    // cannot be asserted on from the DOM, so the focused-trade state is what gets checked.
    await expect(page.getByTestId('focused-trade-badge')).toContainText('Trade #1');

    // A canvas must actually have been painted — an empty chart container would otherwise pass.
    const canvasCount = await page.getByTestId('price-chart').locator('canvas').count();
    expect(canvasCount).toBeGreaterThan(0);
  });

  /**
   * The UI refuses to ask for data it knows is not there.
   *
   * This test used to set an out-of-coverage range through the store and assert the API's
   * "No EURUSD data ..." message in a toast. It cannot: the range clamp now runs on store
   * HYDRATION as well as on the inputs, so 2030 is pulled back inside coverage and the run
   * simply succeeds. Verified against the database — the submitted range came out as
   * 2024-01-31 .. 2024-01-31, completed, no error.
   *
   * That is the better behaviour, and it means no UI path can produce a no-data run for a symbol
   * that has data. So this asserts the clamp, and the API's real-message path stays covered where
   * it can actually be exercised: `pnpm test:e2e` → "says which data is missing, not just
   * 'bad request'".
   */
  test('clamps a stale out-of-coverage range back inside stored data', async ({ page }) => {
    await page.getByTestId('fixtures-menu').click();
    await page.getByTestId('fixture-ema-cross').click();
    await expect(page.getByTestId('compile-status')).toContainText(/compiles|warning/, {
      timeout: 30_000,
    });

    // A range from a persisted session that the stored data no longer covers.
    await page.evaluate(() => {
      const raw = window.localStorage.getItem('edgelab.studio');
      const parsed = JSON.parse(raw ?? '{"state":{},"version":0}') as {
        state: Record<string, unknown>;
      };
      const settings = (parsed.state['settings'] ?? {}) as Record<string, unknown>;
      parsed.state['settings'] = {
        ...settings,
        fromMs: Date.UTC(2030, 0, 1),
        toMs: Date.UTC(2030, 1, 1),
      };
      window.localStorage.setItem('edgelab.studio', JSON.stringify(parsed));
    });
    await page.reload();
    await expect(page.getByTestId('studio')).toBeVisible();

    // Clamped, not carried through: the dates on screen are the stored ones, never 2030.
    const from = page.getByTestId('date-from');
    const to = page.getByTestId('date-to');
    await expect(from).toBeVisible();
    await expect(from).toHaveValue(/^2024-/);
    await expect(to).toHaveValue(/^2024-/);
  });

  test('the editor reports compile errors inline without failing the request', async ({ page }) => {
    await page.getByTestId('fixtures-menu').click();
    await page.getByTestId('fixture-ema-cross').click();
    await expect(page.getByTestId('compile-status')).toContainText(/compiles|warning/, {
      timeout: 30_000,
    });

    await setEditorText(page, '//@version=5\nstrategy("x"\n@@@\n');

    await expect(page.getByTestId('compile-status')).toContainText('error', { timeout: 30_000 });
    await expect(page.getByTestId('compatibility-panel')).toBeVisible();
    // Run must be unavailable while the script cannot compile.
    await expect(page.getByTestId('run-backtest')).toBeDisabled();
  });
});

/** The run id, taken from the store the page actually uses. */
async function currentRunId(page: Page): Promise<string> {
  const runId = await page.evaluate(() => {
    const raw = window.localStorage.getItem('edgelab.studio');
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as { state?: { lastRunId?: string | null } };
    return parsed.state?.lastRunId ?? null;
  });
  expect(runId, 'the page should have recorded a completed run id').toBeTruthy();
  return runId!;
}

/** Mirrors `formatCurrency` for USD: an explicit sign, a symbol, two decimals, grouped. */
function expectedCurrency(value: number): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  const abs = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${sign}$${abs}`;
}

/**
 * Replace the editor's contents.
 *
 * Monaco's textarea is an invisible input proxy, so Playwright's  either hangs waiting
 * for it to be editable or silently writes nowhere. Clicking into the editor and driving it with
 * select-all + keyboard is the interaction a person actually performs.
 */
async function setEditorText(page: Page, text: string): Promise<void> {
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}
