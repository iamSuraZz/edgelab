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

/**
 * The leaky run, or null when this stack has none.
 *
 * Null rather than a failed assertion, so the suite SKIPS with its precondition named instead of
 * going red on a stack that has simply never had the fixture run against it — CI seeds one
 * synthetic month and never creates this run. A skip that says what is missing is honest; a green
 * suite that quietly asserted nothing would not be.
 */
async function findLeakyRun(page: Page): Promise<string | null> {
  // The list defaults to the 50 most recent, and an e2e run creates enough rows to push an older
  // fixture run off the end — which looks exactly like "no leaky run exists".
  const response = await page.request.get('/api/backtests?limit=500');
  expect(
    response.ok(),
    'The API is not reachable. Run `docker compose up -d && pnpm db:migrate` then `pnpm dev`.',
  ).toBe(true);

  const runs = (await response.json()) as RunSummary[];
  return (
    runs.find((r) => r.state === 'completed' && /look-?ahead leak/i.test(r.strategyName))?.id ??
    null
  );
}

/** The clean twin of the leaky fixture. Same logic, no leak. */
async function findCleanRun(page: Page): Promise<string | null> {
  const response = await page.request.get('/api/backtests?limit=500');
  expect(response.ok()).toBe(true);
  const runs = (await response.json()) as RunSummary[];
  return (
    runs.find((r) => r.state === 'completed' && /look-?ahead off/i.test(r.strategyName))?.id ?? null
  );
}

const NO_CLEAN_RUN =
  'no look-ahead-off run on this stack — create one with `pnpm backtest --fixture ' +
  'lookahead-off --symbol EURUSD --tf H1 --from 2022-01-01 --to 2022-07-01`';

const NO_RUN =
  'no look-ahead-leak run on this stack — create one with `pnpm backtest --fixture ' +
  'lookahead-leak --symbol EURUSD --tf H1 --from 2022-01-01 --to 2022-07-01`';

interface CheckView {
  readonly id: string;
  readonly status: string;
  readonly evidence: Record<string, number | string> | null;
}

/**
 * The report the tab is rendering.
 *
 * Assertions compare the SCREEN against the SOURCE rather than against dates written into this
 * file. Hardcoding `2022-04-14` would pin the test to one dataset and turn any other stack's
 * perfectly correct output into a failure, while proving nothing extra — the claim worth testing is
 * that the UI shows what the check found.
 */
async function reportFor(page: Page, runId: string): Promise<CheckView[]> {
  const list = await page.request.get(`/api/backtests/${runId}/validations`);
  const rows = (await list.json()) as { id: string; state: string }[];
  const completed = rows.find((r) => r.state === 'completed');
  if (completed === undefined) return [];

  const detail = await page.request.get(`/api/validations/${completed.id}`);
  const body = (await detail.json()) as { report: { results: CheckView[] } | null };
  return body.report?.results ?? [];
}

