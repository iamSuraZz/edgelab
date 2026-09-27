import { threadId } from 'node:worker_threads';

/**
 * TEST FIXTURE ONLY — never referenced by shipped code.
 *
 * A task that misbehaves on demand, so the isolation in `isolated-pool.ts` can be proven
 * against the real failure modes instead of mocked ones. Mocking a worker crash would test
 * the mock; this tests Node, V8 and piscina.
 *
 * It lives under `__fixtures__` so it is obvious that nothing in production loads it.
 */

export type HostileMode =
  'ok' | 'throw' | 'reject' | 'spin' | 'allocate' | 'exit' | 'throw-non-error';

export interface HostileInput {
  readonly mode: HostileMode;
}

export interface HostileOutput {
  readonly ok: true;
  readonly threadId: number;
}

export default function hostile(input: HostileInput): HostileOutput {
  switch (input.mode) {
    case 'ok':
      return { ok: true, threadId };

    case 'throw':
      throw new Error('deliberate synchronous failure on line 12');

    case 'throw-non-error':
      // Pine transpilation can reject with a plain object; the classifier must survive it.
      throw { notAnError: true, detail: 'string me' };

    case 'reject':
      throw new Error('deliberate async failure');

    case 'spin': {
      // A synchronous busy loop: unreachable by any in-thread cancellation, so the only way
      // out is terminating the thread. This is what `while true` in a Pine script looks like.
      for (;;) {
        Math.sqrt(Math.random());
      }
    }

    case 'allocate': {
      // Grow the V8 HEAP until it refuses, holding every reference so nothing is collected.
      //
      // Deliberately NOT typed arrays: an ArrayBuffer's bytes live in external memory, which
      // `maxOldGenerationSizeMb` does not govern, so a Uint8Array loop sails past the limit
      // and keeps going. Strings and objects are old-generation, which is what the limit
      // actually caps — this is the shape of the runaway a Pine `var array` produces.
      const held: unknown[] = [];
      for (;;) {
        const chunk: Record<string, number>[] = [];
        for (let i = 0; i < 20_000; i += 1) {
          chunk.push({ a: i, b: i * 2, c: i * 3, d: i * 4 });
        }
        held.push(chunk, `${String(held.length)}`.repeat(10_000));
      }
    }

    case 'exit':
      // The bluntest possible thread death, with no error to report.
      process.exit(1);
  }
}
