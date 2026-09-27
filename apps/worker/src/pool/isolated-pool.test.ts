import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  TaskCrashedError,
  TaskOutOfMemoryError,
  TaskScriptError,
  TaskTimeoutError,
  classifyTaskFailure,
} from './errors';
import { IsolatedPool } from './isolated-pool';
import type { HostileInput, HostileOutput } from './__fixtures__/hostile';

/**
 * The contract: a bad script fails its own job and the pool keeps working.
 *
 * Every case below kills a real worker thread. Nothing is mocked, because the whole question
 * is whether Node, V8 and piscina actually behave as assumed — a mock would only confirm what
 * I already believed.
 */

// __dirname, not import.meta: these packages emit CommonJS, so import.meta is a compile error.
const HOSTILE = path.resolve(__dirname, '__fixtures__', 'hostile.ts');

const pools: IsolatedPool<HostileInput, HostileOutput>[] = [];

function makePool(options: { taskTimeoutMs?: number; memoryLimitMb?: number } = {}) {
  const pool = new IsolatedPool<HostileInput, HostileOutput>({
    filename: HOSTILE,
    maxThreads: 2,
    taskTimeoutMs: options.taskTimeoutMs ?? 30_000,
    memoryLimitMb: options.memoryLimitMb ?? 512,
  });
  pools.push(pool);
  return pool;
}

afterAll(async () => {
  await Promise.all(pools.map((p) => p.close()));
});

describe('IsolatedPool — the happy path', () => {
  it('runs a task off the main thread', async () => {
    const pool = makePool();
    const result = await pool.run({ mode: 'ok' });
    expect(result.ok).toBe(true);
    expect(result.threadId).not.toBe(0); // 0 is the main thread
  });

  it('reports its configured limits, so a caller can show them', () => {
    const pool = makePool({ taskTimeoutMs: 1_234, memoryLimitMb: 77 });
    expect(pool.stats.timeoutMs).toBe(1_234);
    expect(pool.stats.memoryLimitMb).toBe(77);
  });
});

describe('IsolatedPool — a throwing task fails its job, not the worker', () => {
  it('rejects with a script error carrying the original message', async () => {
    const pool = makePool();
    await expect(pool.run({ mode: 'throw' })).rejects.toThrow(TaskScriptError);
    await expect(pool.run({ mode: 'throw' })).rejects.toThrow(/line 12/);
  });

  it('survives a thrown non-Error', async () => {
    const pool = makePool();
    // A rejection that is not an Error would crash a classifier that assumed `.message`.
    await expect(pool.run({ mode: 'throw-non-error' })).rejects.toBeInstanceOf(TaskScriptError);
  });

  it('keeps serving tasks afterwards', async () => {
    const pool = makePool();
    await expect(pool.run({ mode: 'throw' })).rejects.toThrow();
    await expect(pool.run({ mode: 'ok' })).resolves.toMatchObject({ ok: true });
  });
});

describe('IsolatedPool — timeout', () => {
  it('stops a synchronous infinite loop and reports a timeout', async () => {
    // The real question: an AbortSignal cannot interrupt running JS, so this only works
    // because piscina terminates the thread. If that ever changes, this test hangs.
    const pool = makePool({ taskTimeoutMs: 600 });
    const failure = await pool.run({ mode: 'spin' }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(TaskTimeoutError);
    expect((failure as TaskTimeoutError).code).toBe('task-timeout');
    expect((failure as Error).message).toMatch(/time limit/);
  }, 20_000);

  it('replaces the killed thread and runs the next task', async () => {
    const pool = makePool({ taskTimeoutMs: 600 });
    await expect(pool.run({ mode: 'spin' })).rejects.toThrow(TaskTimeoutError);
    await expect(pool.run({ mode: 'ok' })).resolves.toMatchObject({ ok: true });
  }, 20_000);

  it('does not time out a task that finishes in time', async () => {
    const pool = makePool({ taskTimeoutMs: 10_000 });
    await expect(pool.run({ mode: 'ok' })).resolves.toMatchObject({ ok: true });
  });

  it('reports a caller cancellation as cancelled, not as a timeout', async () => {
    // The distinction matters: a timeout is the script's fault and worth surfacing, while a
    // cancellation is the user's own doing and should not look like a failure.
    const pool = makePool({ taskTimeoutMs: 30_000 });
    const controller = new AbortController();
    const pending = pool.run({ mode: 'spin' }, { signal: controller.signal });
    setTimeout(() => {
      controller.abort(new Error('user pressed cancel'));
    }, 300);

    const failure = await pending.catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TaskCrashedError);
    expect(failure).not.toBeInstanceOf(TaskTimeoutError);
  }, 20_000);
});

