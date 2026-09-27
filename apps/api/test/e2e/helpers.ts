import 'reflect-metadata';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { startWorkers, type WorkerHandle } from '@edgelab/worker/boot';
import { loadDotEnvFile, loadEnv, type Env } from '@edgelab/shared/config';
import type { JobEvent } from '@edgelab/shared';

import { AppModule } from '../../src/app.module';
import { ApiErrorFilter } from '../../src/common/error.filter';

/**
 * End-to-end harness: a real API and real workers, in this process, against the dockerised
 * TimescaleDB and Redis.
 *
 * Deliberately not mocked at any layer. The whole question this test answers is whether HTTP →
 * BullMQ → piscina → Postgres → SSE actually fits together, and every mock in that chain is a
 * place where it could fit together in the test and not in reality.
 *
 * The API listens on port 0 so a `pnpm dev` already running on 3000 does not collide.
 */

export interface Harness {
  readonly baseUrl: string;
  readonly env: Env;
  readonly app: INestApplication;
  readonly workers: WorkerHandle;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  loadDotEnvFile();
  const env = loadEnv(process.env);

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'] });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableShutdownHooks();

  await app.listen(0);
  const server = app.getHttpServer() as Server;
  const address = server.address() as AddressInfo;

  // One thread: the test only ever runs one backtest at a time, and a pool sized to the box
  // would spawn a dozen threads that each open a DB pool.
  const workers = startWorkers(env, { maxThreads: 1, taskTimeoutMs: 120_000 });
  await workers.ready();

  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/api`,
    env,
    app,
    workers,
    async close(): Promise<void> {
      await workers.close();
      await app.close();
    },
  };
}

/* ------------------------------------------------------------------ requests */

export interface ApiResult<T> {
  readonly status: number;
  readonly body: T;
}

export async function apiPost<T>(
  harness: Harness,
  path: string,
  body: unknown,
): Promise<ApiResult<T>> {
  const response = await fetch(`${harness.baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as T };
}

export async function apiGet<T>(harness: Harness, path: string): Promise<ApiResult<T>> {
  const response = await fetch(`${harness.baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as T };
}

export async function apiDelete<T>(harness: Harness, path: string): Promise<ApiResult<T>> {
  const response = await fetch(`${harness.baseUrl}${path}`, { method: 'DELETE' });
  return { status: response.status, body: (await response.json()) as T };
}

/* ----------------------------------------------------------------------- SSE */

export interface SseOutcome {
  readonly events: JobEvent[];
  readonly final: JobEvent;
}

/**
 * Follow an SSE job stream to its terminal event.
 *
 * Parsed by hand rather than with an EventSource polyfill so the test asserts on the actual wire
 * format — `event:` and `data:` lines separated by a blank line. A polyfill that quietly
 * tolerated a malformed frame would hide exactly the bug this is here to catch.
 */
export async function followJobEvents(
  harness: Harness,
  jobId: string,
  timeoutMs = 180_000,
): Promise<SseOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(`${harness.baseUrl}/jobs/${jobId}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`SSE stream returned ${String(response.status)}: ${await response.text()}`);
    }
    if (response.body === null) throw new Error('SSE stream had no body');

    const events: JobEvent[] = [];
    const decoder = new TextDecoder();
    let buffer = '';

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });

      // Frames are separated by a blank line; anything after the last one is a partial frame
      // and stays in the buffer.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const lines = frame.split('\n');
        const name = lines
          .find((l) => l.startsWith('event:'))
          ?.slice('event:'.length)
          .trim();
        const data = lines
          .find((l) => l.startsWith('data:'))
          ?.slice('data:'.length)
          .trim();

        if (name === 'progress' && data !== undefined) {
          events.push(JSON.parse(data) as JobEvent);
        }
        if (name === 'end') {
          const final = events[events.length - 1];
          if (final === undefined) throw new Error('stream ended with no progress events');
          return { events, final };
        }
      }
    }

    const final = events[events.length - 1];
    if (final === undefined) throw new Error('stream closed with no progress events');
    return { events, final };
  } finally {
    clearTimeout(timer);
  }
}
