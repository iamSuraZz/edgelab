import { dailyLocalInstants, localClock } from '@edgelab/data';
import { accountMoney, price, spreadShare, units, unitsToLots } from '@edgelab/shared';
import type {
  Bar,
  CostConfig,
  CostedTrade,
  PriceBasis,
  SymbolSpec,
  TradeSide,
  Units,
} from '@edgelab/shared';

import type { EngineTrade } from './pine-engine';
import { CHARGED_FILL_TYPES, slippageForTrade, type FillSlippage } from './slippage';

/**
 * The broker cost overlay (spec 04, amended by D5 and D6). Pure.
 *
 * The engine has already applied commission and slippage, because both move a fill price and
 * so change which orders pass a margin check. Two costs it cannot model are added here:
 *
 *  - **Spread.** What a stored price MEANS depends on the feed (`PriceBasis`). On a bid feed a buy
 *    really transacts at bid + spread, so one spread is charged per round trip on the buying leg:
 *    a long at its ENTRY bar, a short at its EXIT bar. On a mid feed neither leg is the stored
 *    price and each pays half. Either way a round trip costs exactly one spread; charging both
 *    fills in full would double-count it.
 *  - **Financing.** The engine has no calendar, so it cannot know how many rollovers a
 *    position was held through.
 *
 * ARITHMETIC CONVENTIONS, since the units are the easiest thing to get wrong here:
 *  - `EngineTrade.qty` is in instrument UNITS (contracts) — that is what PineTS multiplies by
 *    `syminfo.pointvalue` to get P&L. `CostedTrade.qty` is in LOTS, so it is divided by
 *    `contractSize` on the way out.
 *  - A cost in the quote currency is `priceDelta × units × pointValue`. This is the same
 *    identity `packages/metrics/src/cost-drag.ts` inverts for break-even cost per side, so the
 *    two cannot disagree.
 *  - Every money field on the way out is in the ACCOUNT currency, converted by
 *    `quoteToAccount` (D6).
 */

/**
 * Quote currency to account currency, at an instant.
 *
 * A function of time rather than a scalar because the conversion rate moves during a run, so a
 * single rate would misprice every trade but the first. Identity for a USD-quoted symbol on a
 * USD account, which is the only case D6 currently allows — but equity reconstruction and the
 * cost overlay are both written around the general form, so the currency layer drops in later
 * without reshaping them.
 */
export type QuoteToAccount = (atMs: number) => number;

export const IDENTITY_RATE: QuoteToAccount = () => 1;

/**
 * A run whose quote currency differs from the account currency is REJECTED until the currency
 * layer exists (D6). Reporting P&L in the wrong currency while labelling it with the right one
 * is worse than refusing.
 */
export class CurrencyMismatchError extends Error {
  readonly code = 'currency-mismatch';

  constructor(
    readonly symbol: string,
    readonly quoteCcy: string,
    readonly accountCcy: string,
  ) {
    super(
      `${symbol} is quoted in ${quoteCcy} but the account is in ${accountCcy}. Cross-currency ` +
        `runs are not supported yet: P&L would be reported in ${quoteCcy} under an ` +
        `${accountCcy} label. Use an ${accountCcy}-quoted symbol, or set the account ` +
        `currency to ${quoteCcy}.`,
    );
    this.name = 'CurrencyMismatchError';
  }
}

/**
 * The rate function for a run, or a refusal.
 *
 * @throws {CurrencyMismatchError} when the two currencies differ.
 */
export function resolveQuoteToAccount(symbol: SymbolSpec, accountCurrency: string): QuoteToAccount {
  const quote = symbol.quoteCcy.toUpperCase();
  const account = accountCurrency.toUpperCase();
  if (quote !== account) {
    throw new CurrencyMismatchError(symbol.symbol, quote, account);
  }
  return IDENTITY_RATE;
}

/* ------------------------------------------------------------------ spread */