describe('IsolatedPool — memory limit', () => {
  it('kills a thread that allocates without bound and reports it as out of memory', async () => {
    // 64 MB is small enough that the fixture's heap growth breaches it in under a second.
    const pool = makePool({ memoryLimitMb: 64, taskTimeoutMs: 30_000 });
    const failure = await pool.run({ mode: 'allocate' }).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(TaskOutOfMemoryError);
    expect((failure as TaskOutOfMemoryError).code).toBe('task-out-of-memory');
    expect((failure as TaskOutOfMemoryError).limitMb).toBe(64);
  }, 30_000);

  it('keeps the pool usable after an out-of-memory kill', async () => {
    const pool = makePool({ memoryLimitMb: 64, taskTimeoutMs: 30_000 });
    await expect(pool.run({ mode: 'allocate' })).rejects.toThrow(TaskOutOfMemoryError);
    await expect(pool.run({ mode: 'ok' })).resolves.toMatchObject({ ok: true });
  }, 30_000);
});

describe('IsolatedPool — a hard thread death', () => {
  it('rejects the owning job rather than taking the process down', async () => {
    // process.exit() in a thread leaves piscina with no error to report. If this were
    // mishandled it would surface as an unhandled 'error' event and kill the whole worker.
    const pool = makePool();
    await expect(pool.run({ mode: 'exit' })).rejects.toThrow();
  }, 20_000);

  it('still runs the next task', async () => {
    const pool = makePool();
    await expect(pool.run({ mode: 'exit' })).rejects.toThrow();
    await expect(pool.run({ mode: 'ok' })).resolves.toMatchObject({ ok: true });
  }, 20_000);
});

describe('IsolatedPool — one bad task does not disturb its neighbours', () => {
  it('lets concurrent good tasks finish while a sibling is being killed', async () => {
    const pool = makePool({ taskTimeoutMs: 800 });
    const [bad, ...good] = await Promise.allSettled([
      pool.run({ mode: 'spin' }),
      pool.run({ mode: 'ok' }),
      pool.run({ mode: 'ok' }),
    ]);

    expect(bad!.status).toBe('rejected');
    for (const outcome of good) expect(outcome.status).toBe('fulfilled');
  }, 20_000);
});

describe('classifyTaskFailure', () => {
  const context = { timedOut: false, timeoutMs: 120_000, memoryLimitMb: 512 };

  it('trusts our own timeout flag over the error, which cannot distinguish the two', () => {
    const failure = classifyTaskFailure(new Error('The task has been aborted'), {
      ...context,
      timedOut: true,
    });
    expect(failure).toBeInstanceOf(TaskTimeoutError);
  });

  it('recognises the Node out-of-memory code', () => {
    const oom = Object.assign(new Error('worker out of memory'), {
      code: 'ERR_WORKER_OUT_OF_MEMORY',
    });
    expect(classifyTaskFailure(oom, context)).toBeInstanceOf(TaskOutOfMemoryError);
  });

  it('recognises piscina tearing a worker down', () => {
    const failure = classifyTaskFailure(new Error('Terminating worker thread'), context);
    expect(failure).toBeInstanceOf(TaskCrashedError);
  });

  it('treats anything else as a script error and keeps the stack', () => {
    const thrown = new Error('bad indicator');
    const failure = classifyTaskFailure(thrown, context);
    expect(failure).toBeInstanceOf(TaskScriptError);
    expect((failure as TaskScriptError).originalStack).toBe(thrown.stack);
    expect(failure.cause).toBe(thrown);
  });

  it('passes an already-classified failure through unchanged', () => {
    const original = new TaskTimeoutError(5_000);
    expect(classifyTaskFailure(original, context)).toBe(original);
  });

  it('gives every failure type a distinct stable code', () => {
    const codes = [
      new TaskTimeoutError(1).code,
      new TaskOutOfMemoryError(1).code,
      new TaskCrashedError('x').code,
      new TaskScriptError('x', null, null).code,
    ];
    expect(new Set(codes).size).toBe(4);
  });
});
