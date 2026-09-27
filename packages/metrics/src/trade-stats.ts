import type { CostedTrade, TradeSide } from '@edgelab/shared';
import { maxOf, minOf, safeDivide, sum } from './stats';
import type { SideStats } from './types';

/**
 * Trade statistics over closed trades, computed separately for All, Long and Short.
 *
 * Classification (per the spec): win = net P&L > 0, loss < 0, otherwise BREAKEVEN. A
 * breakeven trade is neither — counting it as a loss would understate the win rate, and
 * counting it as a win would overstate it.
 *
 * Every figure is after costs, in the account currency.
 */

export function emptySideStats(): SideStats {
  return {
    trades: 0,
    wins: 0,
    losses: 0,
    breakEven: 0,
    netProfit: 0,
    grossProfit: 0,
    grossLoss: 0,
    winRatePct: null,
    profitFactor: null,
    avgTrade: null,
    avgWin: null,
    avgLoss: null,
    winLossRatio: null,
    expectancy: null,
    expectancyPct: null,
    largestWin: null,
    largestLoss: null,
    maxConsecutiveWins: 0,
    maxConsecutiveLosses: 0,
    currentStreak: 0,
    avgBarsHeld: null,
    avgBarsHeldWins: null,
    avgBarsHeldLosses: null,
    avgMae: null,
    avgMfe: null,
  };
}

/** Chronological by exit, which is the order streaks must be measured in. */
export function byExitTime(trades: readonly CostedTrade[]): CostedTrade[] {
  return [...trades].sort((a, b) => a.exitTime - b.exitTime || a.seq - b.seq);
}

export function computeSideStats(
  trades: readonly CostedTrade[],
  initialCapital: number,
): SideStats {
  if (trades.length === 0) return emptySideStats();

  const ordered = byExitTime(trades);

  const winPnls: number[] = [];
  const lossPnls: number[] = [];
  let breakEven = 0;

  const winBars: number[] = [];
  const lossBars: number[] = [];
  const allBars: number[] = [];
  const maes: number[] = [];
  const mfes: number[] = [];

  for (const t of ordered) {
    if (t.netPnl > 0) winPnls.push(t.netPnl);
    else if (t.netPnl < 0) lossPnls.push(t.netPnl);
    else breakEven += 1;

    if (t.barsHeld !== null) {
      allBars.push(t.barsHeld);
      if (t.netPnl > 0) winBars.push(t.barsHeld);
      else if (t.netPnl < 0) lossBars.push(t.barsHeld);
    }
    if (t.mae !== null) maes.push(t.mae);
    if (t.mfe !== null) mfes.push(t.mfe);
  }

  const count = ordered.length;
  const grossProfit = sum(winPnls);
  // Reported as a positive magnitude.
  const grossLoss = Math.abs(sum(lossPnls));
  const netProfit = grossProfit - grossLoss;

  const avgWin = winPnls.length > 0 ? grossProfit / winPnls.length : null;
  // Kept NEGATIVE, so the UI does not have to guess the sign.
  const avgLoss = lossPnls.length > 0 ? sum(lossPnls) / lossPnls.length : null;
  const avgTrade = netProfit / count;

  return {
    trades: count,
    wins: winPnls.length,
    losses: lossPnls.length,
    breakEven,
    netProfit,
    grossProfit,
    grossLoss,
    winRatePct: (winPnls.length / count) * 100,
    profitFactor: safeDivide(grossProfit, grossLoss),
    avgTrade,
    avgWin,
    avgLoss,
    winLossRatio:
      avgWin === null || avgLoss === null ? null : safeDivide(avgWin, Math.abs(avgLoss)),
    expectancy: avgTrade,
    // The same quantity as a percentage of starting capital.
    expectancyPct: initialCapital > 0 ? (avgTrade / initialCapital) * 100 : null,
    largestWin: maxOf(winPnls),
    largestLoss: minOf(lossPnls),
    maxConsecutiveWins: longestStreak(ordered, (t) => t.netPnl > 0),
    maxConsecutiveLosses: longestStreak(ordered, (t) => t.netPnl < 0),
    currentStreak: currentStreak(ordered),
    avgBarsHeld: allBars.length > 0 ? sum(allBars) / allBars.length : null,
    avgBarsHeldWins: winBars.length > 0 ? sum(winBars) / winBars.length : null,
    avgBarsHeldLosses: lossBars.length > 0 ? sum(lossBars) / lossBars.length : null,
    avgMae: maes.length > 0 ? sum(maes) / maes.length : null,
    avgMfe: mfes.length > 0 ? sum(mfes) / mfes.length : null,
  };
}

/**
 * Longest run of consecutive trades satisfying `predicate`. Anything failing the predicate
 * breaks the run — including a breakeven trade, which interrupts both a winning and a
 * losing streak.
 */
export function longestStreak(
  trades: readonly CostedTrade[],
  predicate: (t: CostedTrade) => boolean,
): number {
  let best = 0;
  let run = 0;
  for (const t of trades) {
    if (predicate(t)) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 0;
    }
  }
  return best;
}

/**
 * The streak still running at the end: positive for n consecutive wins, negative for n
 * consecutive losses, 0 when the last trade was breakeven.
 */
export function currentStreak(ordered: readonly CostedTrade[]): number {
  const last = ordered[ordered.length - 1];
  if (last === undefined || last.netPnl === 0) return 0;

  const wantWin = last.netPnl > 0;
  let run = 0;
  for (let i = ordered.length - 1; i >= 0; i -= 1) {
    const pnl = ordered[i]!.netPnl;
    if (wantWin ? pnl > 0 : pnl < 0) run += 1;
    else break;
  }
  return wantWin ? run : -run;
}

export function filterSide(trades: readonly CostedTrade[], side: TradeSide): CostedTrade[] {
  return trades.filter((t) => t.side === side);
}

/**
 * Verifies the spec's identity: Expectancy === WinRate * AvgWin - LossRate * |AvgLoss|.
 *
 * Exported so the test suite can assert it on every fixture rather than on one example.
 * Returns null when the inputs make it undefined (no wins or no losses).
 */
export function expectancyFromRates(stats: SideStats): number | null {
  if (stats.trades === 0 || stats.avgWin === null || stats.avgLoss === null) return null;
  const winRate = stats.wins / stats.trades;
  const lossRate = stats.losses / stats.trades;
  return winRate * stats.avgWin - lossRate * Math.abs(stats.avgLoss);
}
