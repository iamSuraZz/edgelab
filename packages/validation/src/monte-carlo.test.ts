import { describe, expect, it } from 'vitest';

import { runMonteCarlo, type McTrade } from './monte-carlo';

/**
 * The claim that makes A43 matter: reshuffling the RIGHT quantity leaves the final result untouched
 * and moves only the path. A spread of final returns is the symptom of shuffling the wrong one.
 */

function trades(count: number, pnl: (i: number) => number, pct: (i: number) => number): McTrade[] {
  return Array.from({ length: count }, (_u, i) => ({ netPnl: pnl(i), returnPct: pct(i) }));
}

const MIXED = trades(
  60,
  (i) => (i % 3 === 0 ? -80 : 60),
  (i) => (i % 3 === 0 ? -0.8 : 0.6),
);

describe('runMonteCarlo — what gets shuffled', () => {
  it('permutes RETURNS under percent-of-equity sizing', () => {
    const r = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'percent-equity',
      initialCapital: 10_000,
      iterations: 200,
    });
    expect(r.quantity).toBe('return-pct');
  });

  it('permutes DOLLARS under fixed sizing', () => {
    const r = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 200,
    });
    expect(r.quantity).toBe('dollar-pnl');
  });

  it('refuses to guess when the sizing mode is unknown', () => {
    const r = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'unknown',
      initialCapital: 10_000,
    });

    expect(r.verdict).toBe('n/a');
    expect(r.quantity).toBeNull();
    expect(r.inconclusiveReason).toContain('looks authoritative and describes nothing');
  });

  it('drops trades with no return under percent-equity rather than approximating them', () => {
    const withHoles: McTrade[] = [
      ...MIXED,
      { netPnl: 500, returnPct: null },
      { netPnl: 500, returnPct: null },
    ];
    const r = runMonteCarlo({
      trades: withHoles,
      sizingMode: 'percent-equity',
      initialCapital: 10_000,
      iterations: 100,
    });

    expect(r.trades).toBe(MIXED.length);
  });
});

describe('runMonteCarlo — the path moves, the destination does not', () => {
  it('leaves the final return identical across orderings under FIXED sizing', () => {
    const a = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 300,
      seed: 1,
    });
    const b = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 300,
      seed: 99,
    });

    // Summing dollars is commutative, so a different seed cannot move the destination.
    expect(a.finalReturnPct).toBeCloseTo(b.finalReturnPct as number, 9);
  });

  it('leaves it identical under PERCENT-EQUITY sizing too', () => {
    const a = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'percent-equity',
      initialCapital: 10_000,
      iterations: 300,
      seed: 1,
    });
    const b = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'percent-equity',
      initialCapital: 10_000,
      iterations: 300,
      seed: 99,
    });

    // Multiplying growth factors is commutative as well.
    expect(a.finalReturnPct).toBeCloseTo(b.finalReturnPct as number, 9);
    expect(a.explanation).toContain('only the path moves');
  });

  it('DOES move the drawdown', () => {
    const r = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 400,
    });

    expect(r.maxDrawdownPct!.p95).toBeGreaterThan(r.maxDrawdownPct!.p5);
  });
});

describe('runMonteCarlo — determinism', () => {
  it('reproduces exactly for a given seed', () => {
    const one = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 200,
      seed: 7,
    });
    const two = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 200,
      seed: 7,
    });

    expect(JSON.stringify(one.maxDrawdownPct)).toBe(JSON.stringify(two.maxDrawdownPct));
  });
});

