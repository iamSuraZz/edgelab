import { Controller, Get, Inject, Injectable, Module, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';

import { JobEventSchema, jobEventChannel, jobStateKey, type JobEvent } from '@edgelab/shared';

import { ApiException } from '../common/api-error';
import {
  BACKTEST_QUEUE,
  INGEST_QUEUE,
  REDIS_SUBSCRIBER_FACTORY,
  type RedisSubscriberFactory,
} from '../infra/queues.module';
import { REDIS_CLIENT } from '../infra/infra.module';

/**
 * SSE job progress, bridged from the worker over Redis pub/sub.
 *
 * Written against the raw `Response` rather than Nest's `@Sse()` decorator, because `@Sse()`
 * wraps an Observable and gives no clean way to (a) replay the current state before live events
 * or (b) end the stream on a terminal event. Both matter here: a client that connects after a
 * fast job finished would otherwise hang forever waiting for an event that already happened.
 *
 * The sequence is therefore: replay last-known state → subscribe → stream → close on terminal.
 */

/** Keeps proxies and load balancers from closing an idle stream. */
const HEARTBEAT_MS = 15_000;

@Injectable()
export class JobsService {
  constructor(
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(REDIS_SUBSCRIBER_FACTORY) private readonly subscriberFor: RedisSubscriberFactory,
    @Inject(BACKTEST_QUEUE) private readonly backtestQueue: Queue,
    @Inject(INGEST_QUEUE) private readonly ingestQueue: Queue,
  ) {}

  /** The last event the worker published, or a synthesised one from the queue's own state. */
  async currentState(jobId: string): Promise<JobEvent | null> {
    const raw = await this.redis.get(jobStateKey(jobId));
    if (raw !== null) {
      const parsed = JobEventSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    }

    // No published state yet: the job exists but has not been picked up. Synthesising `queued`
    // from the queue means a client subscribing immediately after POST still gets a first frame
    // rather than silence.
    for (const [queue, name] of [
      [this.backtestQueue, 'backtest'],
      [this.ingestQueue, 'ingest'],
    ] as const) {
      const job = await queue.getJob(jobId);
      if (job === undefined) continue;
      const state = await job.getState();
      return {
        jobId,
        queue: name,
        state: state === 'completed' ? 'completed' : state === 'failed' ? 'failed' : 'queued',
        percent: typeof job.progress === 'number' ? job.progress : 0,
        message: `job is ${state}`,
        updatedAt: Date.now(),
        runId: (job.data as { runId?: string } | undefined)?.runId ?? null,
      };
    }

    return null;
  }

  async stream(jobId: string, res: Response): Promise<void> {
    const initial = await this.currentState(jobId);
    if (initial === null) {
      throw ApiException.notFound(
        `No job ${jobId}. It may have completed long enough ago to be pruned from the queue.`,
      );
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Nginx buffers proxied responses by default, which holds every event until the stream
      // closes — exactly backwards for SSE. docker/nginx.conf disables it too; this covers
      // any other proxy in front.
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const send = (event: JobEvent): void => {
      res.write(`event: progress\ndata: ${JSON.stringify(event)}\n\n`);
    };

    send(initial);

    // Already finished: say so and close, rather than holding a socket open for a job that
    // will never emit again.
    if (isTerminal(initial.state)) {
      res.write('event: end\ndata: {}\n\n');
      res.end();
      return;
    }

    const subscriber = this.subscriberFor();
    const heartbeat = setInterval(() => {
      // A comment frame: valid SSE, ignored by clients, enough to keep the socket alive.
      res.write(': keep-alive\n\n');
    }, HEARTBEAT_MS);

    let closed = false;
    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      void subscriber.quit().catch(() => undefined);
    };

    subscriber.on('message', (_channel: string, payload: string) => {
      const parsed = JobEventSchema.safeParse(JSON.parse(payload));
      if (!parsed.success) return;

      send(parsed.data);
      if (isTerminal(parsed.data.state)) {
        res.write('event: end\ndata: {}\n\n');
        cleanup();
        res.end();
      }
    });

    // The client going away is the normal end of an SSE stream, not an error. Without this the
    // subscriber connection and the heartbeat timer leak per abandoned stream.
    res.on('close', cleanup);
    res.on('error', cleanup);

    await subscriber.subscribe(jobEventChannel(jobId));

    // Re-check after subscribing: a job that finished in the gap between the replay above and
    // the subscription would otherwise never deliver its terminal event.
    const afterSubscribe = await this.currentState(jobId);
    if (afterSubscribe !== null && isTerminal(afterSubscribe.state) && !closed) {
      send(afterSubscribe);
      res.write('event: end\ndata: {}\n\n');
      cleanup();
      res.end();
    }
  }
}

function isTerminal(state: JobEvent['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

@Controller('jobs')
export class JobsController {
  constructor(@Inject(JobsService) private readonly jobs: JobsService) {}

  @Get(':id')
  state(@Param('id') id: string): Promise<JobEvent | null> {
    return this.jobs.currentState(id);
  }

  @Get(':id/events')
  events(@Param('id') id: string, @Res() res: Response): Promise<void> {
    return this.jobs.stream(id, res);
  }
}

@Module({
  controllers: [JobsController],
  providers: [JobsService],
  exports: [JobsService],
})
export class JobsModule {}
