import { and, desc, eq } from 'drizzle-orm';

import type { DbClient } from './client';
import { validationRuns } from './schema';
import { fromDbTime, toDbTime } from './time';

/**
 * Stored validation and optimisation results.
 *
 * A result is written in two steps — created `queued` so the API can hand back an id before the
 * job is picked up, then completed with its report — which is the same contract `backtest_runs`
 * uses and for the same reason: a client must be able to poll something that exists.
 *
 * The context is written at COMPLETION rather than at creation, because most of it is only known
 * once the job has read the data: which feed the bars came from, what the holdout's view count was
 * at that moment, and whether a seal truncated the range.
 */

/**
 * `holdout` is a THIRD kind, not a validation with a flag.
 *
 * It costs something no other kind does — a look at sealed data, recorded permanently (A59) — so it
 * is listed and filtered separately. Folding it into `validation` would bury the one result in this
 * system you cannot re-run for free among the ones you can.
 */
export type ValidationKind = 'validation' | 'optimization' | 'holdout';
export type ValidationState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface ValidationContext {
  readonly feed: string | null;
  readonly dataVersion: number | null;
  readonly engineId: string | null;
  readonly engineVersion: string | null;
  readonly holdoutId: string | null;
  readonly holdoutViewCount: number | null;
  readonly rangeFromMs: number | null;
  readonly rangeToMs: number | null;
  readonly requestedRangeToMs: number | null;
}

export interface ValidationRow {
  readonly id: string;
  readonly runId: string;
  readonly kind: ValidationKind;
  readonly state: ValidationState;
  readonly verdict: string | null;
  readonly report: unknown;
  readonly spec: unknown;
  readonly context: ValidationContext;
  readonly error: string | null;
  readonly elapsedMs: number | null;
  readonly createdAtMs: number;
  readonly completedAtMs: number | null;
}

export interface CreateValidationParams {
  readonly runId: string;
  readonly kind: ValidationKind;
  readonly spec?: unknown;
}

export async function createValidation(
  client: DbClient,
  params: CreateValidationParams,
): Promise<string> {
  const rows = await client.db
    .insert(validationRuns)
    .values({
      runId: params.runId,
      kind: params.kind,
      state: 'queued',
      spec: params.spec === undefined ? null : (params.spec as object),
    })
    .returning({ id: validationRuns.id });

  const id = rows[0]?.id;
  if (id === undefined) throw new Error('Failed to create validation row.');
  return id;
}

export async function setValidationState(
  client: DbClient,
  id: string,
  state: ValidationState,
): Promise<void> {
  await client.db.update(validationRuns).set({ state }).where(eq(validationRuns.id, id));
}

export interface CompleteValidationParams {
  readonly id: string;
  readonly verdict: string;
  readonly report: unknown;
  readonly context: ValidationContext;
  readonly elapsedMs: number;
}

export async function completeValidation(
  client: DbClient,
  params: CompleteValidationParams,
): Promise<void> {
  const c = params.context;
  await client.db
    .update(validationRuns)
    .set({
      state: 'completed',
      verdict: params.verdict,
      report: params.report as object,
      feed: c.feed,
      dataVersion: c.dataVersion,
      engineId: c.engineId,
      engineVersion: c.engineVersion,
      holdoutId: c.holdoutId,
      holdoutViewCount: c.holdoutViewCount,
      rangeFrom: c.rangeFromMs === null ? null : toDbTime(c.rangeFromMs),
      rangeTo: c.rangeToMs === null ? null : toDbTime(c.rangeToMs),
      requestedRangeTo: c.requestedRangeToMs === null ? null : toDbTime(c.requestedRangeToMs),
      elapsedMs: params.elapsedMs,
      completedAt: toDbTime(Date.now()),
    })
    .where(eq(validationRuns.id, params.id));
}

export async function failValidation(
  client: DbClient,
  id: string,
  error: string,
  state: Extract<ValidationState, 'failed' | 'cancelled'> = 'failed',
): Promise<void> {
  await client.db
    .update(validationRuns)
    .set({ state, error, completedAt: toDbTime(Date.now()) })
    .where(eq(validationRuns.id, id));
}

function toRow(r: typeof validationRuns.$inferSelect): ValidationRow {
  return {
    id: r.id,
    runId: r.runId,
    kind: r.kind as ValidationKind,
    state: r.state as ValidationState,
    verdict: r.verdict,
    report: r.report,
    spec: r.spec,
    context: {
      feed: r.feed,
      dataVersion: r.dataVersion,
      engineId: r.engineId,
      engineVersion: r.engineVersion,
      holdoutId: r.holdoutId,
      holdoutViewCount: r.holdoutViewCount,
      rangeFromMs: r.rangeFrom === null ? null : fromDbTime(r.rangeFrom),
      rangeToMs: r.rangeTo === null ? null : fromDbTime(r.rangeTo),
      requestedRangeToMs: r.requestedRangeTo === null ? null : fromDbTime(r.requestedRangeTo),
    },
    error: r.error,
    elapsedMs: r.elapsedMs,
    createdAtMs: fromDbTime(r.createdAt),
    completedAtMs: r.completedAt === null ? null : fromDbTime(r.completedAt),
  };
}

/**
 * Past results for a run, newest first.
 *
 * Without `report`, which is large and not wanted in a list — the tab renders headlines from the
 * summary columns and fetches the full report only when a card is opened.
 */
export async function listValidations(
  client: DbClient,
  runId: string,
  kind?: ValidationKind,
): Promise<readonly Omit<ValidationRow, 'report' | 'spec'>[]> {
  const rows = await client.db
    .select()
    .from(validationRuns)
    .where(
      kind === undefined
        ? eq(validationRuns.runId, runId)
        : and(eq(validationRuns.runId, runId), eq(validationRuns.kind, kind)),
    )
    .orderBy(desc(validationRuns.createdAt));

  return rows.map((r) => {
    const { report: _report, spec: _spec, ...rest } = toRow(r);
    return rest;
  });
}

export async function readValidation(client: DbClient, id: string): Promise<ValidationRow | null> {
  const rows = await client.db.select().from(validationRuns).where(eq(validationRuns.id, id));
  const row = rows[0];
  return row === undefined ? null : toRow(row);
}
