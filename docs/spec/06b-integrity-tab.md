# 06b — The "Integrity & Overfitting" tab (slice D, step 3)

Saved verbatim from the session prompt, per the working agreement that every phase prompt is
recorded before implementation. `docs/decisions.md` overrides this where they disagree.

---

STEP 3 — the "Integrity & Overfitting" tab

- Verdict header: overall verdict (Inconclusive when a critical check is n/a), the seal line (id,
  views, retired seals), and any truncation notice.
- One card per check: status badge, headline, a "why it matters" tooltip, and expandable evidence.
  Clicking a bar or trade in the evidence jumps to it on the Chart tab.
- Every n/a and every withheld ratio shows its reason; null never renders as 0.
- Visuals:
  - cost stress curve with the break-even point;
  - flips table (missed stops, phantom targets) with pips per fill;
  - OOS split and rolling folds;
  - regime table with the unclassified share;
  - timeframe matrix with gross and net per cell, and no best-cell highlighting (it's a shape, not a
    menu);
  - Monte Carlo: reshuffle drawdown distribution with the observed value marked and p95 labelled as
    the figure to size around, plus the bootstrap final-return distribution with the share that
    loses.
- Walk-forward optimisation panel: setup form prefilled from InputSpec keys, ETA before start,
  progress, then the fold table, stitched OOS equity curve, parameter drift and the sensitivity
  heatmap.
- Holdout: the only way to test on sealed data is a deliberate "Test on holdout" action whose
  confirmation says the view will be counted.

DONE WHEN (slice D):

- in the browser, the leaky fixture fails with its line and first divergent bar, and the clean
  fixtures pass;
- the full suite and a small walk-forward optimisation run end to end on EURUSD.twelvedata's two
  years (the acceptance gate);
- a Playwright test covers: open a run → validate → verdict → click evidence → chart jumps;
- CI is green.

Update PROJECT.md and commit.

---

## Notes for whoever implements this

The UI must respect the recorded rules, not merely display numbers. The ones that constrain rendering
directly, with the decision that set each:

| rule                                                                              | decision |
| --------------------------------------------------------------------------------- | -------- |
| A genuinely undefined metric is `null` and must never render as `0`               | repo convention, `PROJECT.md` |
| Every `n/a` carries an `inconclusiveReason` — show it, never a bare dash           | A2       |
| A withheld ratio shows why it was withheld (near-zero or non-positive denominator) | A24, A32, A36, A45 |
| Ratios are per calendar day; the label must say so, not "return"                   | A36      |
| The timeframe matrix is a SHAPE, not a menu — no best-cell highlight               | A44      |
| Each matrix cell shows gross beside net, and which of costs or signal sank it       | A45      |
| Monte Carlo's p95 drawdown is the figure to size around, not the observed one       | A47, A48 |
| The reshuffle's final return is invariant — do not draw a distribution of it         | A47      |
| The seal line names the seal id, its view count, and any retired seals              | A38      |
| A truncated run shows the cut date and bars withheld beside its effective range     | A39, A40 |
| Unsealing is a deliberate action whose confirmation states the view will be counted | A37, A38 |

The API surface step 2 provides: `POST /backtests/:id/validate`, `POST /backtests/:id/optimize`,
`GET /backtests/:id/validations`, `GET /validations/:id`, `DELETE /validations/:id/job`, and job
progress over `GET /api/jobs/:jobId/events`.
