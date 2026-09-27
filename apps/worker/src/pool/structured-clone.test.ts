import { describe, expect, it } from 'vitest';

/**
 * What actually survives an Error crossing a worker-thread boundary.
 *
 * This repo believed classification could travel in `Error.name`. It cannot. Structured clone
 * NORMALISES an Error's name to one of the seven built-ins, so a custom `NoDataError` arrives
 * as plain `"Error"` — which is how "no data for that range" reached the user as "your script
 * has a bug" until the e2e suite was first run against a real stack.
 *
 * These assertions pin the platform behaviour the design now depends on. If a future Node
 * changes it, this fails here rather than silently mis-labelling every worker failure.
 */

describe('structuredClone of an Error', () => {
  it('DROPS a custom name — the reason classification cannot live there', () => {
    const error = new Error('no EURUSD data in that range');
    error.name = 'NoDataError';

    const cloned = structuredClone(error);

    expect(cloned.name).toBe('Error');
    expect(cloned.name).not.toBe('NoDataError');
  });

  it('keeps the message', () => {
    const cloned = structuredClone(new Error('no EURUSD data in that range'));
    expect(cloned.message).toBe('no EURUSD data in that range');
  });

  it('DROPS own properties', () => {
    const error = Object.assign(new Error('x'), { code: 'no-data', detail: 42 });

    const cloned = structuredClone(error) as Error & { code?: string; detail?: number };

    expect(cloned.code).toBeUndefined();
    expect(cloned.detail).toBeUndefined();
  });

  it('KEEPS cause, including an object — which is where the code travels', () => {
    const error = new Error('no EURUSD data', { cause: { edgelabCode: 'no-data' } });

    const cloned = structuredClone(error);

    expect(cloned.cause).toEqual({ edgelabCode: 'no-data' });
  });

  it('preserves a built-in subclass name, which is why the myth survived so long', () => {
    // TypeError round-trips intact. Testing only with built-ins would suggest name is safe.
    expect(structuredClone(new TypeError('bad')).name).toBe('TypeError');
  });

  it('keeps cause through a wrapping layer, as the pool adds one', () => {
    const original = new Error('no EURUSD data', { cause: { edgelabCode: 'no-data' } });
    const wrapped = new Error('Task failed', { cause: original });

    const cloned = structuredClone(wrapped);

    expect((cloned.cause as Error).cause).toEqual({ edgelabCode: 'no-data' });
  });
});
