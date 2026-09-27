import { z } from 'zod';

import { CostConfigSchema, DEFAULT_COSTS } from './costs';
import { SymbolCodeSchema } from './feeds';
import { EpochMsSchema, JobStateSchema, PineVersionSchema, TimeframeSchema } from './dto';
import { SymbolPatchSchema } from './market';
import { ProviderIdSchema } from './market';

/**
 * The HTTP contract. One definition per request and response, shared by the API that
 * validates it and any client that calls it, so the two cannot drift.
 *
 * Every schema here is the SINGLE source of validation — controllers do not re-check by hand.
 */

/* ------------------------------------------------------------------ errors */

export const API_ERROR_CODES = [
  'validation-failed',
  'not-found',
  'conflict',
  'no-data',
  'compile-failed',
  'currency-mismatch',
  'provider-unavailable',
  'job-not-cancellable',
  'unsupported',
  'internal',
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/**
 * The error envelope. `message` is written for a human and must name the REAL reason — "no
 * EURUSD data after 2024-02-01", not "bad request" — because the most common failure in this
 * app is asking for a range that was never downloaded, and a generic message sends you
 * debugging the wrong thing.
 *
 * `details` carries whatever a client can act on programmatically: the failing zod paths, the
 * coverage window that does exist, the compile diagnostics.
 */
export const ApiErrorSchema = z.object({
  code: ApiErrorCodeSchema,
  message: z.string().min(1),
  details: z.unknown().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/* -------------------------------------------------------------- pine/compile */

export const CompileRequestSchema = z.object({
  source: z.string().min(1, 'Pine source cannot be empty'),
});
export type CompileRequest = z.infer<typeof CompileRequestSchema>;

/* -------------------------------------------------------------- strategies */

export const CreateStrategySchema = z.object({
  name: z.string().min(1).max(200),
  source: z.string().min(1),
  notes: z.string().max(10_000).nullish(),
  tags: z.array(z.string().min(1).max(40)).max(20).default([]),
});
export type CreateStrategy = z.infer<typeof CreateStrategySchema>;

export const CreateStrategyVersionSchema = z.object({
  source: z.string().min(1),
});
export type CreateStrategyVersion = z.infer<typeof CreateStrategyVersionSchema>;

/**
 * Library metadata. Both fields are optional so the Library page can rename a tag without
 * resending the notes, and `.nullable()` on notes is how you CLEAR them — omitted means
 * "leave alone", which an empty string cannot express.
 */
export const UpdateStrategySchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    notes: z.string().max(10_000).nullable().optional(),
    tags: z.array(z.string().min(1).max(40)).max(20).optional(),
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'Nothing to update' });
export type UpdateStrategy = z.infer<typeof UpdateStrategySchema>;

/** A single stored version WITH its source, for the diff view and `.pine` export. */
export const StrategyVersionSourceSchema = z.object({
  id: z.string(),
  strategyId: z.string(),
  version: z.number().int().positive(),
  source: z.string(),
});
export type StrategyVersionSource = z.infer<typeof StrategyVersionSourceSchema>;

export const StrategyVersionSummarySchema = z.object({
  id: z.string(),
  version: z.number().int().positive(),
  sourceHash: z.string(),
  pineVersion: PineVersionSchema,
  title: z.string().nullable(),
  createdAt: EpochMsSchema,
});
export type StrategyVersionSummary = z.infer<typeof StrategyVersionSummarySchema>;

export const StrategySummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
  versionCount: z.number().int().nonnegative(),
  latestVersion: StrategyVersionSummarySchema.nullable(),
});
export type StrategySummary = z.infer<typeof StrategySummarySchema>;

/* --------------------------------------------------------------- backtests */

/**
 * A run request. Either `source` or `strategyVersionId` — a run must be reproducible, and an
 * inline source gets saved as a version before the job starts, so both paths end up pointing
 * at a stored version.
 */
export const CreateBacktestSchema = z
  .object({
    source: z.string().min(1).optional(),
    strategyVersionId: z.string().uuid().optional(),
    /** Only used when `source` is given, to name the strategy it gets saved under. */
    name: z.string().min(1).max(200).optional(),

    symbol: SymbolCodeSchema,
    timeframe: TimeframeSchema,
    from: EpochMsSchema,
    to: EpochMsSchema,

    initialCapital: z.number().positive().default(10_000),
    accountCurrency: z.string().length(3).default('USD'),
    costs: CostConfigSchema.default(DEFAULT_COSTS),

    /** Input overrides keyed by `InputSpec.key`, which is the Pine varId. */
    inputs: z.record(z.string(), z.unknown()).default({}),
    /** `strategy()` property overrides. */
    props: z.record(z.string(), z.unknown()).default({}),

    warmupBars: z.number().int().min(0).max(20_000).default(500),
    rfAnnual: z.number().min(-1).max(1).default(0),

    /**
     * Position size in lots. Omitted or 0 keeps the script's own sizing.
     *
     * Present because Pine sizes in CONTRACTS: `default_qty_value=1` on EURUSD is one euro.
     * See the mid-slice note in docs/decisions.md.
     */
    lots: z.number().min(0).max(10_000).default(0),
    /** Converted to the engine's margin percentages as 100/leverage (spec 03). */
    leverage: z.number().positive().max(10_000).default(100),
  })
  .refine((r) => r.from < r.to, { message: '`from` must be earlier than `to`', path: ['from'] })
  .refine((r) => r.source !== undefined || r.strategyVersionId !== undefined, {
    message: 'Provide either `source` or `strategyVersionId`',
    path: ['source'],
  })
  .refine((r) => !(r.source !== undefined && r.strategyVersionId !== undefined), {
    message: 'Provide `source` OR `strategyVersionId`, not both',
    path: ['source'],
  });
