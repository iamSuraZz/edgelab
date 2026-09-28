import { eq, sql } from 'drizzle-orm';
import { effectiveWindow, sealInstant, type EffectiveWindow, type Holdout } from '@edgelab/shared';

import type { DbClient } from './client';
import { holdouts } from './schema';
import { fromDbTime, toDbTime } from './time';

/**
 * Sealed-holdout storage, and the cache that makes enforcing it affordable.
 *
 * The seal is consulted on EVERY bar read (A24), so it cannot cost a query each time. It is cached
 * per client and per symbol, and invalidated by the two operations that can change it — sealing and
 * unsealing — both of which go through this module.
 *
 * The cache is deliberately not time-based. A stale seal that expires on its own would mean the
 * enforcement quietly weakens while the process runs; a cache invalidated only by writes cannot.
 */

const cache = new WeakMap<DbClient, Map<string, Holdout | null>>();

function cacheFor(client: DbClient): Map<string, Holdout | null> {
  let m = cache.get(client);
  if (m === undefined) {
    m = new Map();
    cache.set(client, m);
  }
  return m;
}

export async function getHoldout(client: DbClient, symbolId: string): Promise<Holdout | null> {
  const m = cacheFor(client);
  const hit = m.get(symbolId);
  if (hit !== undefined) return hit;

  const rows = await client.db.select().from(holdouts).where(eq(holdouts.symbolId, symbolId));
  const row = rows[0];

  const value: Holdout | null =
    row === undefined
      ? null
      : {
          symbolId: row.symbolId,
          sealedFromMs: fromDbTime(row.sealedFrom),
          createdAtMs: fromDbTime(row.createdAt),
          viewCount: row.viewCount,
          lastViewedAtMs: row.lastViewedAt === null ? null : fromDbTime(row.lastViewedAt),
        };

  m.set(symbolId, value);
  return value;
}

export interface SealParams {
  readonly client: DbClient;
  readonly symbolId: string;
  /** Share of the stored range to reserve, e.g. 0.2 for the most recent fifth. */
  readonly fraction: number;
  readonly earliestMs: number;
  readonly latestMs: number;
}

/**
 * Seal a holdout, or refuse.
 *
 * Re-sealing a symbol that already has a holdout is REFUSED rather than overwritten. Moving a seal
 * is the one operation that would make the view count meaningless — look at the data, move the
 * boundary, and the counter reads zero again over ground already walked.
 */
export async function sealHoldout(params: SealParams): Promise<Holdout> {
  const existing = await getHoldout(params.client, params.symbolId);
  if (existing !== null) {
    throw new Error(
      `A holdout is already sealed for this symbol from ` +
        `${new Date(existing.sealedFromMs).toISOString()}, viewed ${String(existing.viewCount)} ` +
        `time(s). Re-sealing would reset that count over data already seen; drop it explicitly if ` +
        `you really mean to start again.`,
    );
  }

  const sealedFromMs = sealInstant(params.earliestMs, params.latestMs, params.fraction);

  await params.client.db
    .insert(holdouts)
    .values({ symbolId: params.symbolId, sealedFrom: toDbTime(sealedFromMs) });

  cacheFor(params.client).delete(params.symbolId);
  return (await getHoldout(params.client, params.symbolId)) as Holdout;
}

/**
 * Record that the holdout was looked at, and return it.
 *
 * Counting happens here rather than at the read, so a caller cannot look without being counted: the
 * only route to sealed bars is `readM1Unsealed`, which calls this first.
 */
export async function recordHoldoutView(
  client: DbClient,
  symbolId: string,
): Promise<Holdout | null> {
  const existing = await getHoldout(client, symbolId);
  if (existing === null) return null;

  await client.db
    .update(holdouts)
    .set({ viewCount: sql`${holdouts.viewCount} + 1`, lastViewedAt: toDbTime(Date.now()) })
    .where(eq(holdouts.symbolId, symbolId));

  cacheFor(client).delete(symbolId);
  return getHoldout(client, symbolId);
}

export async function dropHoldout(client: DbClient, symbolId: string): Promise<void> {
  await client.db.delete(holdouts).where(eq(holdouts.symbolId, symbolId));
  cacheFor(client).delete(symbolId);
}

/** The window a read is allowed, given whatever seal is in force. */
export async function allowedWindow(
  client: DbClient,
  symbolId: string,
  fromMs: number,
  toMs: number,
): Promise<EffectiveWindow> {
  return effectiveWindow(fromMs, toMs, await getHoldout(client, symbolId));
}
