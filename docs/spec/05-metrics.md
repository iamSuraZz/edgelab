# 05 — Metrics engine and results dashboard

> **Amended by [docs/decisions.md](../decisions.md)** — D8 (build order replaced by docs/spec/08-roadmap.md).
> Where this spec and that file disagree, the decisions file wins.

> Saved verbatim from the phase prompt before implementation, per the PROJECT.md convention.
> A worked example is appended after the prompt, as the prompt requires.

---

Phase 5: Metrics engine and results dashboard. Save this prompt to docs/spec/05-metrics.md, then implement.

RULES
- packages/metrics is pure: input { trades after costs, equity curves, daily and monthly samples, initialCapital, window, rfAnnual } -> typed MetricsReport. Trade statistics are computed for All, Long and Short.
- Every metric has an entry in the shared metric dictionary (label, unit, formula text for tooltips, direction). Undefined values are null, never NaN/Infinity; the UI shows "—" or "∞" with a tooltip explaining why.
- Win = net P&L > 0, loss < 0, otherwise breakeven. All P&L is after costs, in account currency.

PERFORMANCE & PROFITABILITY
- Net Profit = sum of closed-trade net P&L. Total Return % = Net Profit / Initial Capital * 100. Show open P&L separately.
- CAGR = (Final Equity / Initial Capital)^(365.25 / days) - 1 over the test window's calendar days; label windows under a year "annualized from a short window".
- Gross Profit = sum of winning trades; Gross Loss = |sum of losing trades|.
- Profit Factor = Gross Profit / Gross Loss.
- Recovery Factor = Net Profit / Max Drawdown (currency, intrabar).

RISK & DRAWDOWN
- Max Drawdown: largest peak-to-trough decline, in currency and % of peak, on both the close-to-close and intrabar-worst curves (intrabar is the headline figure).
- Drawdown Duration: longest time from an equity peak until equity first regains it, in bars and days. If never regained, measure to the end and label it "unrecovered". Also show average duration and % of time underwater.
- Sharpe (annualized): daily returns r from daily equity. Sharpe = (mean(r) - rf_d) / stdev(r) * sqrt(P), where:
  - stdev is the sample stdev;
  - P = daily returns per year observed in this dataset (≈260 fx, 365 crypto);
  - rf_d = (1 + rfAnnual)^(1/P) - 1, rfAnnual default 0.
- Sortino (annualized): (mean(r) - rf_d) / DD * sqrt(P), with DD = sqrt(sum(min(0, r - rf_d)^2) / N) over all N days.
- Also show TradingView-style Sharpe and Sortino as secondary values (monthly returns, rf 2%/12, population stdev, not annualized) so I can compare with TradingView.
- Ulcer Index: D_i = 100 * (E_i - peak_i) / peak_i on daily equity; UI = sqrt(mean(D_i^2)). Also Ulcer Performance Index = (CAGR% - rf%) / UI.

TRADE LOGISTICS & STATISTICS
- Total closed trades (plus open at end). Win Rate = wins / closed trades.
- Profit Expectancy (avg trade) = Net Profit / closed trades, in currency and as mean trade return %. Assert it equals WinRate * AvgWin - LossRate * |AvgLoss|.
- Win/Loss Ratio = Avg Win / |Avg Loss| (payoff ratio), plus the wins:losses count.
- Max consecutive wins and losses (ordered by exit time) and the current streak.
- Extras: largest win/loss, avg bars held (wins vs losses), avg MAE/MFE, exposure %, trades per month, buy & hold return, monthly returns table (year x month).

SLIPPAGE & COST DRAG
- Totals and per-trade averages of commission, slippage, spread and borrowing/funding.
- Cost Drag % = total costs / (net profit + total costs).
- Break-even extra cost per side = Net Profit / (2 * sum of |qty| * pointValue), converted to quote currency and shown in price units, ticks and pips. This is how much worse execution the edge can survive.

TESTS
- Hand-computed fixtures for every metric. Edge cases: zero trades, no losing trades, one day of data, flat equity, unrecovered drawdown. Put one worked example in docs/spec/05-metrics.md.

