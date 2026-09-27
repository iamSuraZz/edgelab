import { expect, test, type Page } from '@playwright/test';

/**
 * The part of the Studio that can be checked WITHOUT a backend.
 *
 * Separate from `studio.smoke.ts` on purpose. That test needs TimescaleDB, Redis, the API and the
 * worker; this one needs only the dev server, so it still catches the failures that make a UI
 * unusable — a crash on mount, a broken import, a pane that will not render — on a machine where
 * the stack is not up.
 *
 * Every API call is stubbed to fail here, which makes this the test for the EMPTY and ERROR
 * states. Those are the states a new user sees first, and they are the easiest to leave broken
 * because nobody looks at them once their own machine has data.
 */

test.describe('Studio shell (no backend)', () => {
  test.beforeEach(async ({ page }) => {
    // Clear ONCE per test, not on every navigation. `addInitScript` re-runs on each document,
    // including `page.reload()` — so an unguarded clear wipes the very state a
    // "survives a reload" assertion is about, and the app correctly comes back at its default.
    // The sentinel lives in sessionStorage, which survives a reload but not a new context, so
    // each test still starts clean.
    await page.addInitScript(() => {
      if (window.sessionStorage.getItem('smoke:cleared') === null) {
        window.localStorage.clear();
        window.sessionStorage.setItem('smoke:cleared', '1');
      }
    });

    // Fail every API call the way an unreachable API would, rather than letting the test hang on
    // a real request to a port with nothing behind it.
    await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  });

  test('renders the three panes in dark mode without crashing', async ({ page }) => {
    const crashes: string[] = [];
    page.on('pageerror', (error) => crashes.push(error.message));

    await page.goto('/studio');

    await expect(page.getByTestId('studio')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Editor' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Run settings' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Results' })).toBeVisible();

    // Dark by default, per the slice brief.
    await expect(page.locator('html')).toHaveClass(/dark/);

    expect(crashes, `uncaught errors: ${crashes.join(' | ')}`).toHaveLength(0);
  });

  test('offers all 21 MT5 timeframes and selects one', async ({ page }) => {
    await page.goto('/studio');

    const chips = page.getByTestId('timeframe-chips').getByRole('button');
    await expect(chips).toHaveCount(21);

    await page.getByTestId('tf-M15').click();
    await expect(page.getByTestId('tf-M15')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('tf-H1')).toHaveAttribute('aria-pressed', 'false');
  });

  test('says what to do when no symbol has data, instead of showing an empty list', async ({
    page,
  }) => {
    // A SUCCESSFUL response carrying no usable symbols — which is the real "fresh install, seeded
    // but nothing downloaded" state. Aborting instead would exercise the unreachable-API path,
    // which is a different message and is covered by its own test below.
    await page.route('**/api/symbols', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );

    await page.goto('/studio');

    // The actionable instruction matters more than the absence: "no symbols" is a dead end,
    // "run pnpm ingest" is a next step.
    await expect(page.getByText(/No symbol has stored bars yet/)).toBeVisible();
    await expect(page.getByText(/pnpm ingest EURUSD dukascopy/)).toBeVisible();

    // And Run is unavailable rather than failing on click.
    await expect(page.getByTestId('run-backtest')).toBeDisabled();
  });

  test('reports an unreachable symbols endpoint distinctly from having no data', async ({
    page,
  }) => {
    await page.goto('/studio');
    await expect(page.getByText(/Could not reach the API/)).toBeVisible();
  });

  test('reports an unreachable API in the compatibility panel rather than silently', async ({
    page,
  }) => {
    await page.goto('/studio');

    await setEditorText(page, '//@version=5\nindicator("x")\n');

    await expect(page.getByTestId('compile-status')).toContainText('error', { timeout: 30_000 });
    await expect(page.getByTestId('compatibility-panel')).toContainText(/Could not reach the API/);
  });

  test('shows the results empty state with the shortcut that gets you started', async ({
    page,
  }) => {
    await page.goto('/studio');

    await expect(page.getByText('No run yet')).toBeVisible();
    await expect(page.getByText(/Ctrl\/Cmd\+Enter/)).toBeVisible();
  });

  test('panes resize by dragging and the width survives a reload', async ({ page }) => {
    await page.goto('/studio');

    const divider = page.getByRole('separator', { name: 'Resize panes' }).first();
    const before = await divider.boundingBox();
    expect(before).not.toBeNull();

    await divider.hover();
    await page.mouse.down();
    await page.mouse.move(before!.x + 160, before!.y, { steps: 12 });
    await page.mouse.up();

    const after = await divider.boundingBox();
    expect(after!.x).toBeGreaterThan(before!.x + 80);

    await page.reload();
    await expect(page.getByTestId('studio')).toBeVisible();
    const restored = await page
      .getByRole('separator', { name: 'Resize panes' })
      .first()
      .boundingBox();
    // Within a few pixels: the layout is restored from a stored ratio, not from a pixel width.
    expect(Math.abs(restored!.x - after!.x)).toBeLessThan(12);
  });

  test('the divider is keyboard operable', async ({ page }) => {
    await page.goto('/studio');

    const divider = page.getByRole('separator', { name: 'Resize panes' }).first();
    const before = await divider.boundingBox();

    await divider.focus();
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight');

    const after = await divider.boundingBox();
    expect(after!.x).toBeGreaterThan(before!.x);
  });
});

/**
 * Replace the editor's contents.
 *
 * Monaco's textarea is an invisible input proxy, so Playwright's `fill()` either hangs waiting
 * for it to become editable or silently writes nowhere. Clicking into the editor and driving it
 * with select-all + keyboard is the interaction a person actually performs.
 */
async function setEditorText(page: Page, text: string): Promise<void> {
  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('Delete');
  await page.keyboard.insertText(text);
}

test.describe('Run report at its own URL (no backend)', () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (window.sessionStorage.getItem('smoke:cleared') === null) {
        window.localStorage.clear();
        window.sessionStorage.setItem('smoke:cleared', '1');
      }
    });
  });

  test('/runs/:id renders the REPORT, not the runs list', async ({ page }) => {
    // The defect this guards: the route was wired to RunsPage, so every run link led straight
    // back to the list it was clicked from.
    // The sub-resources FIRST: a `*` does not cross a `/`, so `**/api/backtests/*` matches the
    // report but not `/series` or `/trades`. Leaving those unstubbed makes the page hang on a
    // real request rather than fail, which looks like a broken page and is not.
    await page.route('**/api/backtests/*/trades', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ runId: REPORT.id, count: 0, trades: [] }),
      }),
    );
    await page.route('**/api/backtests/*/series*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runId: REPORT.id,
          initialCapital: 10000,
          accountCurrency: 'USD',
          equityClose: { count: 0, originalCount: 0, downsampled: false, points: [] },
          equityIntrabar: null,
          daily: [],
          monthly: [],
          buyAndHold: null,
        }),
      }),
    );
    await page.route('**/api/backtests/*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(REPORT),
      }),
    );
    await page.route('**/api/symbols', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );

    await page.goto('/runs/11111111-1111-1111-1111-111111111111');

    await expect(page.getByTestId('kpi-strip')).toBeVisible();
    await expect(page.getByTestId('runs-table')).toHaveCount(0);
    // `level: 1` matters: ResultsPane titles itself "Results — EURUSD H1 · Hand Check", so a bare
    // name match finds two headings and fails on strict mode. The h1 is the report's own header.
    await expect(page.getByRole('heading', { level: 1, name: 'Hand Check v2' })).toBeVisible();
    await expect(page.getByTestId('copy-run-url')).toBeVisible();
    await expect(page.getByTestId('export-json')).toBeVisible();
  });
});

