import { ChevronRight, HelpCircle } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';
import type { CheckResultView } from '@/lib/api';
import { WHY_IT_MATTERS } from './why-it-matters';

/**
 * One check.
 *
 * Two rules from the recorded decisions are enforced HERE rather than left to each caller:
 *
 *  - an `n/a` always shows its `inconclusiveReason` (A2). A bare dash invites the reader to assume
 *    the check passed, which is the opposite of what `n/a` means;
 *  - a null figure renders as an em dash with its reason, never as `0`. A withheld ratio is not a
 *    ratio of zero — that distinction is the whole point of A24, A32, A36 and A45.
 */

const BADGE: Record<string, string> = {
  pass: 'bg-emerald-500/15 text-emerald-300',
  warn: 'bg-amber-500/15 text-amber-300',
  fail: 'bg-rose-500/15 text-rose-300',
  'n/a': 'bg-slate-500/15 text-slate-400',
};

export interface CheckCardProps {
  readonly check: CheckResultView;
  /** Jump to an instant on the Chart tab. Evidence keys ending `AtMs` become buttons when set. */
  readonly onJumpToTime?: (atMs: number) => void;
  /** Jump to a trade. Evidence keys naming a trade sequence become buttons when set. */
  readonly onJumpToTrade?: (seq: number) => void;
  /** The check's visual, when it has one. Rendered above the raw evidence. */
  readonly visual?: React.ReactNode;
}

/**
 * Evidence keys that name a chart location.
 *
 * TIMES, by the `*AtMs` convention (A53). A bar INDEX is not a location the chart can use — it
 * indexes the engine's array, warmup included — and the bar that matters usually carries no trade
 * at all, so resolving it through a trade left the most important look-ahead evidence unclickable.
 */
const isTimeKey = (key: string): boolean => key.endsWith('AtMs');
const TRADE_KEYS = new Set(['tradeSeq', 'trade', 'worstTrade', 'firstFlipTrade']);

export function CheckCard({
  check,
  onJumpToTime,
  onJumpToTrade,
  visual,
}: CheckCardProps): React.JSX.Element {
  const [open, setOpen] = useState(check.status === 'fail');
  const why = WHY_IT_MATTERS[check.id];
  const evidence = Object.entries(check.evidence ?? {});
  const expandable = evidence.length > 0 || visual !== undefined;

  return (
    <article
      className="rounded-md border border-border"
      data-testid={`check-${check.id}`}
      data-status={check.status}
    >
      <header className="flex items-start gap-2 p-2.5">
        <span
          className={cn(
            'mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[0.65rem] font-semibold uppercase',
            BADGE[check.status],
          )}
          data-testid={`check-${check.id}-status`}
        >
          {check.status}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h4 className="text-sm font-medium">{check.label}</h4>
            {why !== undefined && (
              <span className="group relative inline-flex">
                <HelpCircle
                  className="h-3.5 w-3.5 cursor-help text-muted"
                  aria-label={`Why ${check.label} matters`}
                />
                <span
                  role="tooltip"
                  className="pointer-events-none absolute left-5 top-0 z-10 hidden w-72 rounded border border-border bg-popover p-2 text-xs leading-relaxed text-foreground shadow-lg group-hover:block group-focus-within:block"
                >
                  {why}
                </span>
              </span>
            )}
          </div>

          <p className="mt-1 text-xs leading-relaxed text-muted">{check.detail}</p>

          {/*
            An n/a without its reason is worse than no card: the reader fills the gap with
            "probably fine". The runner always supplies one (A2).
          */}
          {check.status === 'n/a' && (
            <p
              className="mt-1.5 rounded bg-slate-500/10 p-1.5 text-xs text-slate-300"
              data-testid={`check-${check.id}-reason`}
            >
              Not applicable:{' '}
              {check.inconclusiveReason ?? 'no reason was recorded, which is a bug.'}
            </p>
          )}
        </div>

        {expandable && (
          <button
            type="button"
            onClick={() => {
              setOpen((v) => !v);
            }}
            className="shrink-0 rounded p-1 text-muted hover:text-foreground"
            aria-expanded={open}
            aria-label={open ? 'Hide evidence' : 'Show evidence'}
            data-testid={`check-${check.id}-toggle`}
          >
            <ChevronRight className={cn('h-4 w-4 transition-transform', open && 'rotate-90')} />
          </button>
        )}
      </header>

      {open && visual !== undefined && (
        <div className="border-t border-border p-2.5" data-testid={`check-${check.id}-visual`}>
          {visual}
        </div>
      )}

      {open && evidence.length > 0 && (
        <dl
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 border-t border-border p-2.5 text-xs"
          data-testid={`check-${check.id}-evidence`}
        >
          {evidence.map(([key, value]) => (
            <EvidenceRow
              key={key}
              name={key}
              value={value}
              {...(onJumpToTime !== undefined ? { onJumpToTime } : {})}
              {...(onJumpToTrade !== undefined ? { onJumpToTrade } : {})}
            />
          ))}
        </dl>
      )}
    </article>
  );
}

function EvidenceRow({
  name,
  value,
  onJumpToTime,
  onJumpToTrade,
}: {
  name: string;
  value: number | string;
  onJumpToTime?: (atMs: number) => void;
  onJumpToTrade?: (seq: number) => void;
}): React.JSX.Element {
  const isTime = isTimeKey(name) && typeof value === 'number' && onJumpToTime !== undefined;
  const isTrade = TRADE_KEYS.has(name) && typeof value === 'number' && onJumpToTrade !== undefined;

  // An epoch-ms figure means nothing on screen; the label reads as a date and clicks as a jump.
  const shown = isTime
    ? new Date(value as number).toISOString().replace('T', ' ').slice(0, 16)
    : String(value);

  return (
    <>
      <dt className="truncate text-muted">{humanise(name)}</dt>
      <dd className="text-right tabular-nums">
        {isTime || isTrade ? (
          <button
            type="button"
            className="text-primary underline underline-offset-2 hover:text-primary/80"
            data-testid={isTime ? 'jump-time' : `jump-trade-${String(value)}`}
            onClick={() => {
              if (isTime) onJumpToTime(value as number);
              else onJumpToTrade?.(value as number);
            }}
          >
            {shown}
          </button>
        ) : (
          shown
        )}
      </dd>
    </>
  );
}

/** `outOfSampleTrades` -> `Out of sample trades`; `divergedAtMs` -> `Diverged at`. */
function humanise(key: string): string {
  const withoutSuffix = key.endsWith('AtMs') ? key.slice(0, -2) : key;
  const spaced = withoutSuffix.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
