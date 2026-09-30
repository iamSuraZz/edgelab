/**
 * What a visual renders instead of a number it does not have.
 *
 * Never a dash, never `0`, never an empty chart. A withheld figure carries a reason — the
 * denominator was not positive, the lookback was not satisfied, the sizing mode was unknown — and
 * those reasons are the substance of decisions A2, A24, A32, A36, A45 and A47. Hiding them behind a
 * blank makes a report that cannot be distinguished from one where everything passed.
 */
export function Withheld({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <p
      className="rounded border border-dashed border-border bg-muted/5 p-2 text-xs leading-relaxed text-muted"
      data-testid="withheld"
    >
      {children}
    </p>
  );
}

/**
 * A number that may be genuinely undefined.
 *
 * `null` renders as an em dash with a tooltip, NEVER as zero — a withheld ratio is not a ratio of
 * zero, and that distinction is the whole point of the denominator guards.
 */
export function Figure({
  value,
  format,
  reason,
}: {
  value: number | null | undefined;
  format?: (v: number) => string;
  /** Why it is undefined. Shown on hover; omitted only when there is genuinely nothing to say. */
  reason?: string;
}): React.JSX.Element {
  if (value === null || value === undefined) {
    return (
      <span className="cursor-help text-muted" title={reason ?? 'Not defined for this run.'}>
        —
      </span>
    );
  }
  return (
    <span className="tabular-nums">{format === undefined ? String(value) : format(value)}</span>
  );
}