/** Minimal completed run, shaped like GET /api/backtests/:id. */
const REPORT = {
  id: '11111111-1111-1111-1111-111111111111',
  state: 'completed',
  error: null,
  strategy: {
    id: 's1',
    name: 'Hand Check',
    versionId: 'v1',
    version: 2,
    sourceHash: 'abc',
    source: '//@version=5\n',
  },
  config: {
    symbol: 'EURUSD',
    timeframe: 'H1',
    from: Date.UTC(2024, 0, 1),
    to: Date.UTC(2024, 1, 1),
    initialCapital: 10000,
    accountCurrency: 'USD',
    costs: {},
    inputs: {},
    props: {},
    warmupBars: 500,
  },
  provenance: { engineId: 'pinets', engineVersion: '0.9.34', dataVersion: 1, jobId: null },
  metrics: null,
  kpis: {
    netProfit: -5707,
    totalReturnPct: -57.07,
    cagrPct: null,
    profitFactor: 0.09,
    maxDrawdownPct: 59.3,
    sharpe: -10.21,
    winRatePct: 3.45,
    closedTrades: 29,
    buyAndHoldReturnPct: -2.16,
  },
  notes: [],
  diagnostics: [],
  unfilledEntryOrders: 0,
  crossCheck: { ok: true, deltaPct: 0, message: null },
  timings: {
    barsProcessed: 530,
    engineMs: 56,
    totalMs: 62,
    createdAt: Date.UTC(2024, 1, 1),
    completedAt: Date.UTC(2024, 1, 1),
  },
};

