import { and, desc, eq, isNull, sql } from 'drizzle-orm';
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

type HoldoutRow = typeof holdouts.$inferSelect;

function toHoldout(row: HoldoutRow): Holdout {
  return {
    id: row.id,
    symbolId: row.symbolId,
    sealedFromMs: fromDbTime(row.sealedFrom),
    createdAtMs: fromDbTime(row.createdAt),
    viewCount: row.viewCount,
    lastViewedAtMs: row.lastViewedAt === null ? null : fromDbTime(row.lastViewedAt),
    retiredAtMs: row.retiredAt === null ? null : fromDbTime(row.retiredAt),
  };
}

/** The seal currently in force for a symbol, or null. Only an ACTIVE seal truncates a read. */
export async function getHoldout(client: DbClient, symbolId: string): Promise<Holdout | null> {
  const m = cacheFor(client);
  const hit = m.get(symbolId);
  if (hit !== undefined) return hit;

  const rows = await client.db
    .select()
    .from(holdouts)
    .where(and(eq(holdouts.symbolId, symbolId), isNull(holdouts.retiredAt)));

  const row = rows[0];
  const value = row === undefined ? null : toHoldout(row);

  m.set(symbolId, value);
  return value;
}

/**
 * Every seal this symbol has ever had, newest first.
 *
 * This is what makes a fresh seal's "viewed 0 times" honest or not: a reader can see that three
 * earlier seals over the same ground were retired after a dozen views between them.
 */
export async function holdoutHistory(client: DbClient, symbolId: string): Promise<Holdout[]> {
  const rows = await client.db
    .select()
    .from(holdouts)
    .where(eq(holdouts.symbolId, symbolId))
    .orderBy(desc(holdouts.createdAt));

  return rows.map(toHoldout);
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
        `time(s). Re-sealing would reset that count over data already seen; retire it explicitly ` +
        `if you really mean to start again — the retired seal and its count stay in the history.`,
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
    /*
     * The ACTIVE seal only (A59).
     *
     * Matching on `symbolId` alone bumped every seal the symbol had ever had, retired ones
     * included — rewriting counts that are the permanent record A38 exists to keep. A retired
     * seal's history is finished; a look at today's holdout is not a look at one dropped last
     * month.
     */
    .where(and(eq(holdouts.symbolId, symbolId), isNull(holdouts.retiredAt)));

  cacheFor(client).delete(symbolId);
  return readHoldoutFresh(client, symbolId);
}

/**
 * The active seal, read from the database, bypassing the cache.
 *
 * For REPORTING, never for enforcement. `getHoldout` is cached because it is consulted on every bar
 * read and invalidated by the writes that go through this module — but a view recorded in a WORKER
 * THREAD writes through its own client and its own cache, so the main process keeps serving the
 * count it last saw. The boundary (`sealedFromMs`) is unaffected, since only sealing and retiring
 * move it and both happen here; the view COUNT is exactly the field another process changes.
 *
 * Reporting a stale count would understate what a holdout has cost, which is the one number this
 * whole mechanism exists to keep honest.
 */
export async function readHoldoutFresh(
  client: DbClient,
  symbolId: string,
): Promise<Holdout | null> {
  const rows = await client.db
    .select()
    .from(holdouts)
    .where(and(eq(holdouts.symbolId, symbolId), isNull(holdouts.retiredAt)))
    .orderBy(desc(holdouts.createdAt))
    .limit(1);

  const row = rows[0];
  const value = row === undefined ? null : toHoldout(row);
  cacheFor(client).set(symbolId, value);
  return value;
}

/**
 * Retire the active seal. NOT a delete.
 *
 * The row keeps its instant, its dates and its view count and stays in the symbol's history for
 * ever. Deleting it would make retire-then-seal reset the count, which is exactly the loophole
 * `sealHoldout` refuses to open directly — and a loophole reachable in two steps is not closed.
 */
export async function retireHoldout(client: DbClient, symbolId: string): Promise<Holdout | null> {
  const active = await getHoldout(client, symbolId);
  if (active === null) return null;

  await client.db
    .update(holdouts)
    .set({ retiredAt: toDbTime(Date.now()) })
    .where(eq(holdouts.id, active.id));

  cacheFor(client).delete(symbolId);
  return { ...active, retiredAtMs: Date.now() };
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
