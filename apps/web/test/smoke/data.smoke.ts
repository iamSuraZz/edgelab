import { expect, test } from '@playwright/test';

/**
 * The Data page and the two dashboard visuals spec 05 asked for.
 *
 * Deliberately does NOT download anything. A smoke suite that called Dukascopy on every push would
 * be rate-limited within a day, and CI sets no provider key precisely so nothing there can reach an
 * external source. The download FORM is asserted — its fields, and that it refuses to offer a
 * provider that cannot serve the selected symbol — while the download itself stays a hand-run check
 * (A62 records the one that was performed).
 */

test.describe('Data page', () => {
  test.beforeEach(async ({ page }) => {
    page.on('console', (message) => {
      if (message.type() === 'error') console.log(`[browser] ${message.text()}`);
    });
    await page.goto('/data');
    await expect(page.getByTestId('data-page')).toBeVisible();
  });

  test('provider cards report capability and never a key', async ({ page }) => {
    await expect(page.getByTestId('provider-cards')).toBeVisible();

    const dukascopy = page.getByTestId('provider-dukascopy');
    await expect(dukascopy).toBeVisible();
    // Whether a feed carries a spread is a property of the SOURCE, and cost figures are not
    // comparable across feeds without it (A61).
    await expect(dukascopy).toContainText(/per bar/);

    const twelvedata = page.getByTestId('provider-twelvedata');
    await expect(twelvedata).toContainText(/not supplied/);

    // The key itself must never reach the browser. Only presence, and the variable NAME when absent.
    const cards = await page.getByTestId('provider-cards').textContent();
    expect(cards).not.toMatch(/[a-f0-9]{24,}/i);
  });

  test('the download form offers only providers that can serve the symbol', async ({ page }) => {
    await expect(page.getByTestId('download-form')).toBeVisible();

    await page.getByTestId('download-symbol').selectOption('EURUSD');
    const fx = await page.getByTestId('download-provider').locator('option').allTextContents();
    expect(fx).toContain('Dukascopy');
    // Binance serves crypto only, so it cannot appear for an fx pair (A62).
    expect(fx).not.toContain('Binance');

    await page.getByTestId('download-symbol').selectOption('BTCUSD');
    const crypto = await page.getByTestId('download-provider').locator('option').allTextContents();
    expect(crypto).toContain('Binance');
  });

  test('the import drop-zone asks for the broker offset, and only for MT5', async ({ page }) => {
    const zone = page.getByTestId('import-dropzone');
    await expect(zone).toBeVisible();

    await page.getByTestId('import-format').selectOption('mt5-csv');
    // The trap worth naming: MT5 writes the broker's wall clock with nothing saying which zone.
    await expect(zone).toContainText(/GMT\+2|120/);

    await page.getByTestId('import-format').selectOption('generic-csv');
    await expect(page.getByTestId('import-offset')).toHaveValue('0');

    // Exness ZIPs are NOT PLANNED (A12) and must not be offered.
    const formats = await page.getByTestId('import-format').locator('option').allTextContents();
    expect(formats.join(' ')).not.toMatch(/exness/i);
  });

  test('coverage shows a stored feed, its heatmap and its quality', async ({ page }) => {
    const table = page.getByTestId('coverage-table');
    await expect(table).toBeVisible();

    const row = page.getByTestId('coverage-EURUSD');
    test.skip(
      (await row.count()) === 0,
      'no stored EURUSD bars — run `pnpm run data:seed-synthetic EURUSD 2024-01-01 2024-02-01`',
    );

    await page.getByTestId('coverage-EURUSD-toggle').click();
    await expect(page.getByTestId('coverage-heatmap')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('coverage-quality')).toBeVisible({ timeout: 120_000 });
    await expect(page.getByTestId('coverage-quality')).toContainText(/Completeness/);
  });

  test('the preview resamples stored M1 onto every timeframe asked for', async ({ page }) => {
    // Wait for the table BEFORE counting: the coverage query is async, and counting a row that has
    // not rendered yet skips the test while looking like "no data".
    await expect(page.getByTestId('coverage-table')).toBeVisible();
    const row = page.getByTestId('coverage-EURUSD');
    test.skip((await row.count()) === 0, 'no stored EURUSD bars');

    await page.getByTestId('coverage-EURUSD-preview').click();
    await expect(page.getByTestId('candle-preview')).toBeVisible();

    /*
     * Bar COUNTS across timeframes, which is the assertion with teeth: only M1 is stored, so if the
     * resampler bucketed wrongly the counts would not fall in proportion. "A chart appeared" would
     * pass against a resampler that returned the same series every time.
     */
    /*
     * Read the COUNT element, not the whole header.
     *
     * Scraping the header matched across the date range and the figure - `2024-02-12` followed by
     * `768 bars` reads as `12768 bars` - which made M15 and H1 look 5% apart instead of 4x.
     */
    const countEl = page.getByTestId('preview-count');
    const readCount = async (): Promise<number> =>
      Number(((await countEl.textContent()) ?? '').replace(/[^\d]/g, '') || '0');

    const counts: Record<string, number> = {};
    let previous = -1;
    for (const tf of ['M1', 'M15', 'H1', 'H4']) {
      await page.getByTestId(`preview-tf-${tf}`).click();
      await expect(page.getByTestId('preview-error')).toHaveCount(0);

      /*
       * Poll until the count CHANGES. The header keeps showing the previous timeframe's figure while
       * the new query is in flight, so a plain `toContainText(/bars/)` passes instantly and reads
       * the old number — which is how the first version of this test compared M15 against itself
       * and got a ratio of 1.05.
       */
      await expect
        .poll(
          async () => {
            const c = await readCount();
            // Non-zero AND different from the last timeframe. Zero is the state before any data has
            // landed — the header renders an empty count span — and accepting it made the first
            // reading 0 for M1.
            return c > 0 && c !== previous ? c : null;
          },
          { timeout: 30_000 },
        )
        .not.toBeNull();

      counts[tf] = await readCount();
      previous = counts[tf]!;
    }

    expect(counts['M1']).toBeGreaterThan(0);
    // Each step up must reduce the count, and roughly by its factor.
    expect(counts['M15']).toBeLessThan(counts['M1']!);
    expect(counts['H1']).toBeLessThan(counts['M15']!);
    expect(counts['H4']).toBeLessThan(counts['H1']!);
    expect(counts['M15']! / counts['H1']!).toBeGreaterThan(3);
    expect(counts['M15']! / counts['H1']!).toBeLessThan(5);
  });
});

