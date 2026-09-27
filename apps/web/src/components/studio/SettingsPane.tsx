import { useQuery } from '@tanstack/react-query';
import { ChevronDown, Database, Play, RotateCcw, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { TIMEFRAME_CODES, type Timeframe } from '@edgelab/shared';

import { Panel } from '@/components/ui/panes';
import { listSymbols, type InputSpecDto, type SymbolDto } from '@/lib/api';
import { formatCount, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import { DEFAULT_SETTINGS, useStudio } from '@/stores/studio';

/**
 * The run configuration panel from spec 04.
 *
 * Two rules shape most of it:
 *
 *  - **Only offer what can actually run.** The symbol list shows instruments with stored bars, and
 *    the date range is clamped to that symbol's coverage. Letting someone pick a range with no
 *    data just moves the failure from a disabled control to a red banner two minutes later.
 *  - **Defaults are the script's, overrides are explicit.** Every input row says whether it is
 *    still the declared default, and "Reset to script defaults" clears the lot.
 */

export function SettingsPane({
  onRun,
  onCancel,
  running,
}: {
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly running: boolean;
}): React.JSX.Element {
  const settings = useStudio((s) => s.settings);
  const patchSettings = useStudio((s) => s.patchSettings);
  const compileInputs = useStudio((s) => s.compileInputs);
  const diagnostics = useStudio((s) => s.diagnostics);

  const symbols = useQuery({ queryKey: ['symbols'], queryFn: listSymbols, staleTime: 60_000 });

  // Only symbols with stored bars: the rest cannot be backtested, so offering them is a trap.
  const withData = useMemo(
    () => (symbols.data ?? []).filter((s) => s.coverage.barCount > 0),
    [symbols.data],
  );

  const selected = withData.find((s) => s.symbol === settings.symbol) ?? withData[0];

  // Clamp the range whenever the symbol changes: a window that was valid for EURUSD is often
  // entirely outside a newly-picked symbol's coverage.
  useEffect(() => {
    if (selected === undefined) return;
    const { firstBar, lastBar } = selected.coverage;
    if (firstBar === null || lastBar === null) return;

    const from = Math.max(settings.fromMs, firstBar);
    const to = Math.min(settings.toMs, lastBar + 1);
    if (from !== settings.fromMs || to !== settings.toMs) {
      patchSettings({ fromMs: Math.min(from, to - 1), toMs: to });
    }
  }, [selected, settings.fromMs, settings.toMs, patchSettings]);

  const hasErrors = diagnostics.some((d) => d.severity === 'error');
  const canRun = !running && !hasErrors && selected !== undefined;

  return (
    <Panel
      title="Run settings"
      actions={
        running ? (
          <button
            type="button"
            onClick={onCancel}
            data-testid="cancel-run"
            className="flex items-center gap-1 rounded bg-destructive/15 px-2 py-1 text-xs font-medium text-destructive transition-colors hover:bg-destructive/25"
          >
            <Square className="size-3" /> Cancel
          </button>
        ) : (
          <button
            type="button"
            onClick={onRun}
            disabled={!canRun}
            data-testid="run-backtest"
            title={
              hasErrors
                ? 'Fix the compile errors first'
                : selected === undefined
                  ? 'No symbol has stored data'
                  : 'Run the backtest (Ctrl/Cmd+Enter)'
            }
            className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            <Play className="size-3" /> Run
          </button>
        )
      }
      bodyClassName="p-3 space-y-4"
    >
      <SymbolPicker
        symbols={withData}
        loading={symbols.isLoading}
        error={symbols.error}
        value={settings.symbol}
        onChange={(symbol) => {
          patchSettings({ symbol });
        }}
      />

      <TimeframeChips
        value={settings.timeframe}
        onChange={(timeframe) => {
          patchSettings({ timeframe });
        }}
      />

      <DateRange
        fromMs={settings.fromMs}
        toMs={settings.toMs}
        coverage={selected?.coverage}
        onChange={(fromMs, toMs) => {
          patchSettings({ fromMs, toMs });
        }}
      />

      <AccountFields />

      <CostsAccordion />

      <InputsForm specs={compileInputs} />
    </Panel>
  );
}

/* ------------------------------------------------------------------- symbols */

function SymbolPicker({
  symbols,
  loading,
  error,
  value,
  onChange,
}: {
  readonly symbols: readonly SymbolDto[];
  readonly loading: boolean;
  readonly error: unknown;
  readonly value: string;
  readonly onChange: (symbol: string) => void;
}): React.JSX.Element {
  return (
    <Field label="Symbol">
      {loading ? (
        <p className="text-xs text-muted">Loading symbols…</p>
      ) : error !== null ? (
        <p className="text-xs text-destructive">
          {error instanceof Error ? error.message : 'Could not load symbols.'}
        </p>
      ) : symbols.length === 0 ? (
        <p className="flex items-start gap-1.5 text-xs text-amber-500">
          <Database className="mt-0.5 size-3.5 shrink-0" />
          No symbol has stored bars yet. Download some on the Data page, or run
          <code className="mx-1 font-mono">pnpm ingest EURUSD dukascopy 2024-01-01 2024-02-01</code>
          .
        </p>
      ) : (
        <div className="space-y-1" data-testid="symbol-list">
          {symbols.map((symbol) => {
            const active = symbol.symbol === value;
            return (
              <button
                key={symbol.id}
                type="button"
                onClick={() => {
                  onChange(symbol.symbol);
                }}
                data-testid={`symbol-${symbol.symbol}`}
                aria-pressed={active}
                className={cn(
                  'flex w-full items-baseline justify-between gap-2 rounded border px-2 py-1.5 text-left transition-colors',
                  active
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-transparent hover:bg-surface-hover',
                )}
              >
                <span className="font-mono text-xs font-medium">{symbol.symbol}</span>
                {/* Coverage is the reason this list exists, so it is shown inline rather than
                    hidden behind a tooltip. */}
                <span className="text-[10px] tabular-nums text-muted">
                  {formatDate(symbol.coverage.firstBar)} → {formatDate(symbol.coverage.lastBar)} ·{' '}
                  {formatCount(symbol.coverage.barCount)} bars
                </span>
              </button>
            );
          })}
        </div>
      )}
    </Field>
  );
}

/* --------------------------------------------------------------- timeframes */

function TimeframeChips({
  value,
  onChange,
}: {
  readonly value: Timeframe;
  readonly onChange: (tf: Timeframe) => void;
}): React.JSX.Element {
  return (
    <Field label="Timeframe">
      <div className="flex flex-wrap gap-1" data-testid="timeframe-chips">
        {TIMEFRAME_CODES.map((tf) => (
          <button
            key={tf}
            type="button"
            onClick={() => {
              onChange(tf);
            }}
            aria-pressed={tf === value}
            data-testid={`tf-${tf}`}
            className={cn(
              'min-w-9 rounded border px-1.5 py-1 font-mono text-[11px] tabular-nums transition-colors',
              tf === value
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border text-muted hover:bg-surface-hover hover:text-foreground',
            )}
          >
            {tf}
          </button>
        ))}
      </div>
    </Field>
  );
}

/* --------------------------------------------------------------- date range */

const PRESETS = [
  { label: '1M', months: 1 },
  { label: '3M', months: 3 },
  { label: '6M', months: 6 },
  { label: '1Y', months: 12 },
  { label: '3Y', months: 36 },
] as const;

function DateRange({
  fromMs,
  toMs,
  coverage,
  onChange,
}: {
  readonly fromMs: number;
  readonly toMs: number;
  readonly coverage: SymbolDto['coverage'] | undefined;
  readonly onChange: (fromMs: number, toMs: number) => void;
}): React.JSX.Element {
  const min = coverage?.firstBar ?? null;
  const max = coverage?.lastBar ?? null;

  /** Apply a preset ending at the latest stored bar, clamped to the earliest. */
  const applyPreset = (months: number): void => {
    if (max === null) return;
    const end = new Date(max);
    const start = Date.UTC(end.getUTCFullYear(), end.getUTCMonth() - months, end.getUTCDate());
    onChange(min === null ? start : Math.max(start, min), max + 1);
  };

  return (
    <Field
      label="Date range"
      hint={
        min === null || max === null ? undefined : `data ${formatDate(min)} → ${formatDate(max)}`
      }
    >
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={formatDate(fromMs)}
          min={min === null ? undefined : formatDate(min)}
          max={formatDate(toMs - 1)}
          onChange={(event) => {
            const parsed = Date.parse(`${event.target.value}T00:00:00Z`);
            if (!Number.isNaN(parsed)) onChange(parsed, toMs);
          }}
          data-testid="date-from"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs tabular-nums"
        />
        <span className="text-xs text-muted">→</span>
        <input
          type="date"
          value={formatDate(toMs)}
          min={formatDate(fromMs + 1)}
          max={max === null ? undefined : formatDate(max + 86_400_000)}
          onChange={(event) => {
            const parsed = Date.parse(`${event.target.value}T00:00:00Z`);
            if (!Number.isNaN(parsed)) onChange(fromMs, parsed);
          }}
          data-testid="date-to"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 font-mono text-xs tabular-nums"
        />
      </div>

      <div className="mt-1.5 flex flex-wrap gap-1">
        {PRESETS.map((preset) => (
          <button
            key={preset.label}
            type="button"
            disabled={max === null}
            onClick={() => {
              applyPreset(preset.months);
            }}
            className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          disabled={min === null || max === null}
          onClick={() => {
            if (min !== null && max !== null) onChange(min, max + 1);
          }}
          data-testid="preset-max"
          className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted transition-colors hover:bg-surface-hover hover:text-foreground disabled:opacity-40"
        >
          Max
        </button>
      </div>
    </Field>
  );
}

/* ------------------------------------------------------------------ account */

function AccountFields(): React.JSX.Element {
  const settings = useStudio((s) => s.settings);
  const patchSettings = useStudio((s) => s.patchSettings);

  return (
    <Field label="Account">
      <div className="grid grid-cols-2 gap-2">
        <NumberInput
          label="Capital"
          value={settings.initialCapital}
          min={1}
          step={1_000}
          onChange={(initialCapital) => {
            patchSettings({ initialCapital });
          }}
          testId="capital"
        />
        <TextInput
          label="Currency"
          value={settings.accountCurrency}
          onChange={(accountCurrency) => {
            patchSettings({ accountCurrency: accountCurrency.toUpperCase().slice(0, 3) });
          }}
        />
        <NumberInput
          label="Leverage 1:"
          value={settings.leverage}
          min={1}
          step={10}
          onChange={(leverage) => {
            patchSettings({ leverage });
          }}
          testId="leverage"
          hint="margin % = 100 / leverage"
        />
        <NumberInput
          label="Size (lots)"
          value={settings.lots}
          min={0}
          step={0.1}
          onChange={(lots) => {
            patchSettings({ lots });
          }}
          testId="lots"
          hint="0 = use the script's own sizing"
        />
        <NumberInput
          label="Warmup bars"
          value={settings.warmupBars}
          min={0}
          step={100}
          onChange={(warmupBars) => {
            patchSettings({ warmupBars });
          }}
        />
        <NumberInput
          label="Risk-free %/yr"
          value={settings.rfAnnual * 100}
          min={-100}
          step={0.5}
          onChange={(pct) => {
            patchSettings({ rfAnnual: pct / 100 });
          }}
        />
      </div>

      {/* Pine sizes in contracts, which is the single most surprising thing about configuring a
          run here, so it is stated rather than left to be discovered. */}
      {settings.lots > 0 && (
        <p className="mt-1.5 text-[11px] leading-snug text-muted">
          Overrides the script&apos;s <code className="font-mono">default_qty_value</code> — Pine
          sizes in contracts, so 1 lot is set explicitly from the symbol&apos;s contract size.
        </p>
      )}
    </Field>
  );
}

/* -------------------------------------------------------------------- costs */

function CostsAccordion(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const costs = useStudio((s) => s.settings.costs);
  const patchCosts = useStudio((s) => s.patchCosts);

  return (
    <div className="rounded border border-border">
      <button
        type="button"
        onClick={() => {
          setOpen((o) => !o);
        }}
        data-testid="costs-accordion"
        className="flex w-full items-center gap-2 px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted hover:text-foreground"
      >
        <ChevronDown className={cn('size-3 transition-transform', !open && '-rotate-90')} />
        Slippage &amp; costs
        <span className="ml-auto font-normal normal-case tracking-normal">
          spread {costs.spread.source}
          {costs.financing.mode === 'none' ? '' : ` · ${costs.financing.mode}`}
        </span>
      </button>

      {open && (
        <div className="space-y-2 border-t border-border p-2">
          <SelectInput
            label="Spread source"
            value={costs.spread.source}
            options={[
              { value: 'data', label: 'From the bars (fallback: fixed)' },
              { value: 'fixed', label: 'Fixed points' },
              { value: 'none', label: 'None' },
            ]}
            onChange={(source) => {
              patchCosts({
                spread: { ...costs.spread, source: source as typeof costs.spread.source },
              });
            }}
          />

          <div className="grid grid-cols-2 gap-2">
            <NumberInput
              label="Fixed spread (pts)"
              value={costs.spread.fixedPoints}
              min={0}
              step={1}
              onChange={(fixedPoints) => {
                patchCosts({ spread: { ...costs.spread, fixedPoints } });
              }}
            />
            <NumberInput
              label="Spread ×"
              value={costs.spread.multiplier}
              min={0}
              step={0.5}
              onChange={(multiplier) => {
                patchCosts({ spread: { ...costs.spread, multiplier } });
              }}
              hint="stress test"
            />
            <NumberInput
              label="Slippage (pts)"
              value={costs.slippagePoints}
              min={0}
              step={1}
              onChange={(slippagePoints) => {
                patchCosts({ slippagePoints });
              }}
            />
          </div>

          <SelectInput
            label="Financing"
            value={costs.financing.mode}
            options={[
              { value: 'none', label: 'None' },
              { value: 'mt5Points', label: 'MT5 swap (points/lot/night)' },
              { value: 'annualPct', label: 'Annual % of notional' },
              { value: 'funding', label: 'Funding rate (crypto perps)' },
            ]}
            onChange={(mode) => {
              patchCosts({
                financing: { ...costs.financing, mode: mode as typeof costs.financing.mode },
              });
            }}
          />

          {costs.financing.mode === 'mt5Points' && (
            <div className="grid grid-cols-2 gap-2">
              <NumberInput
                label="Swap long (pts)"
                value={costs.financing.swapLongPoints}
                step={0.5}
                onChange={(swapLongPoints) => {
                  patchCosts({ financing: { ...costs.financing, swapLongPoints } });
                }}
                hint="negative = charge"
              />
              <NumberInput
                label="Swap short (pts)"
                value={costs.financing.swapShortPoints}
                step={0.5}
                onChange={(swapShortPoints) => {
                  patchCosts({ financing: { ...costs.financing, swapShortPoints } });
                }}
              />
            </div>
          )}

          {costs.financing.mode === 'annualPct' && (
            <div className="grid grid-cols-2 gap-2">
              <NumberInput
                label="Long %/yr"
                value={costs.financing.annualPctLong}
                step={0.25}
                onChange={(annualPctLong) => {
                  patchCosts({ financing: { ...costs.financing, annualPctLong } });
                }}
              />
              <NumberInput
                label="Short %/yr"
                value={costs.financing.annualPctShort}
                step={0.25}
                onChange={(annualPctShort) => {
                  patchCosts({ financing: { ...costs.financing, annualPctShort } });
                }}
              />
            </div>
          )}

          {costs.financing.mode === 'funding' && (
            <div className="grid grid-cols-2 gap-2">
              <NumberInput
                label="Rate %/interval"
                value={costs.financing.fundingRatePct}
                step={0.001}
                onChange={(fundingRatePct) => {
                  patchCosts({ financing: { ...costs.financing, fundingRatePct } });
                }}
              />
              <NumberInput
                label="Interval (h)"
                value={costs.financing.fundingIntervalHours}
                min={1}
                step={1}
                onChange={(fundingIntervalHours) => {
                  patchCosts({ financing: { ...costs.financing, fundingIntervalHours } });
                }}
              />
            </div>
          )}

          {costs.financing.mode !== 'none' && (
            <>
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={costs.financing.swapFree}
                  onChange={(event) => {
                    patchCosts({
                      financing: { ...costs.financing, swapFree: event.target.checked },
                    });
                  }}
                  className="size-3.5 accent-[var(--primary)]"
                />
                Swap-free account
              </label>
              <p className="text-[11px] leading-snug text-muted">
                Rollover at{' '}
                {String(Math.floor(costs.financing.rolloverMinuteOfDay / 60)).padStart(2, '0')}:
                {String(costs.financing.rolloverMinuteOfDay % 60).padStart(2, '0')}{' '}
                {costs.financing.rolloverTimeZone} (D5), triple-charged on{' '}
                {WEEKDAYS[costs.financing.tripleChargeWeekday ?? -1] ?? 'no day'}.
              </p>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const WEEKDAYS: Record<number, string> = {
  0: 'Sunday',
  1: 'Monday',
  2: 'Tuesday',
  3: 'Wednesday',
  4: 'Thursday',
  5: 'Friday',
  6: 'Saturday',
};

/* ------------------------------------------------------------------- inputs */

/**
 * The Inputs form, generated from the script's own `InputSpec` list — min/max/step/options/groups,
 * like TradingView's settings dialog.
 *
 * Keyed on `InputSpec.key`, which is the Pine varId: titles duplicate and can be empty, so keying
 * on them would alias two inputs onto one control.
 */
function InputsForm({
  specs,
}: {
  readonly specs: readonly InputSpecDto[];
}): React.JSX.Element | null {
  const inputs = useStudio((s) => s.inputs);
  const setInput = useStudio((s) => s.setInput);
  const resetInputs = useStudio((s) => s.resetInputs);
  const patchSettings = useStudio((s) => s.patchSettings);

  if (specs.length === 0) return null;

  // Preserve declaration order within a group, and keep ungrouped inputs first — that is the
  // order the script author chose, and re-sorting alphabetically would scramble their intent.
  const groups = new Map<string, InputSpecDto[]>();
  for (const spec of specs) {
    const key = spec.group ?? '';
    const list = groups.get(key) ?? [];
    list.push(spec);
    groups.set(key, list);
  }

  const overrideCount = Object.keys(inputs).length;

  return (
    <Field
      label={`Inputs${overrideCount > 0 ? ` (${String(overrideCount)} overridden)` : ''}`}
      action={
        <button
          type="button"
          onClick={() => {
            resetInputs();
            patchSettings({
              initialCapital: DEFAULT_SETTINGS.initialCapital,
              leverage: DEFAULT_SETTINGS.leverage,
              lots: DEFAULT_SETTINGS.lots,
              warmupBars: DEFAULT_SETTINGS.warmupBars,
              rfAnnual: DEFAULT_SETTINGS.rfAnnual,
              costs: DEFAULT_SETTINGS.costs,
            });
          }}
          data-testid="reset-defaults"
          className="flex items-center gap-1 text-[11px] text-muted transition-colors hover:text-foreground"
        >
          <RotateCcw className="size-3" /> Reset to script defaults
        </button>
      }
    >
      <div className="space-y-3" data-testid="inputs-form">
        {[...groups.entries()].map(([group, groupSpecs]) => (
          <div key={group}>
            {group !== '' && (
              <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted">
                {group}
              </p>
            )}
            <div className="space-y-1.5">
              {groupSpecs.map((spec) => (
                <InputRow
                  key={spec.key}
                  spec={spec}
                  value={inputs[spec.key] ?? spec.default}
                  overridden={spec.key in inputs}
                  onChange={(value) => {
                    setInput(spec.key, value);
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Field>
  );
}

function InputRow({
  spec,
  value,
  overridden,
  onChange,
}: {
  readonly spec: InputSpecDto;
  readonly value: unknown;
  readonly overridden: boolean;
  readonly onChange: (value: unknown) => void;
}): React.JSX.Element {
  const label = (
    <span
      className={cn('flex-1 truncate text-xs', overridden && 'font-medium text-primary')}
      title={spec.tooltip ?? spec.title}
    >
      {spec.title}
      {overridden && <span className="ml-1 text-[10px] text-muted">(overridden)</span>}
    </span>
  );

  if (spec.type === 'bool') {
    return (
      <label className="flex items-center gap-2" data-testid={`input-${spec.key}`}>
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => {
            onChange(event.target.checked);
          }}
          className="size-3.5 accent-[var(--primary)]"
        />
        {label}
      </label>
    );
  }

  if (spec.options != null && spec.options.length > 0) {
    return (
      <div className="flex items-center gap-2" data-testid={`input-${spec.key}`}>
        {label}
        <select
          value={String(value)}
          onChange={(event) => {
            // Match the declared option's own type: a numeric option sent back as a string
            // would be rejected by the engine's eager input validation.
            const raw = event.target.value;
            const match = spec.options?.find((o) => String(o) === raw);
            onChange(match ?? raw);
          }}
          className="w-32 rounded border border-border bg-background px-1.5 py-1 text-xs"
        >
          {spec.options.map((option) => (
            <option key={String(option)} value={String(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </div>
    );
  }

  if (spec.type === 'int' || spec.type === 'float') {
    return (
      <div className="flex items-center gap-2" data-testid={`input-${spec.key}`}>
        {label}
        <input
          type="number"
          value={typeof value === 'number' ? value : Number(value ?? 0)}
          min={spec.min ?? undefined}
          max={spec.max ?? undefined}
          step={spec.step ?? (spec.type === 'int' ? 1 : 0.1)}
          onChange={(event) => {
            const parsed = Number(event.target.value);
            if (!Number.isNaN(parsed)) onChange(spec.type === 'int' ? Math.round(parsed) : parsed);
          }}
          className="w-24 rounded border border-border bg-background px-1.5 py-1 text-right font-mono text-xs tabular-nums"
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2" data-testid={`input-${spec.key}`}>
      {label}
      <input
        type="text"
        value={String(value ?? '')}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="w-32 rounded border border-border bg-background px-1.5 py-1 font-mono text-xs"
      />
    </div>
  );
}

/* ------------------------------------------------------------------ controls */

function Field({
  label,
  hint,
  action,
  children,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly action?: React.ReactNode;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          {label}
        </span>
        {hint !== undefined && <span className="text-[10px] tabular-nums text-muted">{hint}</span>}
        {action}
      </div>
      {children}
    </div>
  );
}

function NumberInput({
  label,
  value,
  min,
  max,
  step,
  hint,
  testId,
  onChange,
}: {
  readonly label: string;
  readonly value: number;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly hint?: string;
  readonly testId?: string;
  readonly onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-muted" title={hint}>
        {label}
      </span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        {...(testId === undefined ? {} : { 'data-testid': testId })}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (!Number.isNaN(parsed)) onChange(parsed);
        }}
        className="w-full rounded border border-border bg-background px-1.5 py-1 text-right font-mono text-xs tabular-nums"
      />
    </label>
  );
}

function TextInput({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-muted">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="w-full rounded border border-border bg-background px-1.5 py-1 font-mono text-xs uppercase"
      />
    </label>
  );
}

function SelectInput({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { value: string; label: string }[];
  readonly onChange: (value: string) => void;
}): React.JSX.Element {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[11px] text-muted">{label}</span>
      <select
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="w-full rounded border border-border bg-background px-1.5 py-1 text-xs"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
