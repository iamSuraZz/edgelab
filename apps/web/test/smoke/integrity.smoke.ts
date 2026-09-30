import { expect, test, type Page } from '@playwright/test';

/**
 * Slice D's DONE WHEN, in a browser: open a run, validate it, read the verdict, click a piece of
 * evidence, and watch the chart jump to it.
 *
 * The run under test is the LEAKY fixture, chosen because a passing run cannot prove any of this.
 * A leak-free run shows an empty evidence list, and a verdict header that says "Yes" is equally
 * consistent with a tab that renders nothing at all.
 *
 * The evidence clicked is the causality check's first peek, which on this fixture lands on BAR 0
 * — a bar with no trade on it. That is the case A53 was written for: look-ahead evidence names
 * bars, and resolving a bar through a trade left the most important evidence unclickable.
 *
 * PRECONDITIONS — the test fails with this instruction rather than a timeout if they are missing:
 *   docker compose up -d && pnpm db:migrate
 *   pnpm ingest EURUSD dukascopy 2022-01-01 2022-07-01
 *   pnpm dev
 *   pnpm backtest --fixture lookahead-leak --symbol EURUSD --tf H1 \
 *     --from 2022-01-01 --to 2022-07-01
 */

/** Long enough for seventeen checks and ~30 engine runs over six months of H1. */
const VALIDATION_TIMEOUT = 240_000;

interface RunSummary {
  readonly id: string;
  readonly strategyName: string;
  readonly state: string;
}

async function findLeakyRun(page: Page): Promise<string> {
  const response = await page.request.get('/api/backtests');
  expect(
    response.ok(),
    'The API is not reachable. Run `docker compose up -d && pnpm db:migrate` then `pnpm dev`.',
  ).toBe(true);

  const runs = (await response.json()) as RunSummary[];
  const leaky = runs.find(
    (r) => r.state === 'completed' && /look-?ahead leak/i.test(r.strategyName),
  );

  expect(
    leaky,
    'No completed look-ahead-leak run. Run:\n' +
      '  pnpm backtest --fixture lookahead-leak --symbol EURUSD --tf H1 ' +
      '--from 2022-01-01 --to 2022-07-01',
  ).toBeDefined();

  return leaky!.id;
}

/**
 * Waits for a report, validating only if this run has never been validated.
 *
 * Deliberately does NOT press Validate when one already exists. The button is always on screen —
 * it reads "Validate again" once there is a result — so a helper that pressed it unconditionally
 * queued a fresh run per test, and validation and optimisation share one queue at concurrency 1
 * (A50), so those runs serialised behind each other until the tests timed out.
 */
async function ensureValidated(page: Page): Promise<void> {
  const report = page.getByTestId('validation-report');

  try {
    await report.waitFor({ state: 'visible', timeout: 20_000 });
    return;
  } catch {
    // None stored yet — fall through and run one.
  }

  await page.getByTestId('run-validation').click();
  await expect(report).toBeVisible({ timeout: VALIDATION_TIMEOUT });
}

