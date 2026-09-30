import { splitByQuestion, type CheckResult } from '@edgelab/validation';

import { cn } from '@/lib/utils';
import type { ValidationContextView } from '@/lib/api';

/**
 * TWO questions, never one badge (A52).
 *
 * "Is this backtest honest?" has a verdict. "Does the edge hold up?" gets counts and no combined
 * score — there is no honest way to average "profitable in 2 of 4 timeframes" against "15% of
 * bootstrap resamples lose money", and any weighting invented to do it would be a judgement
 * smuggled in as arithmetic.
 *
 * The split lives in `@edgelab/validation` so the CLI and this header cannot disagree about which
 * check answers which question.
 */

const VERDICT_STYLE: Record<string, string> = {
  pass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  warn: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  fail: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  inconclusive: 'bg-slate-500/15 text-slate-300 border-slate-500/30',
};

const VERDICT_WORD: Record<string, string> = {
  pass: 'Yes',
  warn: 'Mostly',
  fail: 'No',
  inconclusive: 'Unknown',
};

export interface VerdictHeaderProps {
  readonly results: readonly CheckResult[];
  readonly context: ValidationContextView;
  readonly seal: {
    readonly line: string;
    readonly retiredCount: number;
  } | null;
}

export function VerdictHeader({ results, context, seal }: VerdictHeaderProps): React.JSX.Element {
  const split = splitByQuestion(results);
  const truncated = context.requestedRangeToMs !== null;

  return (
    <section className="space-y-3 border-b border-border p-3" data-testid="verdict-header">
      <div className="grid gap-3 md:grid-cols-2">
        <div
          className={cn('rounded-md border p-3', VERDICT_STYLE[split.honesty.verdict])}
          data-testid="verdict-honesty"
        >
          <h3 className="text-xs font-medium uppercase tracking-wide opacity-80">
            Is this backtest honest?
          </h3>
          <p className="mt-1 text-2xl font-semibold" data-testid="verdict-honesty-word">
            {VERDICT_WORD[split.honesty.verdict]}
          </p>
          <p className="mt-1 text-xs leading-relaxed opacity-90">{split.honesty.headline}</p>
        </div>

        {/*
          Deliberately NOT a badge. A single word here would be read as a verdict on the strategy,
          which is the confusion A52 exists to prevent.
        */}
        <div className="rounded-md border border-border p-3" data-testid="verdict-robustness">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted">
            Does the edge hold up?
          </h3>
          <div className="mt-1 flex flex-wrap gap-2 text-sm">
            <Count label="pass" value={split.robustness.counts.pass} tone="emerald" />
            <Count label="warn" value={split.robustness.counts.warn} tone="amber" />
            <Count label="fail" value={split.robustness.counts.fail} tone="rose" />
            <Count label="n/a" value={split.robustness.counts.na} tone="slate" />
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">{split.robustness.headline}</p>
        </div>
      </div>

      {seal !== null && (
        <p className="text-xs text-muted" data-testid="seal-line">
          {seal.line}
        </p>
      )}

      {truncated && (
        <p
          className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-200"
          data-testid="truncation-notice"
        >
          A sealed holdout cut this run short. It is recorded against the range it actually covered
          — {formatDay(context.rangeFromMs)} to {formatDay(context.rangeToMs)} — while{' '}
          {formatDay(context.requestedRangeToMs)} was requested. Every figure below describes the
          shorter window.
        </p>
      )}

      {split.unclassified.length > 0 && (
        <p className="text-xs text-muted">
          {split.unclassified.length} check(s) are not yet sorted into either question:{' '}
          {split.unclassified.map((c: CheckResult) => c.label).join(', ')}.
        </p>
      )}
    </section>
  );
}

const TONE: Record<string, string> = {
  emerald: 'text-emerald-300',
  amber: 'text-amber-300',
  rose: 'text-rose-300',
  slate: 'text-slate-400',
};

function Count({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: string;
}): React.JSX.Element {
  return (
    <span className={cn('tabular-nums', value === 0 ? 'text-muted/50' : TONE[tone])}>
      <span className="font-semibold">{value}</span> {label}
    </span>
  );
}

function formatDay(ms: number | null): string {
  return ms === null ? '—' : new Date(ms).toISOString().slice(0, 10);
}