/**
 * The spread to charge at a bar, in PRICE units.
 *
 * `data` prefers what the feed actually measured and falls back to a configured figure, then to
 * the symbol's own default, so a bar with no stored spread is never silently free.
 */
export function spreadPriceAt(
  bar: Bar | undefined,
  symbol: SymbolSpec,
  config: CostConfig,
): number {
  const { source, fixedPoints, multiplier } = config.spread;
  if (source === 'none') return 0;

  const fallback = (fixedPoints > 0 ? fixedPoints : symbol.defaultSpreadPoints) * symbol.mintick;

  if (source === 'fixed') return fixedPoints * symbol.mintick * multiplier;

  const measured = bar?.spread;
  const price =
    measured != null && Number.isFinite(measured) && measured >= 0 ? measured : fallback;
  return price * multiplier;
}

/** Convert a price delta into a quote-currency amount for a position of `units`. */
export function priceDeltaToQuote(priceDelta: number, size: Units, symbol: SymbolSpec): number {
  return priceDelta * Math.abs(size) * symbol.pointValue;
}

/* --------------------------------------------------------------- financing */

export interface Rollover {
  readonly atMs: number;
  /** 1 normally, 3 on the triple-charge weekday. */
  readonly multiplier: number;
}

/**
 * The rollovers a position held from `entryMs` to `exitMs` passed through.
 *
 * Boundary rule: `entryMs < r <= exitMs`. A position opened exactly at a rollover has not been
 * held through it; one closed exactly at a rollover has.
 */
export function rolloversBetween(entryMs: number, exitMs: number, config: CostConfig): Rollover[] {
  const { mode, swapFree, rolloverTimeZone, rolloverMinuteOfDay, tripleChargeWeekday } =
    config.financing;
  if (mode === 'none' || swapFree || exitMs <= entryMs) return [];

  return dailyLocalInstants(entryMs, exitMs, rolloverTimeZone, rolloverMinuteOfDay).map((atMs) => {
    const { dayOfWeek } = localClock(atMs, rolloverTimeZone);
    return {
      atMs,
      multiplier: tripleChargeWeekday !== null && dayOfWeek === tripleChargeWeekday ? 3 : 1,
    };
  });
}

/**
 * Funding intervals crossed, for crypto perpetuals: every `fundingIntervalHours` from the UTC
 * epoch, which is how exchanges anchor them (00:00/08:00/16:00 for an 8-hour rate).
 */
export function fundingIntervalsBetween(
  entryMs: number,
  exitMs: number,
  config: CostConfig,
): number[] {
  const { mode, swapFree, fundingIntervalHours } = config.financing;
  if (mode !== 'funding' || swapFree || exitMs <= entryMs) return [];

  const step = fundingIntervalHours * 3_600_000;
  const out: number[] = [];
  let at = Math.floor(entryMs / step) * step;
  while (at <= exitMs) {
    if (at > entryMs) out.push(at);
    at += step;
  }
  return out;
}

/**
 * Financing for one position, as a positive COST in the quote currency.
 *
 * Positive is a charge and negative a credit, because `financingCost` is summed into total
 * costs. Broker swap figures use the opposite sign convention — a negative `swapLongPoints`
 * means the broker takes money — so they are negated on the way in.
 */