describe('runMonteCarlo — verdicts', () => {
  it('warns when the real ordering was a favourable draw', () => {
    // Perfectly alternating: no losing RUN ever accumulates, so the observed drawdown is about as
    // shallow as this trade set allows. Almost every shuffle clusters some losses and digs deeper.
    // (Putting all the losses last would do the opposite — it maximises drawdown, by building a
    // peak and then falling from it without recovery.)
    const alternating = trades(
      60,
      (i) => (i % 2 === 0 ? 100 : -50),
      (i) => (i % 2 === 0 ? 1 : -0.5),
    );
    const r = runMonteCarlo({
      trades: alternating,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 400,
    });

    expect(r.observedPercentile).toBeLessThanOrEqual(0.25);
    expect(r.verdict).toBe('warn');
    expect(r.explanation).toContain('favourable draw');
  });

  it('FAILS when some ordering wipes the account out', () => {
    // Losses big enough that an unlucky run of them ends at zero.
    const brutal = trades(
      60,
      (i) => (i % 2 === 0 ? -1800 : 1900),
      (i) => (i % 2 === 0 ? -18 : 19),
    );
    const r = runMonteCarlo({
      trades: brutal,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 400,
    });

    expect(r.riskOfRuinPct).toBeGreaterThan(0);
    expect(r.verdict).toBe('fail');
    expect(r.explanation).toContain('wipe the account out');
  });

  it('is n/a on too few trades rather than permuting noise', () => {
    const r = runMonteCarlo({
      trades: trades(
        8,
        () => 50,
        () => 0.5,
      ),
      sizingMode: 'fixed',
      initialCapital: 10_000,
    });

    expect(r.verdict).toBe('n/a');
    expect(r.inconclusiveReason).toContain('permutes noise');
  });
});

describe('runMonteCarlo — bootstrap', () => {
  it('DOES move the final return, unlike the reshuffle', () => {
    const r = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 500,
    });

    // The reshuffle cannot produce a spread here; resampling with replacement must.
    expect(r.bootstrap!.finalReturnPct.p95).toBeGreaterThan(r.bootstrap!.finalReturnPct.p5);
  });

  it('reports the share of resamples that lose money', () => {
    const r = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 500,
    });

    expect(r.bootstrap!.lossSharePct).toBeGreaterThanOrEqual(0);
    expect(r.bootstrap!.lossSharePct).toBeLessThanOrEqual(100);
    expect(r.explanation).toContain('of resamples losing money');
  });

  it('FAILS an edge indistinguishable from chance', () => {
    // Symmetric wins and losses: a resampled set is close to a coin flip.
    const coinFlip = trades(
      60,
      (i) => (i % 2 === 0 ? 100 : -99),
      (i) => (i % 2 === 0 ? 1 : -0.99),
    );
    const r = runMonteCarlo({
      trades: coinFlip,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 600,
    });

    // A third or more of equally plausible trade sets lose money, while the run itself profited.
    expect(r.bootstrap!.observedFinalReturnPct).toBeGreaterThan(0);
    expect(r.bootstrap!.lossSharePct).toBeGreaterThan(33);
    expect(r.verdict).toBe('fail');
    expect(r.explanation).toContain('not distinguishable from luck');
  });

  it('uses the same A43 quantity as the reshuffle', () => {
    const pct = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'percent-equity',
      initialCapital: 10_000,
      iterations: 200,
    });
    expect(pct.quantity).toBe('return-pct');
    expect(pct.bootstrap!.iterations).toBe(200);
  });
});

describe('runMonteCarlo — both tails of the reshuffle', () => {
  it('warns BELOW the 5th percentile: the ordering was lucky', () => {
    const alternating = trades(
      60,
      (i) => (i % 2 === 0 ? 100 : -50),
      (i) => (i % 2 === 0 ? 1 : -0.5),
    );
    const r = runMonteCarlo({
      trades: alternating,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 500,
    });

    expect(r.observedPercentile).toBeLessThan(0.05);
    expect(r.verdict).toBe('warn');
    expect(r.explanation).toContain('favourable draw');
  });

  it('warns ABOVE the 95th: the losses clustered', () => {
    // Every loss in one block at the end — the deepest arrangement there is, and one a random
    // permutation almost never reproduces.
    const clustered = [
      ...trades(
        40,
        () => 100,
        () => 1,
      ),
      ...trades(
        20,
        () => -150,
        () => -1.5,
      ),
    ];
    const r = runMonteCarlo({
      trades: clustered,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 500,
    });

    expect(r.observedPercentile).toBeGreaterThan(0.95);
    expect(r.verdict).toBe('warn');
    expect(r.explanation).toContain('CLUSTERED');
    expect(r.explanation).toContain('understates the risk');
  });

  it('names the 95th percentile as the figure to size around', () => {
    const r = runMonteCarlo({
      trades: MIXED,
      sizingMode: 'fixed',
      initialCapital: 10_000,
      iterations: 300,
    });

    expect(r.planningDrawdownPct).toBe(r.maxDrawdownPct!.p95);
    expect(r.explanation).toContain('size around');
  });
});
