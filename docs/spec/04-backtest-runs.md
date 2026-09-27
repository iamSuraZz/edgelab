# 04 — Backtest runs, cost model and equity curve

> **Amended by [docs/decisions.md](../decisions.md)** — D5 (rollover 17:00 America/New_York), D6 (quoteToAccount rate function), D8.
> Where this spec and that file disagree, the decisions file wins.

> Saved verbatim from the phase prompt before implementation, per the PROJECT.md convention.

---

Phase 4: Backtest runs, cost model and equity curve. Save this prompt to docs/spec/04-backtest-runs.md, then implement.

RUNS
- POST /backtests { source or strategyVersionId, symbol, tf, from, to, inputs, props, costs } -> BullMQ "backtest" job with SSE progress; cancellable.
- CRUD for strategies and versions; "Save" in Studio creates a new version when the source hash changes.
- Persist everything needed to reproduce a run: config, script hash, engine version, data version.
- Warmup: load extra bars before "from" (default 500, configurable) and use the trading-window gate so no position opens before "from". Without the gate, start at "from" and report how many bars indicators needed to warm up.
- Tables: strategies, strategy_versions, backtest_runs (config, status, timings, summary), run_trades, run_series (equity curves as compressed blobs, not one row per bar).

COST MODEL (overlay on the engine's trades; the engine already applies commission and slippage)
- Spread: bars are bid prices, so charge one spread per round trip. Longs pay the spread at the entry bar, shorts at the exit bar. Use per-bar spread from data when present, otherwise the symbol's fixed spread. cost = spread \* |qty| \* pointValue, converted to account currency.
- Borrowing / funding modes:
  - none;
  - mt5Points (swap long/short in points per lot per night);
  - annualPct (long/short % per year of notional);
  - funding (rate % every N hours, for crypto perps).
  Charge at each rollover a position is held through. Rollover time is configurable (default 00:00 UTC), as is the triple-charge weekday (default Wednesday). A "swap-free" toggle disables charging.
- Store per trade: commission, slippageCost (estimate: ticks \* mintick \* qty per market/stop fill), spreadCost, financingCost, netPnlAfterCosts, plus the engine's original P&L.

EQUITY RECONSTRUCTION (packages/engine, pure)
- From bars + trades + costs, build a bar-by-bar mark-to-market equity curve in account currency (initial capital + realized + open P&L at each close).
- Also build an intrabar-worst curve (open longs marked at the bar low, shorts at the bar high).
- Daily and monthly samples (last bar of each UTC day/month) for metrics; buy & hold benchmark over the same window.
- Cross-check: with overlay costs set to zero, reconstructed realized P&L must equal the engine's netprofit within 0.01%; otherwise show a red banner in the report.

UI: Studio settings panel and first results
- Right panel: symbol search, MT5 timeframe chips, date range with presets (1M 3M 6M 1Y 3Y Max), capital, account currency, leverage, sizing (lots | units | cash | % equity; lots use contractSize).
- A "Slippage & Costs" accordion in the same panel: commission type/value, slippage buffer in ticks, spread source, borrowing/funding. Plus a "Reset to script defaults" button.
- Run button (Ctrl/Cmd+Enter) with progress bar and cancel.
- Chart tab: candles with entry/exit markers (coloured by side, tooltip with P&L), script plots as overlays, SL/TP lines from orderLog when available.
- Trades tab: virtualized table (#, side, entry/exit time and price, qty in lots and units, P&L, P&L %, cost breakdown, MAE, MFE, bars held, exit reason), filters, CSV export.

DONE WHEN: an EURUSD H1 run with spread and commission shows trades on the chart and in the table, costs visibly reduce P&L, and the cross-check passes. Update PROJECT.md and commit.
