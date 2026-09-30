import { AlertTriangle, Check, KeyRound, X } from 'lucide-react';

import type { ProviderCard } from '@/lib/api';

/**
 * What each source can do, and whether it can do it right now.
 *
 * Three things are shown that a plain "connected / not connected" badge would hide, each because
 * getting them wrong has cost this project real time:
 *
 *  - **Credits left**, from the same Redis counters the fetcher spends. Twelve Data's free tier is
 *    800 requests a day; finding out you are out of them halfway through a backfill is how an
 *    afternoon disappears.
 *  - **Whether the feed carries a spread.** Binance and Twelve Data do not, so bars from them fall
 *    back to `defaultSpreadPoints` and their cost figures are not comparable with Dukascopy's.
 *    That is a property of the SOURCE and belongs here, not in a footnote on the results page.
 *  - **Blocked since**, when a source has refused repeatedly (A11). A card that stays cheerfully
 *    green while every nightly job fails is exactly the failure A11 was written about.
 *
 * The API key itself never reaches the browser — only whether one is present, and the NAME of the
 * variable to set when it is not.
 */

export function ProviderCards({
  providers,
}: {
  readonly providers: readonly ProviderCard[];
}): React.JSX.Element {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="provider-cards">
      {providers.map((p) => (
        <Card key={p.id} provider={p} />
      ))}
    </div>
  );
}

function Card({ provider: p }: { readonly provider: ProviderCard }): React.JSX.Element {
  const blocked = p.blocked.length > 0;

  return (
    <article
      className="rounded-md border border-border p-3"
      data-testid={`provider-${p.id}`}
      data-enabled={p.enabled}
    >
      <header className="flex items-center gap-2">
        <h3 className="text-sm font-medium">{p.label}</h3>
        {p.enabled ? (
          <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[0.65rem] font-medium uppercase text-emerald-300">
            <Check className="size-3" /> ready
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 rounded bg-slate-500/15 px-1.5 py-0.5 text-[0.65rem] font-medium uppercase text-slate-400">
            <X className="size-3" /> off
          </span>
        )}
        {p.requiresKey && (
          <span
            className="ml-auto inline-flex items-center gap-1 text-[0.65rem] text-muted"
            title={p.enabled ? 'An API key is configured' : 'This provider needs an API key'}
          >
            <KeyRound className="size-3" />
            key
          </span>
        )}
      </header>

      {/* Names the variable, never its value. */}
      {!p.enabled && p.disabledReason !== undefined && (
        <p className="mt-1.5 rounded bg-slate-500/10 p-1.5 text-xs text-slate-300">
          {p.disabledReason}
        </p>
      )}

      {p.historyNote !== undefined && (
        <p className="mt-1.5 text-xs leading-relaxed text-muted">{p.historyNote}</p>
      )}

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted">Assets</dt>
        <dd className="text-right">{p.assetClasses.join(', ')}</dd>

        <dt className="text-muted">Spread</dt>
        <dd className={`text-right ${p.providesSpread ? '' : 'text-amber-300'}`}>
          {p.providesSpread ? 'per bar' : 'not supplied'}
        </dd>

        {p.budget !== null && (
          <>
            <dt className="text-muted">Credits today</dt>
            <dd
              className={`text-right tabular-nums ${creditClass(p.budget.dayRemaining, p.budget.perDay)}`}
              data-testid={`provider-${p.id}-credits`}
            >
              {p.budget.dayRemaining} / {p.budget.perDay}
            </dd>

            <dt className="text-muted">This minute</dt>
            <dd className="text-right tabular-nums">
              {p.budget.minuteRemaining} / {p.budget.perMinute}
            </dd>

            <dt className="text-muted">Resets</dt>
            <dd className="text-right">
              {new Date(p.budget.dayResetsAt).toISOString().slice(11, 16)} UTC
            </dd>
          </>
        )}
      </dl>

      {/*
        A61: a source that has refused for several nights running is BLOCKED, not merely quiet, and
        the card says so per symbol. Exiting zero and staying green is what hid this before.
      */}
      {blocked && (
        <div
          className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-1.5"
          data-testid={`provider-${p.id}-blocked`}
        >
          <p className="flex items-center gap-1 text-xs font-medium text-amber-200">
            <AlertTriangle className="size-3" /> Refusing requests
          </p>
          <ul className="mt-1 space-y-0.5 text-[0.65rem] text-amber-100/90">
            {p.blocked.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

/** Amber under a fifth left, rose under a twentieth: a backfill needs headroom, not a green light. */
function creditClass(remaining: number, total: number): string {
  if (total <= 0) return '';
  const share = remaining / total;
  if (share <= 0.05) return 'text-rose-300';
  if (share <= 0.2) return 'text-amber-300';
  return 'text-emerald-300';
}