test.describe('Results dashboard (spec 05)', () => {
  test('the monthly heatmap and the cost waterfall render for a stored run', async ({ page }) => {
    const response = await page.request.get('/api/backtests?limit=500');
    const runs = (await response.json()) as { id: string; state: string }[];
    const completed = runs.filter((r) => r.state === 'completed');
    test.skip(completed.length === 0, 'no completed run on this stack');

    // The first run that actually carries a metrics report. CLI runs stored none before A65, so an
    // older database can still hold some without one.
    let target: string | null = null;
    for (const run of completed.slice(0, 12)) {
      const detail = await page.request.get(`/api/backtests/${run.id}`);
      const body = (await detail.json()) as { metrics: unknown };
      if (body.metrics !== null) {
        target = run.id;
        break;
      }
    }
    test.skip(target === null, 'no completed run carries a metrics report');

    await page.goto(`/runs/${target!}`);
    await expect(page.getByTestId('monthly-heatmap')).toBeVisible({ timeout: 60_000 });

    await page.getByTestId('tab-costs').click();
    await expect(page.getByTestId('cost-waterfall')).toBeVisible();

    /*
     * The rows drawn must account for every cost counted (A65). NOT the gross-minus-costs identity,
     * which holds by construction upstream and so cannot fail — a check that cannot fail reads as
     * verification while proving nothing.
     */
    await expect(page.getByTestId('waterfall-balances')).toBeVisible();
    await expect(page.getByTestId('waterfall-imbalance')).toHaveCount(0);
  });
});
