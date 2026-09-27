import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * WCAG contrast for the semantic colour tokens.
 *
 * A one-off audit rots the moment someone nudges a hue. Reading the tokens straight out of
 * `index.css` and asserting the ratios makes the audit a regression test: a theme change that
 * pushes text below AA fails here rather than shipping.
 *
 * AA for normal text is 4.5:1, and this app is DENSE — most of it is 10–12px, so "large text"
 * (3:1) does not apply anywhere it matters. Every foreground is therefore held to 4.5.
 */

const CSS = readFileSync(fileURLToPath(new URL('../src/index.css', import.meta.url)), 'utf8');

type Hsl = readonly [number, number, number];

/** Pull a token's `hsl(h s% l%)` value out of a `:root` / `.dark` block. */
function token(block: string, name: string): Hsl {
  const blockBody = new RegExp(`${block}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1];
  if (blockBody === undefined) throw new Error(`No ${block} block in index.css`);

  const match = new RegExp(`--${name}:\\s*hsl\\(([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%\\)`).exec(
    blockBody,
  );
  if (match === null) throw new Error(`No --${name} in ${block}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function hslToRgb([h, s, l]: Hsl): readonly [number, number, number] {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number): number => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number): number =>
    light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)];
}

/** Relative luminance, WCAG 2.1 §relative-luminance. */
function luminance(rgb: readonly [number, number, number]): number {
  const channel = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrast(a: Hsl, b: Hsl): number {
  const [hi, lo] = [luminance(hslToRgb(a)), luminance(hslToRgb(b))].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

/** Every surface text can land on. `surface-hover` counts: whole rows use it. */
const BACKGROUNDS = ['background', 'surface', 'surface-hover'] as const;

/**
 * Every token used as text.
 *
 * `accent` and `destructive` are here because they carry MEANING — profit and loss, added and
 * removed lines, pass and fail. Unreadable is not a cosmetic problem when the colour is the
 * information.
 */
const FOREGROUNDS = ['foreground', 'muted', 'primary', 'accent', 'destructive'] as const;

const AA_NORMAL_TEXT = 4.5;

describe.each([':root', '.dark'])('%s theme contrast', (theme) => {
  const cases = BACKGROUNDS.flatMap((bg) => FOREGROUNDS.map((fg) => ({ bg, fg })));

  it.each(cases)('$fg on $bg meets WCAG AA', ({ fg, bg }) => {
    const ratio = contrast(token(theme, fg), token(theme, bg));
    expect(
      ratio,
      `--${fg} on --${bg} in ${theme} is ${ratio.toFixed(2)}:1, below AA (${AA_NORMAL_TEXT}:1)`,
    ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});

describe('the contrast maths itself', () => {
  it('gives 21:1 for black on white', () => {
    expect(contrast([0, 0, 0], [0, 0, 100])).toBeCloseTo(21, 5);
  });

  it('gives 1:1 for a colour against itself', () => {
    expect(contrast([221, 83, 53], [221, 83, 53])).toBeCloseTo(1, 10);
  });

  it('is symmetric', () => {
    expect(contrast([0, 0, 20], [0, 0, 90])).toBeCloseTo(contrast([0, 0, 90], [0, 0, 20]), 10);
  });
});

describe('primary-foreground on primary', () => {
  // Buttons put one directly on the other, and it is the only pairing where the background is
  // itself an accent colour rather than a surface.
  it.each([':root', '.dark'])('meets AA in %s', (theme) => {
    const ratio = contrast(token(theme, 'primary-foreground'), token(theme, 'primary'));
    expect(ratio, `${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });
});
