import { Info } from 'lucide-react';
import { getMetric, hasMetric } from '@edgelab/shared';

import { EM_DASH, formatByUnit, pnlClass } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * A metric table row, labelled and formatted from the shared metric dictionary.
 *
 * The dictionary is the single source for a metric's label, unit, formula and direction, so the
 * report cannot describe a number differently from the API or the docs. `dictKey` is the
 * dictionary entry; where a report field has no entry (yet), `label` and `unit` can be given
 * directly rather than inventing a dictionary key that nothing else knows about.
 */
export interface MetricRowSpec {
  readonly dictKey?: string;
  readonly label?: string;
  readonly unit?: string;
  readonly value: number | null | undefined;
  /** Force the profit/loss colour on. Defaults to the dictionary's `higherIsBetter`. */
  readonly colour?: boolean;
  /** Extra prose under the value, for a caveat that only applies to this run. */
  readonly note?: string;
}

export function MetricTable({
  title,
  rows,
  currency,
  columns = 1,
}: {
  readonly title?: string;
  readonly rows: readonly MetricRowSpec[];
  readonly currency: string;
  readonly columns?: number;
}): React.JSX.Element {
  return (
    <div>
      {title !== undefined && (
        <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
          {title}
        </h3>
      )}
      <dl
        className={cn(
          'divide-y divide-border rounded border border-border',
          columns > 1 && 'sm:grid sm:divide-y-0',
        )}
        style={
          columns > 1
            ? { gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))` }
            : undefined
        }
      >
        {rows.map((row, index) => (
          <MetricRow
            key={row.dictKey ?? row.label ?? String(index)}
            row={row}
            currency={currency}
          />
        ))}
      </dl>
    </div>
  );
}

function MetricRow({
  row,
  currency,
}: {
  readonly row: MetricRowSpec;
  readonly currency: string;
}): React.JSX.Element {
  const def = row.dictKey !== undefined && hasMetric(row.dictKey) ? getMetric(row.dictKey) : null;
  const label = row.label ?? def?.label ?? row.dictKey ?? '';
  const unit = row.unit ?? def?.unit ?? 'ratio';

  // Colour only where direction is meaningful. A trade count or an average bars-held is neutral,
  // and tinting it red because it happens to be small would be noise pretending to be signal.
  const coloured = row.colour ?? def?.higherIsBetter === true;
  const formatted = formatByUnit(row.value, unit, currency);

  return (
    <div className="flex items-baseline justify-between gap-3 px-2.5 py-1.5">
      <dt className="flex min-w-0 items-center gap-1 text-xs text-muted">
        <span className="truncate">{label}</span>
        {def !== null && (
          // `title` rather than a custom popover: it is keyboard- and screen-reader-accessible
          // for free, and a formula is exactly the kind of thing a native tooltip handles well.
          <span
            title={`${def.formula}${def.higherIsBetter === null ? '' : def.higherIsBetter ? '\n\nHigher is better.' : '\n\nLower is better.'}`}
            className="shrink-0 cursor-help text-muted/60 hover:text-muted"
            aria-label={`Formula: ${def.formula}`}
          >
            <Info className="size-3" />
          </span>
        )}
      </dt>
      <dd className="shrink-0 text-right">
        <span
          className={cn(
            'font-mono text-xs tabular-nums',
            coloured ? pnlClass(row.value) : 'text-foreground',
            formatted === EM_DASH && 'text-muted',
          )}
        >
          {formatted}
        </span>
        {row.note !== undefined && (
          <span className="mt-0.5 block text-[10px] text-muted">{row.note}</span>
        )}
      </dd>
    </div>
  );
}
