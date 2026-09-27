import { z } from 'zod';

import { SymbolCodeSchema } from './feeds';
import type { AccountMoney, Lots, Price } from './units';

/**
 * One stored M1 OHLCV bar. `time` is the bar's OPEN time in UTC epoch milliseconds —
 * the single time convention across the whole system.
 *
 * `spread` is in PRICE units (not points) and is nullable because not every source
 * provides it: Dukascopy gives ask.close - bid.close, Exness ticks give the per-minute
 * mean, MT5 CSV gives points we convert, and Binance gives nothing.
 */
export interface Bar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly spread?: number | null;
}

export const BarSchema = z.object({
  time: z.number().int().nonnegative(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite().nonnegative(),
  spread: z.number().finite().nullable().optional(),
});

/**
 * A resampled bar. Carries the bucket's close time so the UI and the engine never have
 * to re-derive it (which is impossible for MN1 without calendar arithmetic).
 *
 * `closeTime` is the EXCLUSIVE end of the bucket, i.e. the open time of the next
 * bucket. A bar covers [time, closeTime).
 */
export interface Candle {
  readonly time: number;
  readonly closeTime: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  /** Mean of the contributing M1 spreads; null when none of them had one. */
  readonly spread: number | null;
  /**
   * How many M1 bars contributed to `spread`. Carried so that resampling an already
   * resampled series (M5 -> M15) can recombine the means EXACTLY by weight, instead of
   * averaging averages — which would only agree with M1 -> M15 when every intermediate
   * bucket happened to hold the same number of spread samples.
   */
  readonly spreadSamples: number;
}

export const CandleSchema = z.object({
  time: z.number().int().nonnegative(),
  closeTime: z.number().int().positive(),
  open: z.number().finite(),
  high: z.number().finite(),
  low: z.number().finite(),
  close: z.number().finite(),
  volume: z.number().finite().nonnegative(),
  spread: z.number().finite().nullable(),
  spreadSamples: z.number().int().nonnegative(),
});

export const ASSET_CLASSES = ['fx', 'metal', 'index', 'energy', 'crypto'] as const;
export const AssetClassSchema = z.enum(ASSET_CLASSES);
export type AssetClass = z.infer<typeof AssetClassSchema>;

/**
 * Trading calendar. Drives weekend-aware gap detection in the data-quality report:
 * fx24x5 closes Friday evening to Sunday evening, crypto never closes.
 */
export const SESSION_TYPES = ['fx24x5', 'crypto24x7'] as const;
export const SessionTypeSchema = z.enum(SESSION_TYPES);
export type SessionType = z.infer<typeof SessionTypeSchema>;

/** Every data source, whether it fetches or is uploaded. */
export const PROVIDER_IDS = [
  'dukascopy',
  'twelvedata',
  'binance',
  'exness-ticks',
  'mt5-csv',
] as const;
export const ProviderIdSchema = z.enum(PROVIDER_IDS);
export type ProviderId = z.infer<typeof ProviderIdSchema>;

/**
 * Contract specification for one tradable instrument.
 *
 * `mintick` vs `pipSize`: mintick is the smallest quotable price increment and is what
 * MT5 calls a "point" — spreads in points are multiplied by mintick to get a price
 * delta. pipSize is the conventional pip, which for 5-digit fx is 10 minticks.
 */
export const SymbolSpecSchema = z.object({
  /** Canonical EdgeLab code, e.g. EURUSD. */
  symbol: SymbolCodeSchema,
  assetClass: AssetClassSchema,
  baseCcy: z.string().min(2).max(8),
  quoteCcy: z.string().min(2).max(8),
  digits: z.number().int().min(0).max(10),
  mintick: z.number().positive(),
  pipSize: z.number().positive(),
  /** Units of the base instrument per 1.00 lot. */
  contractSize: z.number().positive(),
  /** Account-currency value of one point per lot; 1 unless the broker says otherwise. */
  pointValue: z.number().positive().default(1),
  /** Fallback spread, in points, when a bar has no stored spread. */
  defaultSpreadPoints: z.number().nonnegative().default(0),
  /**
   * provider id -> that provider's own instrument identifier.
   *
   * partialRecord, not record: with an enum key, z.record() requires EVERY provider to
   * be present, and most symbols are only offered by some of them.
   */
  providerSymbols: z.partialRecord(ProviderIdSchema, z.string()).default({}),
  sessionType: SessionTypeSchema,
  enabled: z.boolean().default(true),
});

export type SymbolSpec = z.infer<typeof SymbolSpecSchema>;

/** The subset a user may change from the Settings UI. */
export const SymbolPatchSchema = SymbolSpecSchema.pick({
  digits: true,
  mintick: true,
  pipSize: true,
  contractSize: true,
  pointValue: true,
  defaultSpreadPoints: true,
  providerSymbols: true,
  sessionType: true,
  enabled: true,
}).partial();

export type SymbolPatch = z.infer<typeof SymbolPatchSchema>;

export type TradeSide = 'long' | 'short';

/**
 * A completed round-trip trade. Lives here rather than in @edgelab/engine so that
 * @edgelab/metrics and @edgelab/validation can consume it without depending on the
 * execution engine.
 */
export interface ClosedTrade {
  /** 1-based ordinal within the run, matching the report table. */
  readonly seq: number;
  readonly side: TradeSide;
  readonly entryTime: number;
  readonly exitTime: number;
  /** P&L after all costs, in account currency. */
  readonly netPnl: number;
}

/**
 * A closed trade with the full cost overlay applied — the unit the metrics engine consumes.
 *
 * Defined here rather than in @edgelab/engine so that @edgelab/metrics depends only on
 * shared. Phase 4's cost model produces these; every money field is in the ACCOUNT
 * currency, already converted.
 */
export interface CostedTrade {
  /** 1-based ordinal within the run. */
  readonly seq: number;
  readonly side: TradeSide;
  /**
   * Always positive, in LOTS — branded, because multiplying this by a tick has shipped twice.
   *
   * A brand is still a `number` at run time and assignable TO `number`, so reading and formatting it
   * is unaffected. What no longer compiles is passing it where UNITS are wanted.
   */
  readonly qty: Lots;
  readonly entryTime: number;
  readonly exitTime: number;
  readonly entryBar: number;
  readonly exitBar: number;
  readonly entryPrice: Price;
  readonly exitPrice: Price;
  /** Engine P&L before our overlay, for cross-checking. In the ACCOUNT currency. */
  readonly grossPnl: AccountMoney;
  readonly commission: AccountMoney;
  readonly slippageCost: AccountMoney;
  readonly spreadCost: AccountMoney;
  readonly financingCost: AccountMoney;
  /** P&L after ALL costs, in the ACCOUNT currency. Every statistic is computed from this. */
  readonly netPnl: AccountMoney;
  /** Maximum adverse excursion while open, <= 0. Null when not reconstructed. */
  readonly mae: AccountMoney | null;
  /** Maximum favourable excursion while open, >= 0. */
  readonly mfe: AccountMoney | null;
  readonly barsHeld: number | null;
  readonly exitReason: string | null;
}

/** A point on a resampled equity series (daily or monthly). */
export interface EquitySample {
  /** UTC midnight of the day, or the 1st of the month. */
  readonly time: number;
  readonly equity: number;
}

/** One sample of the reconstructed equity curve. */
export interface EquityPoint {
  readonly time: number;
  readonly equity: number;
  /** Highest equity seen up to and including this point. */
  readonly peak: number;
  /** peak - equity, always >= 0. */
  readonly drawdown: number;
  /** drawdown / peak * 100, or 0 when peak <= 0. */
  readonly drawdownPct: number;
}
