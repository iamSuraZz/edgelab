import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq';

/**
 * The three queues from the architecture. Names are centralised here so the API (which
 * enqueues) and the worker (which consumes) can never drift apart.
 */
export const QUEUE_NAMES = {
  ingest: 'ingest',
  backtest: 'backtest',
  validation: 'validation',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUES: readonly QueueName[] = Object.values(QUEUE_NAMES);

/**
 * BullMQ requires `maxRetriesPerRequest: null` on the connection it blocks on, or
 * ioredis will abort long-lived BRPOPLPUSH calls.
 */
export function bullConnection(redisUrl: string): ConnectionOptions {
  return { url: redisUrl, maxRetriesPerRequest: null };
}

/** Retry policy shared by every queue. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  // Keep a short history so the Runs page can show recent failures without
  // Redis growing unbounded.
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 },
} as const;

export function createQueue(name: QueueName, redisUrl: string): Queue {
  return new Queue(name, {
    connection: bullConnection(redisUrl),
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });
}

export interface WorkerOptions {
  /** Jobs processed in parallel by this worker. CPU work goes to piscina, not here. */
  concurrency?: number;
}

export function createWorker(
  name: QueueName,
  redisUrl: string,
  processor: Processor,
  options: WorkerOptions = {},
): Worker {
  return new Worker(name, processor, {
    connection: bullConnection(redisUrl),
    concurrency: options.concurrency ?? 2,
  });
}
