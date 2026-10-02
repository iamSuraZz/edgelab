import type { Page } from '@playwright/test';

/** Monaco renders leading indentation as U+00A0. Escaped, because a raw one is invisible in source. */
const NBSP = new RegExp('\u00a0', 'g');

/**
 * Put Pine source into the Monaco editor the way a person does: by PASTING it.
 *
 * This is not a stylistic preference. The previous helper used `page.keyboard.insertText`, which
 * Monaco treats as TYPING — so its auto-indent fires on every newline and carries the previous
 * line's indentation forward. Pine's indentation is semantic, and the result was a script whose
 * second `if` block had been silently nested inside the first:
 *
 *     if ta.crossover(fast, slow)
 *         strategy.entry("Long", strategy.long)
 *
 *         if ta.crossunder(fast, slow)        <- nested by auto-indent
 *             strategy.close("Long")
 *
 * That compiles, runs, opens a position and never closes it — 0 closed trades with a 17% drawdown —
 * and every assertion short of "did it trade" passes. A real clipboard paste does not auto-indent,
 * because Monaco disables it for paste specifically, so this reproduces what a user actually gets.
 *
 * The old helper survived because it was only ever used on a source expected to FAIL compilation,
 * where mangled indentation changes nothing.
 */
export async function pasteEditorText(page: Page, text: string): Promise<void> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);

  await page.evaluate(async (value) => {
    await navigator.clipboard.writeText(value);
  }, text);

  await page.locator('.monaco-editor').first().click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.press('ControlOrMeta+V');
}

/**
 * Read back what the editor holds.
 *
 * Used to ASSERT the paste landed verbatim rather than trusting it. The whole point of the fix above
 * is that a mangled paste is invisible until a metric comes out wrong, so the test checks the input
 * it thinks it gave.
 */
export async function editorText(page: Page): Promise<string> {
  const lines = await page.evaluate(() =>
    // Monaco renders the model into `.view-line` elements; its own API is not on `window` in a
    // production bundle, so the DOM is the available reading.
    Array.from(document.querySelectorAll('.monaco-editor .view-line')).map(
      (l) => l.textContent ?? '',
    ),
  );

  return lines.map((line) => line.replace(NBSP, ' ')).join('\n');
}
