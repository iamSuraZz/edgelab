import { sourcesInRange, type DbClient } from '@edgelab/db';
import { mixedSourceMessage } from '@edgelab/shared';

/**
 * Refuse a run whose range straddles two feeds (A6).
 *
 * Policy lives here rather than in `packages/engine` or `packages/validation`: both are pure and
 * may not see the database, and the engine must stay injectable. The QUERY lives in `packages/db`.
 *
 * The window checked is the REQUESTED `[fromMs, toMs)`, deliberately, not the loaded window. The
 * three run paths pad warmup differently — two use `warmupBars * tfMs * 2.5`, the validator uses
 * `warmupBars * tfMs` — so guarding the loaded window would refuse different ranges depending on
 * which path you came in through. A feed boundary that falls only inside warmup padding also means
 * something different: indicators warm on it, but no trade is decided there.
 */

export class MixedFeedError extends Error {
  readonly code = 'mixed-feed';

  constructor(message: string) {
    // Tagged in `cause`, because this is thrown inside a piscina thread on the job path and
    // structured clone drops own properties and normalises `name`. Without the tag the refusal
    // reaches the user as "your script has a bug".
    super(message, { cause: { edgelabCode: 'validation-failed' } });
    this.name = 'MixedFeedError';
  }
}

export interface AssertSingleFeedParams {
  readonly db: DbClient;
  readonly symbolId: string;
  readonly symbolCode: string;
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * Throw unless every bar in the requested range came from one feed.
 *
 * Returns the single source when there is one, so callers can record which feed a run used — a run
 * that does not say which vendor produced its bars is not reproducible.
 *
 * An EMPTY range is not this guard's problem: "no data at all" has its own, better error elsewhere
 * that names the stored coverage, and duplicating it here would shadow it with a vaguer message.
 */
export async function assertSingleFeed(params: AssertSingleFeedParams): Promise<string | null> {
  const spans = await sourcesInRange(params.db, params.symbolId, params.fromMs, params.toMs);

  if (spans.length === 0) return null;
  if (spans.length === 1) return spans[0]!.source;

  throw new MixedFeedError(mixedSourceMessage({ symbol: params.symbolCode, sources: spans }));
}
