import type { Job } from 'bullmq';

import { findSymbolByCode, type DbClient } from '@edgelab/db';
import type { ProviderId } from '@edgelab/shared';

import { runIngest, type IngestResult } from '../ingest/ingest';
import type { ProviderRegistry } from '../ingest/providers';
import type { CancellationWatcher } from './cancellation';
import type { JobEventPublisher } from './events';

/**
 * The `ingest` job — a thin wrapper around `runIngest`, which already handles resumption.
 *
 * NOT run in the piscina pool, unlike the backtest job, and the asymmetry is deliberate: this
 * work is network-bound, not CPU-bound. It spends its life waiting on Dukascopy with the event
 * loop free, so a thread would buy nothing and cost a second DB pool. The thing a thread
 * protects against — a user-supplied script wedging or exhausting memory — has no analogue
 * here, because the code being run is ours.
 *
 * A provider error therefore surfaces as an ordinary rejection. What must NOT happen is the
 * whole worker dying, which is why the processor catches and reports rather than letting an
 * HTTP 429 or a malformed CSV escape.
 */

export const INGEST_JOB = 'ingest';

export interface IngestJobData {
  readonly symbolCode: string;
  readonly provider: ProviderId;
  readonly fromMs: number;
  readonly toMs: number;
  readonly force: boolean;
}

export interface IngestJobDeps {
  readonly db: DbClient;
  readonly registry: ProviderRegistry;
  readonly events: JobEventPublisher;
  readonly cancellation: CancellationWatcher;
}

export async function processIngestJob(
  job: Job<IngestJobData>,
  deps: IngestJobDeps,
): Promise<IngestResult> {
  const jobId = String(job.id);
  const base = { jobId, queue: 'ingest', runId: null };

  const controller = deps.cancellation.register(jobId);
  const progress = deps.events.throttled(base);

  await deps.events.emit({
    ...base,
    state: 'running',
    percent: 1,
    message: `downloading ${job.data.symbolCode} from ${job.data.provider}`,
    updatedAt: Date.now(),
  });

  try {
    const symbol = await findSymbolByCode(deps.db, job.data.symbolCode);
    if (symbol === null) throw new Error(`Unknown symbol ${job.data.symbolCode}`);

    const result = await runIngest(
      deps.db,
      deps.registry,
      {
        symbol,
        provider: job.data.provider,
        fromMs: job.data.fromMs,
        toMs: job.data.toMs,
        force: job.data.force,
      },
      (p) => {
        // Cancellation is checked between batches rather than mid-download: a provider fetch
        // is not interruptible, so the honest granularity is one chunk.
        if (controller.signal.aborted) {
          throw new IngestCancelled();
        }
        progress.report(p.percent, p.message);
        void job.updateProgress(Math.round(p.percent)).catch(() => undefined);
      },
    );

    await progress.flush();
    await deps.events.emit({
      ...base,
      state: 'completed',
      percent: 100,
      message:
        `${result.barsInserted.toLocaleString('en-US')} new bars ` +
        `(${result.duplicates.toLocaleString('en-US')} already present)` +
        `${result.resumed ? ', resumed' : ''}`,
      updatedAt: Date.now(),
    });

    return result;
  } catch (error: unknown) {
    await progress.flush();

    const cancelled = controller.signal.aborted || error instanceof IngestCancelled;
    const message = error instanceof Error ? error.message : String(error);

    await deps.events.emit({
      ...base,
      state: cancelled ? 'cancelled' : 'failed',
      percent: 100,
      message: cancelled ? 'cancelled' : 'failed',
      updatedAt: Date.now(),
      error: cancelled ? 'Cancelled.' : message,
      errorCode: cancelled ? 'cancelled' : classifyIngestError(message),
    });

    if (cancelled) {
      // Bars already written stay written — ingest is resumable, so a cancelled download is a
      // partial download, not a wasted one.
      throw new IngestCancelled();
    }
    throw error instanceof Error ? error : new Error(message);
  } finally {
    deps.cancellation.unregister(jobId);
  }
}

export class IngestCancelled extends Error {
  constructor() {
    super('Ingest cancelled.');
    this.name = 'IngestCancelled';
  }
}

/**
 * Name the real reason where it is recognisable, because the difference between "you are rate
 * limited, wait" and "that provider has no such symbol" is the difference between retrying and
 * changing the request.
 */
function classifyIngestError(message: string): string {
  if (/429|rate.?limit/i.test(message)) return 'provider-unavailable';
  if (/disabled|API key|unavailable/i.test(message)) return 'provider-unavailable';
  if (/unknown symbol|unsupported symbol/i.test(message)) return 'not-found';
  return 'internal';
}
