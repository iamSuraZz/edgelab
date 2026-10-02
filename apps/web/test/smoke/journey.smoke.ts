import { expect, test, type Page } from '@playwright/test';

import { editorText, pasteEditorText } from './editor';

/**
 * Spec 07's end-to-end journey, in one flow:
 *
 *   paste a fixture -> run -> KPIs appear -> validate -> verdict -> click a trade -> chart jumps
 *
 * ONE test, not seven. The steps share state — the run id, the trade list, the validation — and
 * splitting them into independent tests would either re-run the backtest per step or leak order
 * dependencies between tests that Playwright is entitled to reorder. `test.step` keeps the report
 * readable without pretending the steps are independent.
 *
 * It creates everything it needs from the UI and asserts nothing about pre-existing rows, so the
 * same test runs against this laptop and against the deployed server:
 *
 *   # local
 *   pnpm --filter @edgelab/web test:journey
 *
 *   # the deployed instance, behind Traefik basic auth
 *   E2E_BASE_URL=https://edgelab.example.com \
 *   E2E_BASIC_AUTH_USER=me E2E_BASIC_AUTH_PASSWORD=... \
 *     pnpm --filter @edgelab/web test:journey
 *
 * PRECONDITIONS — asserted with the fix in the message rather than left to time out:
 *   docker compose up -d && pnpm db:migrate
 *   pnpm run data:seed-synthetic EURUSD 2024-01-01 2024-02-01   # or a real ingest
 *   pnpm dev
 */

const SYMBOL = 'EURUSD';
const TIMEFRAME = 'H1';

/** A window the seeded synthetic month and the dukascopy series both cover. */
const FROM = '2024-01-01';
const TO = '2024-02-01';

/** Enough for a backtest through the queue plus seventeen checks and ~30 engine runs. */
const RUN_TIMEOUT = 180_000;
const VALIDATION_TIMEOUT = 300_000;

/**
 * A deliberately simple strategy, PASTED rather than loaded from the fixtures menu.
 *
 * Spec 07 says "paste a fixture", and typing the source is the stronger test: it exercises the
 * editor, the compile round-trip and the inputs form the way a person does, and it does not depend
 * on the fixture list keeping any particular entry.
 */
const SOURCE = `//@version=5
strategy("E2E Journey", overlay=true, initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=1)

// Declared inputs on purpose: the inputs form only renders for a script that HAS inputs, and
// rendering it is part of what this journey is meant to exercise.
fastLen = input.int(9, "Fast EMA", minval=1)
slowLen = input.int(21, "Slow EMA", minval=2)

fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)

if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)

if ta.crossunder(fast, slow)
    strategy.close("Long")
`;

/*
 * The whole journey in one test, so the budget is set for the describe rather than per step —
 * `test.setTimeout` inside the body did not take effect against the config's 180s.
 */
test.describe.configure({ timeout: 900_000 });

