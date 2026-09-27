import { z } from 'zod';

/**
 * Broker cost configuration (spec 04, amended by D5).
 *
 * This is the OVERLAY config, and the division of labour matters: the engine already applies
 * commission and slippage, because both change the fill price and so change which orders
 * survive a margin check. What the engine cannot model is the spread (our bars are bid-only)
 * or financing (it has no calendar), so those are charged here, on top of the engine's trades.
 *
 * `slippagePoints` therefore appears in both places: the engine uses it to move fills, and the
 * overlay uses the same figure to ESTIMATE how much of the resulting P&L was slippage, so the
 * cost waterfall can attribute it. It is not charged twice — see `applyCosts`.
 */

/** Where a bar's spread comes from. */
export const SPREAD_SOURCES = ['data', 'fixed', 'none'] as const;
export const SpreadSourceSchema = z.enum(SPREAD_SOURCES);
export type SpreadSource = z.infer<typeof SpreadSourceSchema>;

export const SpreadConfigSchema = z.object({
  /**
   * `data` uses the bar's stored spread and falls back to `fixedPoints` when a bar has none;
   * `fixed` always uses `fixedPoints`; `none` charges no spread at all, which is what the
   * zero-cost cross-check runs with.
   */
  source: SpreadSourceSchema.default('data'),
  /** Fallback/override spread in POINTS (multiples of mintick), not price units. */
  fixedPoints: z.number().nonnegative().default(0),
  /** Stress multiplier, for spec 06's cost-stress check. 1 = as measured. */
  multiplier: z.number().nonnegative().default(1),
});
export type SpreadConfig = z.infer<typeof SpreadConfigSchema>;

/**
 * How a held position is financed overnight.
 *
 * - `none` — no financing at all.
 * - `mt5Points` — broker swap in points per lot per night, the MT5 convention. Sign is the
 *   broker's: negative is a charge, positive a credit.
 * - `annualPct` — a percent per year of notional, split across nights.
 * - `funding` — a rate charged every N hours on notional, for crypto perpetuals.
 */
export const FINANCING_MODES = ['none', 'mt5Points', 'annualPct', 'funding'] as const;
export const FinancingModeSchema = z.enum(FINANCING_MODES);
export type FinancingMode = z.infer<typeof FinancingModeSchema>;

export const FinancingConfigSchema = z.object({
  mode: FinancingModeSchema.default('none'),

  /** mt5Points: swap in points per lot per night. Negative = charge. */
  swapLongPoints: z.number().default(0),
  swapShortPoints: z.number().default(0),

  /** annualPct: percent per year of notional. Negative = charge. */
  annualPctLong: z.number().default(0),
  annualPctShort: z.number().default(0),

  /** funding: percent of notional per interval. Positive means longs pay shorts. */
  fundingRatePct: z.number().default(0),
  fundingIntervalHours: z.number().positive().default(8),

  /**
   * When the daily rollover happens, as a local time in `rolloverTimeZone`.
   *
   * D5: **17:00 America/New_York**. Exness documents 21:00 UTC in summer and 22:00 UTC in
   * winter, which is the same instant written two ways — so the honest representation is the
   * New York wall clock, and the UTC hour follows daylight saving on its own.
   */
  rolloverTimeZone: z.string().min(1).default('America/New_York'),
  rolloverMinuteOfDay: z
    .number()
    .int()
    .min(0)
    .max(1439)
    .default(17 * 60),

  /**
   * Weekday charged three times, for the weekend. 0 = Sunday, 3 = Wednesday (the default:
   * spot FX settles T+2, so Wednesday's rollover carries Saturday and Sunday).
   *
   * Null disables triple charging.
   */
  tripleChargeWeekday: z.number().int().min(0).max(6).nullable().default(3),

  /** Islamic/swap-free account: no financing regardless of the mode. */
  swapFree: z.boolean().default(false),
});
export type FinancingConfig = z.infer<typeof FinancingConfigSchema>;

export const CostConfigSchema = z.object({
  spread: SpreadConfigSchema.default({ source: 'data', fixedPoints: 0, multiplier: 1 }),
  /**
   * Slippage in points, as handed to the engine. Used here only to attribute the cost in the
   * waterfall; the engine is what actually applies it to a fill.
   */
  slippagePoints: z.number().nonnegative().default(0),
  financing: FinancingConfigSchema.default({
    mode: 'none',
    swapLongPoints: 0,
    swapShortPoints: 0,
    annualPctLong: 0,
    annualPctShort: 0,
    fundingRatePct: 0,
    fundingIntervalHours: 8,
    rolloverTimeZone: 'America/New_York',
    rolloverMinuteOfDay: 17 * 60,
    tripleChargeWeekday: 3,
    swapFree: false,
  }),
});
export type CostConfig = z.infer<typeof CostConfigSchema>;

/** Every cost switched off. The zero-cost cross-check in spec 04 runs with exactly this. */
export const ZERO_COSTS: CostConfig = Object.freeze<CostConfig>({
  spread: { source: 'none', fixedPoints: 0, multiplier: 1 },
  slippagePoints: 0,
  financing: {
    mode: 'none',
    swapLongPoints: 0,
    swapShortPoints: 0,
    annualPctLong: 0,
    annualPctShort: 0,
    fundingRatePct: 0,
    fundingIntervalHours: 8,
    rolloverTimeZone: 'America/New_York',
    rolloverMinuteOfDay: 17 * 60,
    tripleChargeWeekday: 3,
    swapFree: false,
  },
});

export const DEFAULT_COSTS: CostConfig = Object.freeze<CostConfig>({
  ...ZERO_COSTS,
  spread: { source: 'data', fixedPoints: 0, multiplier: 1 },
});