export function financingCostQuote(
  side: TradeSide,
  size: Units,
  entryPrice: number,
  entryMs: number,
  exitMs: number,
  symbol: SymbolSpec,
  config: CostConfig,
): number {
  const f = config.financing;
  if (f.mode === 'none' || f.swapFree) return 0;

  const absUnits = units(Math.abs(size));

  if (f.mode === 'mt5Points') {
    const points = side === 'long' ? f.swapLongPoints : f.swapShortPoints;
    const perNightQuote = priceDeltaToQuote(points * symbol.mintick, absUnits, symbol);
    const nights = rolloversBetween(entryMs, exitMs, config).reduce(
      (sum, r) => sum + r.multiplier,
      0,
    );
    // Broker sign -> cost sign.
    return -perNightQuote * nights;
  }

  if (f.mode === 'annualPct') {
    const pct = side === 'long' ? f.annualPctLong : f.annualPctShort;
    const notional = absUnits * entryPrice * symbol.pointValue;
    // 365, not 365.25: brokers accrue per calendar night, and the triple charge is what
    // reconciles the count with the calendar.
    const perNight = (notional * (pct / 100)) / 365;
    const nights = rolloversBetween(entryMs, exitMs, config).reduce(
      (sum, r) => sum + r.multiplier,
      0,
    );
    return -perNight * nights;
  }

  // funding: positive rate means longs pay shorts.
  const notional = absUnits * entryPrice * symbol.pointValue;
  const perInterval = notional * (f.fundingRatePct / 100);
  const intervals = fundingIntervalsBetween(entryMs, exitMs, config).length;
  return (side === 'long' ? perInterval : -perInterval) * intervals;
}

/* ----------------------------------------------------------------- overlay */

export interface ApplyCostsParams {
  readonly trades: readonly EngineTrade[];
  /** The bars the run executed on, used for per-bar spreads. */
  readonly bars: readonly Bar[];
  readonly symbol: SymbolSpec;
  readonly config: CostConfig;
  readonly quoteToAccount: QuoteToAccount;
  /**
   * What the stored prices represent. Decides WHICH fill pays the spread.
   *
   * Defaults to `bid`, which is what this overlay assumed unconditionally before feeds with a
   * different basis were ingested. Passing it explicitly is what makes a mid feed cost correctly.
   */
  readonly basis?: PriceBasis;
  /**
   * Per-fill slippage, measured against each fill's unslipped reference.
   *
   * Omit it and the old nominal formula is used, which assumes both fills of every trade slip by
   * the configured amount. Supplying it makes the waterfall's slippage line equal to what was
   * actually charged.
   */
  readonly measuredSlippage?: readonly FillSlippage[];
}

/**
 * Apply the overlay to the engine's CLOSED trades.
 *
 * Open trades are excluded: they have no exit, so their spread and financing are not yet
 * settled. Their unrealised P&L is reported separately by equity reconstruction.
 *
 * The P&L identity, which `packages/metrics/src/cost-drag.ts` depends on:
 *
 *     grossPnl = enginePnl + commission + slippageCost + slippageRefund   (no costs at all)
 *     netPnl   = grossPnl - commission - slippageCost - spreadCost - financingCost
 *              = enginePnl + slippageRefund - spreadCost - financingCost
 *
 * `slippageRefund` appears in gross because the engine DID take it out of the fill price, and is
 * not subtracted again on the way to net — that is what refunding it means. The identity
 * `gross - totalCosts === net` therefore still holds with `totalCosts` excluding the refund.
 *
 * Commission and slippage are already inside `enginePnl`, so they are added back to recover
 * the true gross and then subtracted again in the waterfall. They are not charged twice.
 */