test.describe('Library (no backend)', () => {
  const STRATEGY = {
    id: 'str-1',
    name: 'EMA Cross',
    notes: null,
    tags: ['fx', 'trend'],
    createdAt: Date.UTC(2024, 0, 1),
    updatedAt: Date.UTC(2024, 0, 9),
    versionCount: 2,
    latestVersion: {
      id: 'v2',
      version: 2,
      sourceHash: 'bbb',
      pineVersion: 'v5',
      title: 'EMA Cross',
      createdAt: Date.UTC(2024, 0, 9),
    },
  };

  const SOURCES: Record<string, string> = {
    v1: '//@version=5\nstrategy("EMA Cross")\nfast = ta.ema(close, 9)\nslow = ta.ema(close, 21)\n',
    v2: '//@version=5\nstrategy("EMA Cross")\nfast = ta.ema(close, 12)\nslow = ta.ema(close, 21)\n',
  };

  test.beforeEach(async ({ page }) => {
    // Versions BEFORE the detail route: `**/api/strategies/*` would otherwise swallow
    // `/versions/v1` and answer it with the strategy, and the diff would compare two copies of
    // the same JSON blob without ever looking wrong.
    await page.route('**/api/strategies/*/versions/*', (route) => {
      const versionId = route.request().url().split('/').pop() ?? '';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: versionId,
          strategyId: STRATEGY.id,
          version: versionId === 'v2' ? 2 : 1,
          source: SOURCES[versionId] ?? '',
        }),
      });
    });
    await page.route('**/api/strategies/*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ...STRATEGY,
          versions: [
            { ...STRATEGY.latestVersion },
            {
              id: 'v1',
              version: 1,
              sourceHash: 'aaa',
              pineVersion: 'v5',
              title: 'EMA Cross',
              createdAt: Date.UTC(2024, 0, 1),
            },
          ],
        }),
      }),
    );
    await page.route('**/api/strategies', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([STRATEGY]),
      }),
    );
  });

  test('lists strategies with their tags and diffs the two newest versions', async ({ page }) => {
    await page.goto('/library');

    await expect(page.getByRole('button', { name: /EMA Cross/ })).toBeVisible();
    await expect(page.getByRole('heading', { level: 2, name: 'EMA Cross' })).toBeVisible();
    // Via the remove button, not the text: the tag legitimately appears twice — once on the list
    // card and once in the editor — and this asserts the editable one specifically.
    await expect(page.getByRole('button', { name: 'Remove tag trend' })).toBeVisible();

    // The default comparison is v1 → v2, which differs on exactly one line.
    const diff = page.getByTestId('version-diff');
    await expect(diff).toBeVisible();
    await expect(diff).toContainText('+1');
    await expect(diff).toContainText('−1');
    await expect(diff).toContainText('ta.ema(close, 12)');
    await expect(diff).toContainText('ta.ema(close, 9)');
    // The unchanged lines are still there — this is a diff, not a list of changes.
    await expect(diff).toContainText('ta.ema(close, 21)');
  });

  test('says so when the two selected versions are the same', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByTestId('version-diff')).toBeVisible();

    await page.getByLabel('Older version').selectOption('v2');

    await expect(page.getByTestId('diff-identical')).toBeVisible();
  });

  test('filters the list by tag', async ({ page }) => {
    await page.goto('/library');

    await page.getByTestId('library-filter').fill('trend');
    await expect(page.getByRole('button', { name: /EMA Cross/ })).toBeVisible();

    await page.getByTestId('library-filter').fill('nothing-matches-this');
    await expect(page.getByText(/No strategy matches/)).toBeVisible();
  });

  test('tells a new user where versions come from instead of showing an empty list', async ({
    page,
  }) => {
    await page.route('**/api/strategies', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
    );

    await page.goto('/library');

    await expect(page.getByText(/Nothing saved yet/)).toBeVisible();
    await expect(page.getByText(/Ctrl\/Cmd\+S/)).toBeVisible();
  });
});