export type CreateBacktest = z.infer<typeof CreateBacktestSchema>;

export const RUN_STATES = ['queued', 'running', 'completed', 'failed', 'cancelled'] as const;
export const RunStateSchema = z.enum(RUN_STATES);
export type RunState = z.infer<typeof RunStateSchema>;

export const BacktestCreatedSchema = z.object({
  runId: z.string(),
  jobId: z.string(),
  strategyId: z.string(),
  strategyVersionId: z.string(),
  version: z.number().int().positive(),
  /** SSE endpoint for this run's progress. */
  eventsUrl: z.string(),
});
export type BacktestCreated = z.infer<typeof BacktestCreatedSchema>;

/* ------------------------------------------------------ backtest series query */

export const SeriesQuerySchema = z.object({
  /** Return every point instead of a downsampled view. */
  full: z.coerce.boolean().default(false),
  /** Target point count when downsampling. */
  points: z.coerce.number().int().min(50).max(20_000).default(2_000),
});
export type SeriesQuery = z.infer<typeof SeriesQuerySchema>;

/* --------------------------------------------------------------- data / jobs */

export const IngestRequestSchema = z
  .object({
    symbol: SymbolCodeSchema,
    provider: ProviderIdSchema,
    from: EpochMsSchema,
    to: EpochMsSchema,
    /** Ignore the resume watermark and re-fetch the whole range. */
    force: z.boolean().default(false),
  })
  .refine((r) => r.from < r.to, { message: '`from` must be earlier than `to`', path: ['from'] });
export type IngestRequestBody = z.infer<typeof IngestRequestSchema>;

export const JobCreatedSchema = z.object({
  jobId: z.string(),
  queue: z.string(),
  eventsUrl: z.string(),
});
export type JobCreated = z.infer<typeof JobCreatedSchema>;

/**
 * Multipart import. The file itself arrives out of band; these are the fields beside it.
 *
 * `serverUtcOffsetMinutes` is required for MT5 exports because those files carry the
 * BROKER's local time with no zone marker, so without the offset every bar is silently
 * shifted by hours.
 */
export const ImportRequestSchema = z.object({
  symbol: SymbolCodeSchema,
  format: z.enum(['mt5-csv', 'exness-ticks', 'generic-csv']),
  serverUtcOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0),
});
export type ImportRequestBody = z.infer<typeof ImportRequestSchema>;

/* ------------------------------------------------------------------ candles */

export const CandlesQuerySchema = z
  .object({
    symbol: SymbolCodeSchema,
    tf: TimeframeSchema,
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().nonnegative(),
  })
  .refine((q) => q.from < q.to, { message: '`from` must be earlier than `to`', path: ['from'] });
export type CandlesQuery = z.infer<typeof CandlesQuerySchema>;

/**
 * Same range query without a timeframe, for the per-day bar-count heatmap.
 *
 * Spelled out rather than derived from `CandlesQuerySchema` by `.omit()`: that schema carries a
 * `.refine()`, so it is a ZodEffects and has no `.omit()` — and unwrapping it to reach the inner
 * object would drop the very check that makes the range valid.
 */
export const DailyCountsQuerySchema = z
  .object({
    symbol: SymbolCodeSchema,
    from: z.coerce.number().int().nonnegative(),
    to: z.coerce.number().int().nonnegative(),
  })
  .refine((q) => q.from < q.to, { message: '`from` must be earlier than `to`', path: ['from'] });
export type DailyCountsQuery = z.infer<typeof DailyCountsQuerySchema>;

export const SymbolPatchBodySchema = SymbolPatchSchema;

/* ------------------------------------------------------------- job events */

/**
 * One SSE frame on `GET /jobs/:id/events`.
 *
 * `state` is the job's own lifecycle; `runId` is present for backtest jobs so a client can go
 * straight to the report when it completes without a second lookup.
 */
export const JobEventSchema = z.object({
  jobId: z.string(),
  queue: z.string(),
  state: JobStateSchema,
  percent: z.number().min(0).max(100),
  message: z.string(),
  updatedAt: EpochMsSchema,
  runId: z.string().nullish(),
  /** Set when `state` is 'failed'. */
  error: z.string().nullish(),
  /** Machine-readable failure reason, matching the API error codes where applicable. */
  errorCode: z.string().nullish(),
});
export type JobEvent = z.infer<typeof JobEventSchema>;

/** Redis pub/sub channel the worker publishes a job's events on. */
export function jobEventChannel(jobId: string): string {
  return `edgelab:job:${jobId}`;
}

/** Redis channel the API publishes a cancellation request on. */
export function jobCancelChannel(jobId: string): string {
  return `edgelab:cancel:${jobId}`;
}

/**
 * Key holding the last event for a job, so a client that connects late gets the current state
 * immediately rather than waiting for the next change — or forever, if the job already ended.
 */
export function jobStateKey(jobId: string): string {
  return `edgelab:jobstate:${jobId}`;
}

/** Query for the Runs page list. */
export const ListRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
export type ListRunsQuery = z.infer<typeof ListRunsQuerySchema>;