test.describe('Integrity & Overfitting', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[browser] ${message.text()}`);
    });
  });

  /**
   * The DONE WHEN path itself: a validation STARTED from the browser, not one loaded from the
   * database. The other tests reuse whatever this leaves behind, because re-running the suite per
   * test would serialise four jobs through a queue of concurrency 1 for no extra coverage.
   */
  test('validating from the browser produces a verdict that answers both questions', async ({
    page,
  }) => {
    const runId = await findLeakyRun(page);
    await page.goto(`/runs/${runId}`);
    await page.getByRole('tab', { name: 'Integrity' }).click();

    await page.getByTestId('run-validation').click();

    // Progress OR the finished report: a run this size can complete inside the poll interval, and
    // a test that insisted on catching the spinner would fail for being too slow to look.
    // `.first()` because the PREVIOUS report stays on screen while the new run works — both match,
    // and an `or()` that resolves to two elements is a strict-mode violation, not a pass.
    await expect(
      page.getByTestId('validation-progress').or(page.getByTestId('validation-report')).first(),
    ).toBeVisible();
    await expect(page.getByTestId('validation-report')).toBeVisible({
      timeout: VALIDATION_TIMEOUT,
    });

    // Two answers, never one (A52). A single badge on a losing strategy reads as an endorsement.
    const honesty = page.getByTestId('verdict-honesty');
    await expect(honesty).toBeVisible();
    await expect(honesty).toContainText(/No/);

    const robustness = page.getByTestId('verdict-robustness');
    await expect(robustness).toBeVisible();
    // Counts only. A combined robustness score is exactly what A52 refuses to compute.
    await expect(robustness).not.toContainText(/^(Yes|No|Mostly)$/);
  });

  test('the static lint names the line, and the splice names the first divergent bar', async ({
    page,
  }) => {
    const runId = await findLeakyRun(page);
    await page.goto(`/runs/${runId}`);
    await page.getByRole('tab', { name: 'Integrity' }).click();
    await ensureValidated(page);

    const lint = page.getByTestId('check-lookahead-static');
    await expect(lint).toHaveAttribute('data-status', 'fail');
    await expect(lint).toContainText('Line 8');
    await expect(lint).toContainText(/lookahead_on/);

    const splice = page.getByTestId('check-lookahead-future-splice');
    await expect(splice).toHaveAttribute('data-status', 'fail');
    // Already expanded: a failing check opens itself, because evidence nobody clicks is evidence
    // nobody reads.
    await expect(splice.getByTestId('jump-time')).toContainText('2022-04-14');
  });

  test('clicking the first divergent bar jumps the chart to it', async ({ page }) => {
    const runId = await findLeakyRun(page);
    await page.goto(`/runs/${runId}`);
    await page.getByRole('tab', { name: 'Integrity' }).click();
    await ensureValidated(page);

    // Bar 0 on this fixture — a bar with NO TRADE on it, which is the whole reason the chart's
    // focus is a time rather than a trade (A53).
    const causality = page.getByTestId('check-lookahead-causality');
    await expect(causality).toHaveAttribute('data-status', 'fail');

    const jump = causality.getByTestId('jump-time').first();
    await expect(jump).toContainText('2022-01-02');
    await jump.click();

    // The jump switches tabs itself: evidence that needs the reader to find the chart is a
    // reference, not a jump.
    await expect(page.getByRole('tab', { name: 'Chart', selected: true })).toBeVisible();
    await expect(page.getByTestId('price-chart')).toBeVisible();

    // The instant is snapped to the bar containing it, and the chart says which bar that is.
    // The note names the bar the marker sits on, which is how "the chart moved" becomes "the chart
    // is showing the bar the evidence named" — the marker itself is a line on a canvas.
    const note = page.getByTestId('focus-note');
    await expect(note).toBeVisible();
    await expect(note).toContainText(/2022-01-0[23]/);
  });

  test('a check with a visual renders it above the raw evidence', async ({ page }) => {
    const runId = await findLeakyRun(page);
    await page.goto(`/runs/${runId}`);
    await page.getByRole('tab', { name: 'Integrity' }).click();
    await ensureValidated(page);

    const mc = page.getByTestId('check-overfitting-monte-carlo');
    await mc.getByTestId('check-overfitting-monte-carlo-toggle').click();

    const panel = page.getByTestId('monte-carlo-panel');
    await expect(panel).toBeVisible();

    // Both resamplings, because they answer different questions (A47, A48): the reshuffle cannot
    // move the final return, so a distribution of returns here would mean the wrong quantity was
    // shuffled.
    await expect(page.getByTestId('reshuffle-distribution')).toBeVisible();
    await expect(page.getByTestId('bootstrap-distribution')).toBeVisible();
    await expect(panel).toContainText(/size around/i);
  });
});
