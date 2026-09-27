import { describe, expect, it } from 'vitest';
import type { Bar, ClosedTrade } from '@edgelab/shared';
import { type CheckInput, isRunTrustworthy, runChecks } from './check';
import {
  BUILT_IN_CHECKS,
  MIN_TRADES_FOR_CONFIDENCE,
  MIN_TRADES_TO_JUDGE,
  barIntegrityCheck,
  sampleSizeCheck,
  tradeWindowCheck,
} from './checks';

const H1 = 3_600_000;
const t0 = Date.UTC(2024, 0, 15, 0, 0);

function bars(count: number): Bar[] {
  return Array.from({ length: count }, (_, i) => ({
    time: t0 + i * H1,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1,
  }));
}

function trades(count: number, pnl = 10): ClosedTrade[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    side: 'long' as const,
    entryTime: t0 + i * H1,
    exitTime: t0 + i * H1 + 60_000,
    netPnl: pnl,
  }));
}

function input(over: Partial<CheckInput> = {}): CheckInput {
  return {
    bars: bars(100),
    timeframe: 'H1',
    trades: trades(40),
    equity: [],
    initialCapital: 10_000,
    ...over,
  };
}

describe('barIntegrityCheck', () => {
  it('passes a clean series', () => {
    const r = barIntegrityCheck.run(input());
    expect(r.status).toBe('pass');
    expect(r.evidence?.['duplicates']).toBe(0);
  });

  it('reports n/a when there are no bars', () => {
    // A2: no bars is "cannot tell", not "fine".
    const r = barIntegrityCheck.run(input({ bars: [] }));
    expect(r.status).toBe('n/a');
    expect(r.inconclusiveReason).toMatch(/no bars/i);
  });

  it('fails on duplicate timestamps', () => {
    const b = bars(5);
    const dupe = b[2];
    if (dupe === undefined) throw new Error('fixture');
    const r = barIntegrityCheck.run(
      input({ bars: [...b.slice(0, 3), { ...dupe }, ...b.slice(3)] }),
    );
    expect(r.status).toBe('fail');
    expect(r.evidence?.['duplicates']).toBe(1);
  });

  it('fails on out-of-order bars', () => {
    const r = barIntegrityCheck.run(input({ bars: bars(5).reverse() }));
    expect(r.status).toBe('fail');
    expect(r.evidence?.['outOfOrder']).toBeGreaterThan(0);
  });

  it('fails when high is below low', () => {
    const b = bars(3);
    const r = barIntegrityCheck.run(
      input({ bars: [...b.slice(0, 1), { ...b[1]!, high: 90, low: 95 }, ...b.slice(2)] }),
    );
    expect(r.status).toBe('fail');
    expect(r.evidence?.['badOhlc']).toBe(1);
  });

  it('fails when close sits outside the high/low range', () => {
    const b = bars(2);
    const r = barIntegrityCheck.run(input({ bars: [{ ...b[0]!, close: 500 }, b[1]!] }));
    expect(r.status).toBe('fail');
    expect(r.evidence?.['badOhlc']).toBe(1);
  });

  it('is critical, so it sinks trustworthiness', () => {
    expect(barIntegrityCheck.severity).toBe('critical');
    const r = barIntegrityCheck.run(input({ bars: bars(5).reverse() }));
    expect(isRunTrustworthy([r])).toBe(false);
  });
});

describe('sampleSizeCheck', () => {
  it('passes at or above the threshold', () => {
    expect(sampleSizeCheck.run(input({ trades: trades(MIN_TRADES_FOR_CONFIDENCE) })).status).toBe(
      'pass',
    );
  });

  it('WARNS just below the confidence threshold', () => {
    // Spec 06: warn under 30, fail under 10. 29 trades is thin, not worthless.
    const r = sampleSizeCheck.run(input({ trades: trades(MIN_TRADES_FOR_CONFIDENCE - 1) }));
    expect(r.status).toBe('warn');
    expect(r.evidence?.['trades']).toBe(MIN_TRADES_FOR_CONFIDENCE - 1);
  });

  it('fails below the judge-at-all threshold', () => {
    const r = sampleSizeCheck.run(input({ trades: trades(MIN_TRADES_TO_JUDGE - 1) }));
    expect(r.status).toBe('fail');
  });

  it('reports n/a on zero trades rather than blaming the strategy', () => {
    // A2: a window that never triggered the strategy is not a failure of the strategy. This
    // matters on walk-forward folds, where a short segment legitimately trades nothing.
    const r = sampleSizeCheck.run(input({ trades: [] }));
    expect(r.status).toBe('n/a');
    expect(r.inconclusiveReason).toMatch(/no closed trades/i);
  });

  it('is only a warning, so it does not sink trustworthiness', () => {
    const r = sampleSizeCheck.run(input({ trades: trades(3) }));
    expect(isRunTrustworthy([r])).toBe(true);
  });
});

describe('tradeWindowCheck', () => {
  it('passes when trades sit inside the bar range', () => {
    expect(tradeWindowCheck.run(input()).status).toBe('pass');
  });

  it('allows an exit on the final bar', () => {
    const b = bars(10);
    const last = b[b.length - 1]!;
    const r = tradeWindowCheck.run(
      input({
        bars: b,
        trades: [
          { seq: 1, side: 'long', entryTime: last.time, exitTime: last.time + H1, netPnl: 5 },
        ],
      }),
    );
    expect(r.status).toBe('pass');
  });

  it('fails a trade entering before the data starts', () => {
    const r = tradeWindowCheck.run(
      input({
        trades: [{ seq: 1, side: 'long', entryTime: t0 - H1, exitTime: t0 + H1, netPnl: 5 }],
      }),
    );
    expect(r.status).toBe('fail');
    expect(r.evidence?.['outside']).toBe(1);
  });

  it('fails a trade exiting after the data ends', () => {
    const b = bars(10);
    const last = b[b.length - 1]!;
    const r = tradeWindowCheck.run(
      input({
        bars: b,
        trades: [{ seq: 1, side: 'long', entryTime: t0, exitTime: last.time + 10 * H1, netPnl: 5 }],
      }),
    );
    expect(r.status).toBe('fail');
  });

  it('fails a trade that exits before it enters', () => {
    const r = tradeWindowCheck.run(
      input({
        trades: [{ seq: 1, side: 'long', entryTime: t0 + 5 * H1, exitTime: t0 + H1, netPnl: 5 }],
      }),
    );
    expect(r.status).toBe('fail');
    expect(r.evidence?.['inverted']).toBe(1);
  });

  it('skips with no trades or no bars', () => {
    expect(tradeWindowCheck.run(input({ trades: [] })).status).toBe('n/a');
    expect(tradeWindowCheck.run(input({ bars: [] })).status).toBe('n/a');
  });
});

describe('runChecks', () => {
  it('preserves order and returns one result per check', () => {
    const results = runChecks(BUILT_IN_CHECKS, input());
    expect(results).toHaveLength(BUILT_IN_CHECKS.length);
    expect(results.map((r) => r.id)).toEqual(BUILT_IN_CHECKS.map((c) => c.id));
  });

  it('reports a clean run as trustworthy', () => {
    expect(isRunTrustworthy(runChecks(BUILT_IN_CHECKS, input()))).toBe(true);
  });

  it('every built-in check has a unique id and a non-empty label', () => {
    const ids = BUILT_IN_CHECKS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of BUILT_IN_CHECKS) expect(c.label.length).toBeGreaterThan(0);
  });
});
