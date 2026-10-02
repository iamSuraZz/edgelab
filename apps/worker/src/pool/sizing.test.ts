import { describe, expect, it } from 'vitest';

import { describePoolSizing, resolvePoolSize } from './sizing';

/**
 * The container case is the whole point (A67).
 *
 * `os.cpus().length` reports the HOST's cores inside a CPU-limited container, so a worker allowed 2
 * CPUs on a 16-core box would have sized its pool at 15 — slower than one thread, and visible only
 * as jobs that take longer in production than on a laptop.
 */
describe('resolvePoolSize', () => {
  it('leaves one CPU for the event loop', () => {
    const sizing = resolvePoolSize({});
    expect(sizing.threads).toBe(Math.max(1, sizing.available - 1));
    expect(sizing.source).toBe('available-parallelism');
  });

  it('never returns zero threads on a single-CPU container', () => {
    // `available - 1` is 0 there, and a pool of zero threads accepts work and never runs it.
    expect(resolvePoolSize({}).threads).toBeGreaterThanOrEqual(1);
  });

  it('honours an explicit override', () => {
    const sizing = resolvePoolSize({ WORKER_POOL_SIZE: '3' });
    expect(sizing.threads).toBe(3);
    expect(sizing.source).toBe('env');
  });

  it('treats an empty value as unset rather than as zero', () => {
    // Compose writes `WORKER_POOL_SIZE: ${WORKER_POOL_SIZE:-}` when the var is absent, so the
    // empty string reaches the process and must not be read as a number.
    expect(resolvePoolSize({ WORKER_POOL_SIZE: '' }).source).toBe('available-parallelism');
    expect(resolvePoolSize({ WORKER_POOL_SIZE: '   ' }).source).toBe('available-parallelism');
  });

  it('refuses a value that is not a positive integer, naming the fix', () => {
    for (const bad of ['0', '-2', '2.5', 'two']) {
      expect(() => resolvePoolSize({ WORKER_POOL_SIZE: bad }), bad).toThrow(/positive integer/);
    }
  });

  it('says where the number came from', () => {
    expect(describePoolSizing(resolvePoolSize({ WORKER_POOL_SIZE: '2' }))).toMatch(
      /WORKER_POOL_SIZE/,
    );
    expect(describePoolSizing(resolvePoolSize({}))).toMatch(/available to this container/);
  });
});
