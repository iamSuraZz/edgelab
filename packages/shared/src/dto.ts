import { z } from 'zod';
import { TIMEFRAME_CODES } from './timeframes';

/** All times crossing a boundary are UTC epoch milliseconds. */
export const EpochMsSchema = z.number().int().nonnegative();

export const TimeframeSchema = z.enum(TIMEFRAME_CODES);

export const PineVersionSchema = z.enum(['v5', 'v6']);
export type PineVersion = z.infer<typeof PineVersionSchema>;

export const DateRangeSchema = z
  .object({
    /** Inclusive start, bar open time. */
    from: EpochMsSchema,
    /** Exclusive end. */
    to: EpochMsSchema,
  })
  .refine((r) => r.from < r.to, { message: '`from` must be earlier than `to`' });
export type DateRange = z.infer<typeof DateRangeSchema>;

/** Broker cost overlay applied on top of raw signals. */
export const CostModelSchema = z.object({
  spreadPoints: z.number().nonnegative().default(0),
  commissionPerLot: z.number().nonnegative().default(0),
  swapLongPerDay: z.number().default(0),
  swapShortPerDay: z.number().default(0),
  slippagePoints: z.number().nonnegative().default(0),
});
export type CostModel = z.infer<typeof CostModelSchema>;

export const BacktestRequestSchema = z.object({
  pineSource: z.string().min(1),
  pineVersion: PineVersionSchema,
  symbol: z.string().min(1),
  timeframe: TimeframeSchema,
  range: DateRangeSchema,
  initialCapital: z.number().positive().default(10_000),
  // zod 4's .default() takes the parsed OUTPUT type, so every field is spelled out
  // here rather than relying on the inner .default()s to fill in from `{}`.
  costs: CostModelSchema.default({
    spreadPoints: 0,
    commissionPerLot: 0,
    swapLongPerDay: 0,
    swapShortPerDay: 0,
    slippagePoints: 0,
  }),
});
export type BacktestRequest = z.infer<typeof BacktestRequestSchema>;

export const JobStateSchema = z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']);
export type JobState = z.infer<typeof JobStateSchema>;

/** Streamed over SSE while a job runs. */
export const JobProgressSchema = z.object({
  jobId: z.string().min(1),
  state: JobStateSchema,
  /** 0..100 */
  percent: z.number().min(0).max(100),
  message: z.string().default(''),
  updatedAt: EpochMsSchema,
});
export type JobProgress = z.infer<typeof JobProgressSchema>;

export const DependencyHealthSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().nonnegative().optional(),
  error: z.string().optional(),
});
export type DependencyHealth = z.infer<typeof DependencyHealthSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeMs: z.number().nonnegative(),
  checks: z.object({
    database: DependencyHealthSchema,
    redis: DependencyHealthSchema,
  }),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