/** `2022-01-02T23:00:00.000Z` -> `2022-01-02 23:00`, the form an evidence row renders. */
function asShown(atMs: number): string {
  return new Date(atMs).toISOString().replace('T', ' ').slice(0, 16);
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
    test.skip(runId === null, NO_RUN);

    await page.goto(`/runs/${runId!}`);
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
    test.skip(runId === null, NO_RUN);

    await page.goto(`/runs/${runId!}`);
    await page.getByRole('tab', { name: 'Integrity' }).click();
    await ensureValidated(page);

    const results = await reportFor(page, runId!);
    const staticLint = results.find((c) => c.id === 'lookahead-static');
    const splice = results.find((c) => c.id === 'lookahead-future-splice');

    /*
     * The static lint is the one assertion here that is UNCONDITIONAL, because it reads the source
     * rather than the data: this fixture calls `request.security` with `lookahead_on` and no
     * offset, so it fails on any series, on any machine, with any number of bars.
     */
    const lintCard = page.getByTestId('check-lookahead-static');
    await expect(lintCard).toHaveAttribute('data-status', 'fail');
    // The LINE the check named, read back from the check rather than written in here.
    await expect(lintCard).toContainText(`Line ${String(staticLint?.evidence?.['firstLine'])}`);

    const spliceCard = page.getByTestId('check-lookahead-future-splice');
    await expect(spliceCard).toHaveAttribute('data-status', splice?.status ?? 'n/a');

    /*
     * The splice's own assertion is CONDITIONAL on it having found something.
     *
     * Unlike the lint it depends on the data: a short or quiet series can leave it with no
     * divergence to report, and demanding a date there would be asserting a property of the
     * fixture's bars rather than of the feature.
     */
    const divergedAtMs = splice?.evidence?.['divergedAtMs'];
    if (typeof divergedAtMs === 'number') {
      // Already expanded: a failing check opens itself, because evidence nobody clicks is evidence
      // nobody reads.
      await expect(spliceCard.getByTestId('jump-time')).toContainText(asShown(divergedAtMs));
    }
  });

  test('clicking the first divergent bar jumps the chart to it', async ({ page }) => {
    const runId = await findLeakyRun(page);
    test.skip(runId === null, NO_RUN);

    await page.goto(`/runs/${runId!}`);
    await page.getByRole('tab', { name: 'Integrity' }).click();
    await ensureValidated(page);

    // The check's FIRST PEEK, which on a leaking script is normally a bar with no trade on it —
    // bar 0 on this fixture — and that is the whole reason the chart's focus is a time rather than
    // a trade (A53).
    const results = await reportFor(page, runId!);

    /*
     * ANY look-ahead check carrying a time, not the causality check specifically.
     *
     * Which of them fires depends on the data — causality needs a higher-timeframe bucket to close
     * inside the range, the splice needs a bounded leak to move a decision — and this test is about
     * the JUMP, not about which check produced the instant. Pinning it to one check would make a
     * shorter series look like a broken chart.
     */
    const timed = results
      .filter((c) => c.id.startsWith('lookahead-'))
      .map((c) => ({
        id: c.id,
        atMs: (c.evidence?.['peekedAtMs'] ?? c.evidence?.['divergedAtMs']) as number | undefined,
      }))
      .find((c) => typeof c.atMs === 'number');

    test.skip(
      timed === undefined,
      'no look-ahead check on this run reported a bar time, so there is no evidence to click',
    );

    const causality = page.getByTestId(`check-${timed!.id}`);
    await expect(causality).toHaveAttribute('data-status', 'fail');

    const jump = causality.getByTestId('jump-time').first();
    await expect(jump).toContainText(asShown(timed!.atMs!));
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
    // The bar shown is the one containing the evidence, so its date is the evidence's date.
    await expect(note).toContainText(asShown(timed!.atMs!).slice(0, 10));
  });

  /**
   * The clean twin, which is what stops all of this from being a test of a tab that always says
   * "No". Identical logic to the leaky fixture with `lookahead_off` and a `[1]` offset — so every
   * look-ahead check must pass, and the honesty question must answer Yes.
   */
  test('the clean twin passes every look-ahead check', async ({ page }) => {
    const runId = await findCleanRun(page);
    test.skip(runId === null, NO_CLEAN_RUN);

    await page.goto(`/runs/${runId!}`);
    await page.getByRole('tab', { name: 'Integrity' }).click();
    await ensureValidated(page);

    for (const id of [
      'lookahead-static',
      'lookahead-prefix-invariance',
      'lookahead-future-splice',
      'lookahead-causality',
    ]) {
      const card = page.getByTestId(`check-${id}`);
      const status = await card.getAttribute('data-status');
      // `n/a` is allowed — a check with nothing to measure has not found a leak — but `fail` and
      // `warn` are not: this source cannot look ahead.
      expect(['pass', 'n/a'], `${id} was ${String(status)}`).toContain(status);
    }

    // Deliberately NOT asserting the overall honesty verdict. That aggregates the execution checks
    // too, which depend on the bars — on a synthetic series a fill landing on a bar extreme is an
    // artefact of the generator, not a property of this twin. The four checks above are the claim
    // the twin exists to support.
  });

  test('a check with a visual renders it above the raw evidence', async ({ page }) => {
    const runId = await findLeakyRun(page);
    test.skip(runId === null, NO_RUN);

    await page.goto(`/runs/${runId!}`);
    await page.getByRole('tab', { name: 'Integrity' }).click();
    await ensureValidated(page);

    const results = await reportFor(page, runId!);
    const mcStatus = results.find((c) => c.id === 'overfitting-monte-carlo')?.status;

    const mc = page.getByTestId('check-overfitting-monte-carlo');
    await mc.getByTestId('check-overfitting-monte-carlo-toggle').click();

    if (mcStatus === 'n/a') {
      // An n/a still has to SAY why (A2). A card that expanded to nothing would be the worse bug.
      await expect(page.getByTestId('check-overfitting-monte-carlo-reason')).toBeVisible();
      return;
    }

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