test.describe('Compare view (no backend)', () => {
  /** Two runs on very different capital, so normalisation is what makes them comparable. */
  const RUNS = [
    {
      id: 'run-a',
      strategyName: 'EMA Cross',
      version: 1,
      symbol: 'EURUSD',
      timeframe: 'H1',
      from: Date.UTC(2024, 0, 1),
      to: Date.UTC(2024, 1, 1),
      state: 'completed',
      crossCheckOk: true,
      tradeCount: 29,
      createdAt: Date.UTC(2024, 1, 1),
      kpis: {
        netProfit: 1000,
        totalReturnPct: 10,
        profitFactor: 1.4,
        maxDrawdownPct: 5,
        sharpe: 1.1,
        winRatePct: 55,
        closedTrades: 29,
      },
    },
    {
      id: 'run-b',
      strategyName: 'RSI Revert',
      version: 3,
      symbol: 'EURUSD',
      timeframe: 'H1',
      from: Date.UTC(2024, 0, 1),
      to: Date.UTC(2024, 1, 1),
      state: 'completed',
      crossCheckOk: true,
      tradeCount: 12,
      createdAt: Date.UTC(2024, 1, 2),
      kpis: {
        netProfit: 4000,
        totalReturnPct: 4,
        profitFactor: 1.1,
        maxDrawdownPct: 9,
        sharpe: 0.4,
        winRatePct: 48,
        closedTrades: 12,
      },
    },
  ];

  /** Capital differs 10×, so the raw curves would not share a readable axis. */
  const CAPITAL: Record<string, number> = { 'run-a': 10_000, 'run-b': 100_000 };

  test.beforeEach(async ({ page }) => {
    await page.route('**/api/backtests/*/series*', (route) => {
      const runId = route.request().url().includes('run-b') ? 'run-b' : 'run-a';
      const base = CAPITAL[runId]!;
      const points = Array.from({ length: 30 }, (_, i) => ({
        time: Date.UTC(2024, 0, 1) + i * 86_400_000,
        equity: base * (1 + i * 0.003),
      }));
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          runId,
          initialCapital: base,
          accountCurrency: 'USD',
          equityClose: {
            count: points.length,
            originalCount: points.length,
            downsampled: false,
            points,
          },
          equityIntrabar: null,
          daily: [],
          monthly: [],
          buyAndHold: null,
        }),
      });
    });
    await page.route('**/api/backtests*', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(RUNS),
      }),
    );
  });

  test('overlays the selected runs’ equity curves, rebased to 100', async ({ page }) => {
    await page.goto('/runs?compare=run-a,run-b');

    await expect(page.getByTestId('compare-view')).toBeVisible();
    await expect(page.getByText('Equity, rebased to 100')).toBeVisible();

    const chart = page.getByTestId('compare-equity');
    await expect(chart).toBeVisible();
    // The loading text is gone, i.e. both series resolved and the chart was built.
    await expect(chart).not.toContainText('Loading equity curves');

    // A legend entry per run, so a line can be told from the other one.
    await expect(page.getByText('EMA Cross v1').first()).toBeVisible();
    await expect(page.getByText('RSI Revert v3').first()).toBeVisible();

    // The table still marks the better value per metric, and better is not simply larger:
    // run-b makes more money, run-a returns more of what it risked.
    await expect(page.getByTestId('compare-view')).toContainText('10.00%');
  });

  test('shows no overlay until at least two runs are selected', async ({ page }) => {
    await page.goto('/runs?compare=run-a');
    await expect(page.getByTestId('runs-table')).toBeVisible();
    await expect(page.getByTestId('compare-equity')).toHaveCount(0);
  });
});

test.describe('Shortcuts and accessibility (no backend)', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/**', (route) => route.abort('connectionrefused'));
  });

  test('? opens the shortcut list and Esc closes it', async ({ page }) => {
    await page.goto('/runs');

    await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);

    await page.keyboard.press('?');
    const dialog = page.getByTestId('shortcuts-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Ctrl/Cmd + Enter');
    await expect(dialog).toContainText('Run the backtest');

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('? typed into a field stays in the field', async ({ page }) => {
    // The regression this guards: a global hotkey that swallows a printable character makes
    // every text field quietly lossy.
    await page.goto('/library');

    const filter = page.getByTestId('library-filter');
    await filter.click();
    await page.keyboard.press('?');

    await expect(page.getByTestId('shortcuts-dialog')).toHaveCount(0);
    await expect(filter).toHaveValue('?');
  });

  test('the skip link is the first thing a keyboard user reaches', async ({ page }) => {
    await page.goto('/runs');

    await page.keyboard.press('Tab');

    const focused = page.locator(':focus');
    await expect(focused).toHaveText('Skip to content');

    // And it actually moves focus into the content, rather than only scrolling there.
    await page.keyboard.press('Enter');
    await expect(page.locator('main:focus')).toBeVisible();
  });

  test('the shortcut list returns focus to whatever opened it', async ({ page }) => {
    await page.goto('/runs');

    await page.getByTestId('shortcuts-open').click();
    await expect(page.getByTestId('shortcuts-close')).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('shortcuts-open')).toBeFocused();
  });
});
