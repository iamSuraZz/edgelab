import { Lock, Unlock } from 'lucide-react';
import { useState } from 'react';

/**
 * The only route to sealed data.
 *
 * Deliberately a two-step action with the consequence stated in the confirmation, because the whole
 * value of a holdout is that looking is RECORDED (A37, A38). A one-click button would make looking
 * feel like navigation, and a holdout looked at casually is in-sample data with extra steps.
 *
 * The confirmation names the count it will become, not just "this will be counted" — "viewed 0
 * times" and "viewed 4 times" are different decisions, and the second should feel different.
 */

export interface HoldoutActionProps {
  readonly sealedFromMs: number | null;
  readonly viewCount: number;
  /**
   * Seals retired on this symbol before this one, or null when the caller does not know.
   *
   * Null is NOT zero here: "no seal was ever retired" is a claim about how untouched this ground
   * is, and asserting it from a value nobody looked up is the kind of reassuring default A38 exists
   * to prevent.
   */
  readonly retiredSeals: number | null;
  /** Runs the suite with the seal lifted. The caller performs it; this only confirms. */
  readonly onTestOnHoldout: () => void;
  readonly busy?: boolean;
}

export function HoldoutAction({
  sealedFromMs,
  viewCount,
  retiredSeals,
  onTestOnHoldout,
  busy = false,
}: HoldoutActionProps): React.JSX.Element | null {
  const [confirming, setConfirming] = useState(false);

  if (sealedFromMs === null) return null;

  return (
    <div className="rounded-md border border-border p-3" data-testid="holdout-action">
      <h4 className="flex items-center gap-1.5 text-sm font-medium">
        <Lock className="h-3.5 w-3.5" />
        Sealed holdout
      </h4>

      <p className="mt-1 text-xs leading-relaxed text-muted">
        Data from {new Date(sealedFromMs).toISOString().slice(0, 10)} onwards is reserved and
        excluded from every ordinary run. It has been viewed{' '}
        <strong className={viewCount === 0 ? 'text-emerald-300' : 'text-amber-300'}>
          {viewCount} time{viewCount === 1 ? '' : 's'}
        </strong>
        .
        {retiredSeals !== null && retiredSeals > 0 && (
          <>
            {' '}
            {retiredSeals} earlier seal{retiredSeals === 1 ? ' was' : 's were'} retired on this
            symbol, so this ground is not untouched.
          </>
        )}
      </p>

      {!confirming ? (
        <button
          type="button"
          onClick={() => {
            setConfirming(true);
          }}
          disabled={busy}
          className="mt-2 inline-flex items-center gap-1.5 rounded border border-amber-500/40 px-2.5 py-1 text-xs text-amber-200 hover:bg-amber-500/10 disabled:opacity-40"
          data-testid="test-on-holdout"
        >
          <Unlock className="h-3 w-3" />
          Test on holdout
        </button>
      ) : (
        <div
          className="mt-2 rounded border border-amber-500/40 bg-amber-500/10 p-2"
          data-testid="holdout-confirm"
        >
          <p className="text-xs leading-relaxed text-amber-100">
            This will read the sealed data and <strong>record the view</strong>. The count becomes{' '}
            <strong>{viewCount + 1}</strong>, permanently and on every future report for this
            symbol. Each view weakens the holdout: data looked at repeatedly is in-sample data,
            whatever it is labelled.
          </p>
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
                onTestOnHoldout();
              }}
              className="rounded bg-amber-500/80 px-2.5 py-1 text-xs font-medium text-slate-900"
              data-testid="holdout-confirm-yes"
            >
              Count the view and test
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirming(false);
              }}
              className="rounded border border-border px-2.5 py-1 text-xs"
              data-testid="holdout-confirm-no"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
