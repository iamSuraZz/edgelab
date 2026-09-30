/**
 * "Why it matters" for each check.
 *
 * Written for someone who has just been told their strategy failed and wants to know whether to
 * care. Each says what the check would catch and what it would mean — not how it works, which is
 * in `docs/decisions.md` and is not what a tooltip is for.
 *
 * Keyed by check id, so a check without an entry simply shows no tooltip rather than a placeholder.
 */
export const WHY_IT_MATTERS: Readonly<Record<string, string>> = {
  'lookahead-static': `Reads the source for the patterns that let a strategy see the future — barstate.islast, whole-series normalisation, request.security with lookahead_on. Fast and specific, but it can only recognise mistakes it knows about, which is why three other look-ahead checks exist.`,

  'lookahead-prefix-invariance': `Re-runs the strategy with the data cut short at six points and checks that its earlier decisions did not change. If knowing about later bars altered what it did on earlier ones, the backtest was trading on information it would not have had.`,

  'lookahead-future-splice': `Replaces a bounded window of the future with a different real segment and compares with no tolerance. This is the layer that catches a BOUNDED leak — one that peeks a fixed distance ahead — which truncation alone cannot, because the perturbation has to reach the leak.`,

  'lookahead-causality': `Records every request.security call and checks that each higher-timeframe value was actually closed and available at the bar that used it. Names the call site when it was not.`,

  'execution-fill-audit': `Checks every fill happened at a price its bar actually traded at. A fill outside the bar is an engine or data bug. A fill exactly on the bar's high or low is a fill that may never have happened — the market touched that price once and may not have filled you there.`,

  'execution-bid-ask-asymmetry': `A stop or target triggers when a QUOTE reaches it, not when the stored mid or bid does. A long exits by selling into the bid; a short exits by buying at the ask. The spread always works against you at a level, so a backtest that ignores it is flattered — and sometimes an exit would not have triggered at all.`,

  'execution-intrabar-replay': `A chart bar hides the order things happened in. When a stop and a target both sit inside one bar, four numbers cannot say which came first. This replays the holding period minute by minute and reports two errors: targets that never really filled, and stops that were crossed on an earlier bar the engine treated as uneventful. The second turns a loss into a win and is invisible in every other report.`,

  'execution-cost-stress': `Re-runs with costs scaled to find how many times its actual costs the strategy could pay before the profit vanishes. An edge that dies at 1.2x its spread is mostly an execution assumption; one that survives 5x is a different proposition.`,

  'overfitting-holdout': `Data reserved and excluded from ordinary runs. The point is not secrecy — it is that looking is counted, so a result on it means something the first time and less each time after. A holdout viewed nine times is in-sample data with extra steps.`,

  'overfitting-oos-split': `Fits on the first 70% and tests on the last 30%, each as its own run from the same starting capital. The question is not whether the out-of-sample half made money but whether whatever edge the first half showed survived into data the strategy was not shaped around.`,

  'overfitting-rolling-oos': `The same question asked repeatedly on rolling windows, with the script's own inputs unchanged. It answers something one split cannot: did the edge survive REPEATEDLY, or did it survive once by luck. Note that nothing is optimised here — a strategy whose inputs were hand-tuned on this data will sail through it.`,

  'overfitting-regimes': `Splits profit by the market regime in force when each trade opened. A strategy that makes everything in one trending quarter and gives it back in chop is a bet that the regime persists, and no headline metric shows that bet.`,

  'overfitting-timeframe-matrix': `Runs the same strategy on neighbouring bar sizes. An edge with a real basis degrades smoothly as the bar size changes; a fitted one falls off a cliff either side. This is a SHAPE to read, not a menu to pick the best cell from.`,

  'overfitting-monte-carlo': `Reshuffles the trades to show how bad the ride could have been in another order, and resamples them with replacement to show whether the profit could plausibly be luck. The final result does not move under reshuffling — only the path does — so the drawdown you were shown is one draw, and the 95th percentile is the figure to size around.`,

  'bar-integrity': `The bars themselves: ordered, unique, and internally coherent (high >= low, open and close inside the range). A failure here means every other number is computed on broken data.`,

  'trade-window': `Every trade sits inside the range that was loaded. A trade outside it means the engine saw data the run did not claim to cover.`,

  'sample-size': `How many closed trades the conclusions rest on. Thirty trades of a coin flip look like an edge often enough to matter, so a small sample is reported rather than assumed adequate.`,
};