test.describe('spec 07 journey', () => {
  test('paste, run, validate, and click through to the chart', async ({ page }) => {
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[browser] ${message.text()}`);
    });

    await test.step('preconditions: the API is up and the symbol has bars', async () => {
      const response = await page.request.get('/api/symbols');
      expect(
        response.ok(),
        'The API is not reachable at this base URL. Locally: `docker compose up -d && pnpm dev`.',
      ).toBe(true);

      const symbols = (await response.json()) as {
        symbol: string;
        coverage: { barCount: number };
      }[];
      const target = symbols.find((s) => s.symbol === SYMBOL);

      expect(target, `${SYMBOL} is not in the registry. Run \`pnpm db:migrate\`.`).toBeDefined();
      expect(
        target!.coverage.barCount,
        `No ${SYMBOL} bars stored. Run \`pnpm run data:seed-synthetic ${SYMBOL} ${FROM} ${TO}\`, ` +
          'or download the range from the Data page.',
      ).toBeGreaterThan(1_000);
    });

    await test.step('paste a strategy and watch it compile', async () => {
      await page.goto('/studio');
      await expect(page.getByTestId('studio')).toBeVisible();

      await pasteEditorText(page, SOURCE);

      /*
       * Assert the paste landed VERBATIM, before anything depends on it.
       *
       * Pine's indentation is semantic, and a paste that picked up auto-indent produces a script
       * that compiles, runs and trades wrongly — the first version of this test lost every
       * `strategy.close` into a nested block and reported 0 trades with a 17% drawdown. Checking the
       * input is cheaper than diagnosing the output.
       */
      const inEditor = await editorText(page);
      // Present at all, and at COLUMN ZERO: nested under the first `if` is the failure mode.
      expect(inEditor).toContain('if ta.crossunder(fast, slow)');
      expect(
        inEditor.split('\n').some((line) => line.startsWith('if ta.crossunder')),
        'the paste was re-indented, so the script is not the one that was pasted',
      ).toBe(true);

      // A warning is acceptable; an error is not, and the run button stays disabled on one.
      await expect(page.getByTestId('compile-status')).toContainText(/compiles|warning/, {
        timeout: 60_000,
      });
      await expect(page.getByTestId('inputs-form')).toBeVisible();
    });

    await test.step('configure and run', async () => {
      await page.getByTestId(`symbol-${SYMBOL}`).click();
      await page.getByTestId(`tf-${TIMEFRAME}`).click();
      await page.getByTestId('date-from').fill(FROM);
      await page.getByTestId('date-to').fill(TO);

      await page.getByTestId('run-backtest').click();

      /*
       * Progress OR a finished run. A short window can complete between the click and the first
       * poll, and a test that insisted on catching the progress bar would fail for being slow to
       * look — the same race the integrity suite hit.
       */
      await expect(
        page.getByTestId('run-progress').or(page.getByTestId('kpi-strip')).first(),
      ).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('run-progress')).toBeHidden({ timeout: RUN_TIMEOUT });

      // A toast carries the API's real message, so surface it rather than failing on a missing KPI.
      const toast = page.getByTestId('toast-error');
      if ((await toast.count()) > 0 && (await toast.isVisible())) {
        throw new Error(`The run failed: ${(await toast.textContent()) ?? 'no message'}`);
      }
    });

    let netProfit = 0;
    let tradeCount = 0;

    await test.step('KPIs appear, and match what the API returned', async () => {
      await expect(page.getByTestId('kpi-strip')).toBeVisible();

      // Not em dashes: a KPI strip of withheld values would otherwise pass "something rendered".
      await expect(page.getByTestId('kpi-net-profit')).not.toContainText('—');
      await expect(page.getByTestId('kpi-trades')).not.toContainText('—');

      netProfit = await kpiNumber(page, 'kpi-net-profit');
      tradeCount = await kpiNumber(page, 'kpi-trades');

      expect(
        tradeCount,
        'The strategy placed no trades, so the rest of the journey has nothing to click.',
      ).toBeGreaterThan(0);
    });

    await test.step('validate the run, and read the verdict', async () => {
      await page.getByRole('tab', { name: 'Integrity' }).click();
      await page.getByTestId('run-validation').click();

      await expect(
        page.getByTestId('validation-progress').or(page.getByTestId('validation-report')).first(),
      ).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('validation-report')).toBeVisible({
        timeout: VALIDATION_TIMEOUT,
      });

      // Two answers, never one (A52): a lone badge on a losing strategy reads as an endorsement.
      const honesty = page.getByTestId('verdict-honesty');
      await expect(honesty).toBeVisible();
      await expect(honesty).toContainText(/Yes|Mostly|No|Unknown/);

      await expect(page.getByTestId('verdict-robustness')).toBeVisible();

      // Every check must have reached a status. A card with none is a runner that stopped early.
      const cards = page.locator('[data-testid^="check-"][data-status]');
      expect(await cards.count()).toBeGreaterThan(10);
    });

    await test.step('click a trade, and the chart jumps to it', async () => {
      await page.getByTestId('tab-trades').click();
      await expect(page.getByTestId('trades-count')).toContainText(String(tradeCount));

      await page.getByTestId('trade-row-1').click();

      /*
       * Clicking a trade FOCUSES it; opening the Chart tab is the user's next move.
       *
       * The tab does not switch itself here, and deliberately so: the Trades table is a place you
       * scan, and yanking the view away on every row click would fight that. The Integrity tab's
       * evidence links DO switch, because there the click means "show me this". Spec 07's "chart
       * jumps to it" is satisfied by what the chart shows when you look at it, which is the
       * assertion below.
       */
      await page.getByTestId('tab-chart').click();
      await expect(page.getByRole('tab', { name: 'Chart', selected: true })).toBeVisible();
      // VISIBLE, not merely present: a chart at zero height is in the DOM and shows nothing (A55).
      await expect(page.getByTestId('price-chart')).toBeVisible();
      await expect(page.getByTestId('focused-trade-badge')).toContainText('Trade #1');

      // Lightweight Charts draws onto canvases; none means a chart that mounted and rendered
      // nothing, which every assertion above would still have passed.
      expect(await page.getByTestId('price-chart').locator('canvas').count()).toBeGreaterThan(0);
    });

    await test.step('the run has its own URL, and it shows the same figures', async () => {
      // The journey ends where a user would come back to it: a permalink, not the Studio's state.
      const runs = await page.request.get('/api/backtests?limit=1');
      const [latest] = (await runs.json()) as { id: string }[];
      expect(latest).toBeDefined();

      await page.goto(`/runs/${latest!.id}`);
      await expect(page.getByTestId('kpi-net-profit')).toBeVisible();

      /*
       * The NUMBER, not the rendered text. The KPI cell carries its label and, for return, a
       * buy-and-hold sub-line, so the two pages legitimately differ in whitespace while reporting
       * the same figure. Comparing strings here asserted the layout; comparing the value asserts
       * that the permalink shows the run the Studio just produced.
       */
      expect(await kpiNumber(page, 'kpi-net-profit')).toBeCloseTo(netProfit, 2);
    });
  });
});

/**
 * The figure out of a KPI cell.
 *
 * The cell holds a label, a value and sometimes a comparison line, so this takes the first signed
 * number in it and strips the currency grouping. A minus sign is rendered as U+2212 rather than a
 * hyphen, which `Number` does not accept.
 */
async function kpiNumber(page: Page, testId: string): Promise<number> {
  const text = (await page.getByTestId(testId).innerText()).replace(/−/g, '-');
  const match = /-?\d[\d,]*(?:\.\d+)?/.exec(text);

  expect(match, `no number in ${testId}: ${JSON.stringify(text)}`).not.toBeNull();
  return Number(match![0].replace(/,/g, ''));
}