UI: Results
- KPI strip: Net Profit, Return %, CAGR, Profit Factor, Max DD %, Sharpe, Win Rate, Trades, with delta vs buy & hold. Tabular numerals; profit/loss colours plus +/- signs.
- Tabs:
  - Overview: equity curve with buy & hold, drawdown pane, monthly returns heatmap;
  - "Performance & Profitability";
  - "Risk & Drawdown";
  - "Trade Logistics & Statistics" (All / Long / Short columns);
  - "Slippage & Cost Drag" (waterfall: gross -> commission -> slippage -> spread -> funding -> net);
  - Chart and Trades;
  - "Integrity & Overfitting" (next phase).
- Formula tooltip on every metric. Export the report as JSON; print stylesheet for PDF.

DONE WHEN: all metrics render for a real run, tests pass, and the worked example matches. Update PROJECT.md and commit.

---

## Worked example

Appended after implementation. Every number below is asserted in
`packages/metrics/src/report.worked-example.test.ts`, so this document and the code cannot
drift apart — if a formula changes, that test fails.

### Input

Initial capital **10,000**, account currency USD, window **2024-01-01 → 2024-03-31**
(90 calendar days), `rfAnnual = 0`. Five closed trades, all 1 lot of a 5-digit fx pair
(`mintick` 0.00001, `pipSize` 0.0001, `pointValue` 1, `contractSize` 100,000):

| # | side  | exit day | gross P&L | commission | slippage | spread | funding | **net** |
| - | ----- | -------- | --------- | ---------- | -------- | ------ | ------- | ------- |
| 1 | long  | Jan 10   | +520      | 7          | 3        | 10     | 0       | **+500** |
| 2 | short | Jan 25   | −180      | 7          | 3        | 10     | 0       | **−200** |
| 3 | long  | Feb 12   | +320      | 7          | 3        | 10     | 0       | **+300** |
| 4 | long  | Feb 28   | −280      | 7          | 3        | 10     | 0       | **−300** |
| 5 | short | Mar 15   | +420      | 7          | 3        | 10     | 0       | **+400** |

Totals: commission 35, slippage 15, spread 50, funding 0 → **total costs 100**.

### Expected output

**Performance**

- Net Profit = 500 − 200 + 300 − 300 + 400 = **700**
- Total Return % = 700 / 10,000 × 100 = **7.00 %**
- Gross Profit = 500 + 300 + 400 = **1,200**; Gross Loss = |−200 − 300| = **500**
- Profit Factor = 1,200 / 500 = **2.40**
- Final equity = 10,700. Days = 90, so
  CAGR = (10,700/10,000)^(365.25/90) − 1 = **31.60 %**, flagged
  `annualizedFromShortWindow: true` because the window is under a year.
  (Check: ln 1.07 = 0.0676586, × 365.25/90 = 4.058333 → 0.2745812, e^that = 1.315979.)

**Trade statistics (All)**

- Closed = **5**, wins = 3, losses = 2, breakeven = 0
- Win Rate = 3/5 = **60 %**
- Avg Win = 1,200/3 = **400**; Avg Loss = −500/2 = **−250**
- Expectancy = 700/5 = **140**, and the identity holds:
  0.6 × 400 − 0.4 × 250 = 240 − 100 = **140** ✓
- Win/Loss (payoff) = 400 / 250 = **1.60**
- Largest win **500**, largest loss **−300**
- Ordered by exit time the sequence is W L W L W, so max consecutive wins = **1**,
  max consecutive losses = **1**, current streak = **+1**

**By side** — Long: 3 trades (+500, +300, −300) → net **500**, win rate **66.67 %**.
Short: 2 trades (−200, +400) → net **200**, win rate **50 %**.

**Cost drag**

- Total costs = **100**
- Cost Drag % = 100 / (700 + 100) = **12.50 %**
- Break-even extra cost per side: total |qty| = 5 lots ⇒ 5 × 100,000 = 500,000 units.
  700 / (2 × 500,000 × 1) = **0.0007 price units** = **70 ticks** = **7.0 pips**.
  Execution can get 7 pips per side worse before the edge disappears.

**Drawdown** (trade-marked equity 10,000 → 10,500 → 10,300 → 10,600 → 10,300 → 10,700)

- Peak 10,600 at trade 3, trough 10,300 at trade 4 ⇒ Max DD = **300**, **2.83 %** of peak
- Recovery Factor = 700 / 300 = **2.33**
