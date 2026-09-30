import type { ValidationDetail } from '@/lib/api';
import { CostStressCurve } from './CostStressCurve';
import { FlipsTable } from './FlipsTable';
import { MonteCarloPanel } from './MonteCarloPanel';
import { OosSplitPanel, RollingFoldsPanel } from './OosPanels';
import { RegimeTable } from './RegimeTable';
import { TimeframeMatrix } from './TimeframeMatrix';

/**
 * The visual belonging to a check, or nothing.
 *
 * Reads the report's side-channel sections (`stress`, `replay`, `oos`, ...) rather than the check's
 * `evidence`, because evidence is a flat map of scalars for the generic card while these need the
 * full structures. One switch keeps the mapping in a single place, so a check without a visual
 * simply renders its card.
 */
export function CheckVisual({
  checkId,
  detail,
  currency,
  pipSize,
  onJumpToTime,
  onJumpToTrade,
}: {
  checkId: string;
  detail: ValidationDetail;
  currency: string;
  pipSize: number;
  onJumpToTime?: (atMs: number) => void;
  onJumpToTrade?: (seq: number) => void;
}): React.JSX.Element | null {
  const report = detail.report as Record<string, unknown> | null;
  if (report === null) return null;

  switch (checkId) {
    case 'execution-cost-stress': {
      const s = report['stress'] as
        { points?: []; breakEvenMultiplier?: number | null } | null | undefined;
      if (s?.points === undefined) return null;
      return (
        <CostStressCurve
          points={s.points}
          breakEvenMultiplier={s.breakEvenMultiplier ?? null}
          currency={currency}
        />
      );
    }

    case 'execution-intrabar-replay': {
      const r = report['replay'] as { rows?: [] } | null | undefined;
      if (r?.rows === undefined) return null;
      return (
        <FlipsTable
          rows={r.rows}
          pipSize={pipSize}
          currency={currency}
          {...(onJumpToTime === undefined ? {} : { onJumpToTime })}
          {...(onJumpToTrade === undefined ? {} : { onJumpToTrade })}
        />
      );
    }

    case 'overfitting-oos-split': {
      const o = report['oos'] as Parameters<typeof OosSplitPanel>[0]['split'] | null | undefined;
      return o == null ? null : <OosSplitPanel split={o} currency={currency} />;
    }

    case 'overfitting-rolling-oos': {
      const r = report['rollingOos'] as
        { folds?: []; medianRetention?: number | null } | null | undefined;
      if (r?.folds === undefined) return null;
      return <RollingFoldsPanel folds={r.folds} medianRetention={r.medianRetention ?? null} />;
    }

    case 'overfitting-regimes': {
      const g = report['regimes'] as
        Omit<Parameters<typeof RegimeTable>[0], 'currency'> | null | undefined;
      return g == null ? null : <RegimeTable {...g} currency={currency} />;
    }

    case 'overfitting-timeframe-matrix': {
      const m = report['matrix'] as { cells?: []; baseTimeframe?: string } | null | undefined;
      if (m?.cells === undefined) return null;
      return (
        <TimeframeMatrix
          cells={m.cells}
          baseTimeframe={m.baseTimeframe ?? ''}
          currency={currency}
        />
      );
    }

    case 'overfitting-monte-carlo': {
      const mc = report['monteCarlo'] as
        Parameters<typeof MonteCarloPanel>[0]['mc'] | null | undefined;
      return mc == null ? null : <MonteCarloPanel mc={mc} />;
    }

    default:
      return null;
  }
}