export function applyCosts(params: ApplyCostsParams): CostedTrade[] {
  const { trades, bars, symbol, config, quoteToAccount, basis = 'bid', measuredSlippage } = params;

  const barByIndex = (index: number | null): Bar | undefined =>
    index === null || index < 0 ? undefined : bars[index];

  const closed = trades.filter(
    (t) => t.status === 'closed' && t.exitTime !== null && t.exitPrice !== null,
  );

  return closed.map((trade, i) => {
    // Branded as UNITS (contracts), which is what the engine reports. The conversion to lots
    // happens once, below, through `unitsToLots` — the two mix-ups this guards against both came
    // from treating one as the other.
    const positionUnits = units(trade.qty);
    const exitTime = trade.exitTime as number;

    // One spread per round trip on every basis — what the basis decides is which FILL pays it.
    //
    // On a bid feed the stored price is already the sell price, so only the buying leg is charged:
    // a long pays at entry, a short at exit. On a mid feed neither leg is the stored price, so each
    // pays half. The totals agree only when the spread and the FX rate are identical at both legs;
    // with per-bar spreads they diverge, which is the point of charging them where they happen.
    const entryAction = trade.side === 'long' ? 'buy' : 'sell';
    const exitAction = trade.side === 'long' ? 'sell' : 'buy';
    const entryShare = spreadShare(basis, entryAction);
    const exitShare = spreadShare(basis, exitAction);

    const legSpread = (share: number, bar: Bar | undefined, at: number): number =>
      share === 0
        ? 0
        : priceDeltaToQuote(spreadPriceAt(bar, symbol, config) * share, positionUnits, symbol) *
          quoteToAccount(at);

    const spreadCost =
      legSpread(entryShare, barByIndex(trade.entryBar), trade.entryTime) +
      legSpread(exitShare, barByIndex(trade.exitBar), exitTime);

    const financingCost =
      financingCostQuote(
        trade.side,
        positionUnits,
        trade.entryPrice,
        trade.entryTime,
        exitTime,
        symbol,
        config,
      ) * quoteToAccount(exitTime);

    // The engine charged commission at the fill; convert it at the exit, which is when the
    // round trip settled.
    const commission = trade.commission * quoteToAccount(exitTime);

    // Slippage is attribution only — the engine already moved the fill price, so this explains
    // where part of enginePnl went rather than charging anything new. MEASURED per fill when the
    // caller supplies the measurement, because the old form was `2 x slippagePoints x mintick`, an
    // assumption that both fills slip stated as a comment and never checked. A nominal figure here
    // means the costs SHOWN can differ from the costs TAKEN.
    const slippagePrice =
      measuredSlippage === undefined
        ? 2 * config.slippagePoints * symbol.mintick
        : slippageForTrade(measuredSlippage, i + 1, CHARGED_FILL_TYPES);
    const slippageCost =
      priceDeltaToQuote(slippagePrice, positionUnits, symbol) * quoteToAccount(exitTime);

    // The engine slipped LIMIT fills too (A28), which no real broker does — a limit fills at its
    // price or better. That amount is credited back, as its own line rather than silently.
    const refundPrice =
      measuredSlippage === undefined ? 0 : slippageForTrade(measuredSlippage, i + 1, ['limit']);
    const slippageRefund =
      priceDeltaToQuote(refundPrice, positionUnits, symbol) * quoteToAccount(exitTime);

    const enginePnl = (trade.netPnl ?? 0) * quoteToAccount(exitTime);
    // The refund is ADDED because the engine already took it out of the fill price.
    const netPnl = enginePnl + slippageRefund - spreadCost - financingCost;

    return {
      seq: i + 1,
      side: trade.side,
      qty: unitsToLots(positionUnits, symbol.contractSize),
      entryTime: trade.entryTime,
      exitTime,
      entryBar: trade.entryBar,
      exitBar: trade.exitBar ?? -1,
      entryPrice: price(trade.entryPrice),
      exitPrice: price(trade.exitPrice as number),
      grossPnl: accountMoney(enginePnl),
      commission: accountMoney(commission),
      slippageCost: accountMoney(slippageCost),
      slippageRefund: accountMoney(slippageRefund),
      spreadCost: accountMoney(spreadCost),
      financingCost: accountMoney(financingCost),
      netPnl: accountMoney(netPnl),
      mae: trade.maxDrawdown === null ? null : accountMoney(-Math.abs(trade.maxDrawdown)),
      mfe: trade.maxRunup === null ? null : accountMoney(Math.abs(trade.maxRunup)),
      barsHeld: trade.exitBar === null ? null : trade.exitBar - trade.entryBar,
      exitReason: trade.exitId,
    };
  });
}
