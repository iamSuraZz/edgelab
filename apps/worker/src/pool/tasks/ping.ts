import { threadId } from 'node:worker_threads';

/**
 * The no-op piscina task. It exists to prove the thread pool round-trips data
 * correctly; real CPU-bound work (resampling, Pine execution, metrics) follows this
 * same shape in later phases.
 *
 * Task modules must default-export a single function and stay free of shared mutable
 * state — each thread loads its own copy.
 */

export interface PingInput {
  readonly sentAt: number;
  readonly note?: string;
}

export interface PingOutput {
  readonly pong: true;
  readonly sentAt: number;
  readonly receivedAt: number;
  readonly roundTripMs: number;
  /** Proves the callback really executed off the main thread. */
  readonly threadId: number;
  readonly note: string;
}

export default function ping(input: PingInput): PingOutput {
  const receivedAt = Date.now();
  return {
    pong: true,
    sentAt: input.sentAt,
    receivedAt,
    roundTripMs: receivedAt - input.sentAt,
    threadId,
    note: input.note ?? 'ping',
  };
}
