# 06 — Integrity & overfitting validation

> **Amended by [docs/decisions.md](../decisions.md)** — D8 (build order replaced by docs/spec/08-roadmap.md).
> Where this spec and that file disagree, the decisions file wins.

> Saved verbatim from the phase prompt before implementation, per the PROJECT.md convention.

---

Phase 6: Integrity & overfitting validation. Save this prompt to docs/spec/06-validation.md. Show me a plan before writing code.

GENERAL
- POST /backtests/:id/validate { checks[], options } -> one "validation" job that fans sub-runs out to the piscina pool. Show an ETA before starting; SSE progress.
- Each check returns { status: pass | warn | fail | n/a, headline, details, evidence (bars, trades, times), thresholds }. All thresholds live in one config object with the defaults below, editable in Settings.
- Overall verdict = worst status among the critical checks (look-ahead, execution). No single magic score.
- Sample-size guard on every segment: warn under 30 closed trades, fail under 10.

1) LOOK-AHEAD BIAS CHECK
- Static lint: a tokenizer that skips comments and strings (no full parser).
  - Fail: request.security with lookahead_on (named or positional) where the requested expression has no [1]-or-larger offset.
  - Warn: barstate.isrealtime, timenow, varip, last_bar_index or last_bar_time in trading logic, calc_on_every_tick = true.
  - Report line numbers.
- Dynamic prefix-invariance test (the definitive check): run on the full range, then on 6 truncated ranges using DbProvider.dataCutoffTs so higher-timeframe bars are truncated too. Every order and trade decided on bars strictly before a cutoff must match the full run (same bars, side, qty, prices within 1e-9), and so must every plotted series. Any divergence = fail, reporting the first divergent bar, its time and both values.

2) EXECUTION BIAS CHECK
- Fill audit:
  - every fill must be inside its bar's [low, high], otherwise fail (engine or data bug);
  - market fills happen at the next bar's open ± slippage, except documented same-bar cases (process_orders_on_close, strategy.close immediately);
  - limit fills where price only touched the level: count them and recompute P&L as if 1 tick of penetration were required.
- Same-bar execution: if process_orders_on_close or calc_on_order_fills is on, re-run with them off and compare. Sign flip = fail; more than 30% worse = warn.
- Intrabar ambiguity (bar-magnifier audit): from orderLog, find bars where both the active stop and the target sat inside the bar range. Replay those bars on M1 to see which level was actually hit first; report trades whose outcome flips and the corrected net profit. Without orderLog, mark n/a with an explanation.
- Bid/ask asymmetry: bars are bid, so short-side stops and targets trigger up to one spread off. Estimate the impact from the short trades and their spreads.
- Cost stress: re-run with slippage +1, +2 and +5 ticks and spread x1.5 and x2. Chart net profit against added cost and mark the break-even point.

3) OUT-OF-SAMPLE (OOS) TESTING
- Split test: IS/OOS boundary (default: last 30% is OOS). Compute all metrics for both segments plus OOS/IS degradation ratios for Sharpe, profit factor, expectancy and win rate. Warn if OOS profit factor < 1 while IS > 1.2, or if OOS Sharpe < 50% of IS.
- Walk-forward optimization setup:
  - I choose which inputs to optimize (ranges prefilled from InputSpec min/max/step, editable), an objective (Sharpe, profit factor, net profit, or return / max DD) and a minimum trade count;
  - rolling or anchored folds (default 5 folds, 70/30);
  - cap on parameter combinations (default 300; random sampling above the cap).
- Per fold: optimize on IS, then run the winner on OOS with warmup. Stitch the OOS segments into one equity curve and compute full metrics on it.
- Report Walk-Forward Efficiency = annualized OOS return / annualized IS return, parameter stability across folds, and a 2-input sensitivity heatmap to spot isolated peaks.
- Sealed holdout (toggle): reserve the most recent X% of data and exclude it from normal runs. "Unseal" runs on it once and records that; reports show "holdout viewed N times".

4) TIMEFRAME & REGIME VARIETY CHECK
- Timeframe matrix: same script and inputs on a chosen set (default M5, M15, M30, H1, H4). Show net profit, profit factor, Sharpe, max DD and trade count per timeframe as a table plus heatmap. Warn if profitable on under half of them. Optional: the same test across other symbols.
- Regimes from D1 bars:
  - direction = close above/below SMA(200);
  - trending if ADX(14) >= 25, else ranging -> uptrend / downtrend / range;
  - volatility = ATR(14)/close percentile over the trailing 252 days (expanding window when history is short) -> low / normal / high.
- Tag each trade by its entry day and compute metrics per regime cell. Warn if more than 70% of net profit comes from one regime or one calendar year, or if the top 5 trades make over half of net profit.
- Monte Carlo: 1,000 trade-order reshuffles (drawdown distribution) and 1,000 bootstrap resamples (final equity and drawdown). Show 5th/50th/95th percentiles.

UI: "Integrity & Overfitting" tab
- Checklist cards with a status badge, one-line headline, "why it matters" tooltip and expandable evidence. Clicking a divergent bar or trade jumps to it on the chart.
- Walk-forward fold timeline, IS vs OOS per fold, stitched OOS equity curve; timeframe and regime heatmaps; Monte Carlo fan chart.

DONE WHEN: a deliberately leaky fixture (request.security with lookahead_on and no [1]) fails the look-ahead check at the right line and first divergent bar, a clean fixture passes, and walk-forward runs end to end on EURUSD H1. Add both fixtures to the tests. Update PROJECT.md and commit.
