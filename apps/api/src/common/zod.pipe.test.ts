import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CreateBacktestSchema, CandlesQuerySchema, IngestRequestSchema } from '@edgelab/shared';

import { ApiException } from './api-error';
import { ZodPipe } from './zod.pipe';

/**
 * The validation boundary. Every endpoint's only check is its shared schema run through this
 * pipe, so a gap here is a gap everywhere.
 */

const meta = { type: 'body' as const, metatype: undefined, data: undefined };

describe('ZodPipe', () => {
  it('returns the PARSED value, so defaults and coercions reach the handler', () => {
    const pipe = new ZodPipe(z.object({ n: z.coerce.number(), flag: z.boolean().default(true) }));
    expect(pipe.transform({ n: '42' }, meta)).toEqual({ n: 42, flag: true });
  });

  it('throws an ApiException, not a Nest BadRequestException', () => {
    // The envelope has to stay `{ code, message, details }`; Nest's own exception produces a
    // different shape that a client would then have to handle separately.
    const pipe = new ZodPipe(z.object({ n: z.number() }));
    expect(() => pipe.transform({ n: 'no' }, meta)).toThrow(ApiException);
  });

  it('reports EVERY issue, not just the first', () => {
    const pipe = new ZodPipe(z.object({ a: z.number(), b: z.number(), c: z.number() }));
    const error = capture(() => pipe.transform({ a: 'x', b: 'y', c: 'z' }, meta));

    const details = error.apiError.details as { issues: { path: string }[] };
    expect(details.issues).toHaveLength(3);
    expect(details.issues.map((i) => i.path).sort()).toEqual(['a', 'b', 'c']);
  });

  it('names the failing field in the message', () => {
    const pipe = new ZodPipe(z.object({ symbol: z.string().min(3) }));
    const error = capture(() => pipe.transform({ symbol: 'X' }, meta));
    expect(error.apiError.code).toBe('validation-failed');
    expect(error.apiError.message).toContain('symbol');
  });

  it('says which part of the request was invalid', () => {
    const pipe = new ZodPipe(z.object({ n: z.number() }));
    expect(capture(() => pipe.transform({}, meta)).apiError.message).toContain('body');
    expect(
      capture(() => pipe.transform({}, { ...meta, type: 'query' })).apiError.message,
    ).toContain('query');
  });
});

describe('the real endpoint schemas', () => {
  it('rejects a backtest with neither source nor strategyVersionId', () => {
    const pipe = new ZodPipe(CreateBacktestSchema);
    const error = capture(() =>
      pipe.transform({ symbol: 'EURUSD', timeframe: 'H1', from: 0, to: 1_000 }, meta),
    );
    expect(error.apiError.message).toContain('source');
  });

  it('rejects a backtest with BOTH source and strategyVersionId', () => {
    const pipe = new ZodPipe(CreateBacktestSchema);
    const error = capture(() =>
      pipe.transform(
        {
          symbol: 'EURUSD',
          timeframe: 'H1',
          from: 0,
          to: 1_000,
          source: 'x',
          strategyVersionId: '11111111-1111-1111-1111-111111111111',
        },
        meta,
      ),
    );
    expect(error.apiError.message).toMatch(/not both/i);
  });

  it('rejects an inverted range and points at `from`', () => {
    const pipe = new ZodPipe(CreateBacktestSchema);
    const error = capture(() =>
      pipe.transform({ symbol: 'EURUSD', timeframe: 'H1', from: 1_000, to: 0, source: 'x' }, meta),
    );
    const details = error.apiError.details as { issues: { path: string }[] };
    expect(details.issues.some((i) => i.path === 'from')).toBe(true);
  });

  it('fills in the run defaults the CLI also uses', () => {
    const pipe = new ZodPipe(CreateBacktestSchema);
    const parsed = pipe.transform(
      { symbol: 'EURUSD', timeframe: 'H1', from: 0, to: 1_000, source: 'x' },
      meta,
    );
    expect(parsed.initialCapital).toBe(10_000);
    expect(parsed.accountCurrency).toBe('USD');
    expect(parsed.warmupBars).toBe(500);
    expect(parsed.leverage).toBe(100);
    // Sizing defaults to the SCRIPT's own, so an API caller is not silently resized.
    expect(parsed.lots).toBe(0);
    expect(parsed.costs.spread.source).toBe('data');
  });

  it('coerces query strings to numbers, since a URL has no types', () => {
    const pipe = new ZodPipe(CandlesQuerySchema);
    const parsed = pipe.transform(
      { symbol: 'EURUSD', tf: 'H1', from: '1700000000000', to: '1700003600000' },
      { ...meta, type: 'query' },
    );
    expect(parsed.from).toBe(1_700_000_000_000);
    expect(typeof parsed.to).toBe('number');
  });

  it('rejects an unknown timeframe by name', () => {
    const pipe = new ZodPipe(CandlesQuerySchema);
    const error = capture(() =>
      pipe.transform(
        { symbol: 'EURUSD', tf: 'M7', from: '0', to: '1' },
        { ...meta, type: 'query' },
      ),
    );
    expect(error.apiError.message).toContain('tf');
  });

  it('rejects an unknown provider on an ingest request', () => {
    const pipe = new ZodPipe(IngestRequestSchema);
    const error = capture(() =>
      pipe.transform({ symbol: 'EURUSD', provider: 'nonesuch', from: 0, to: 1 }, meta),
    );
    expect(error.apiError.message).toContain('provider');
  });
});

describe('ApiException', () => {
  it('gives each failure kind the status a client should branch on', () => {
    expect(ApiException.validation('x').getStatus()).toBe(400);
    expect(ApiException.notFound('x').getStatus()).toBe(404);
    // A missing range is 404, not 400: the request was fine, the data simply is not here.
    expect(ApiException.noData('x').getStatus()).toBe(404);
    expect(ApiException.conflict('x').getStatus()).toBe(409);
    expect(ApiException.notCancellable('x').getStatus()).toBe(409);
    expect(ApiException.compileFailed('x').getStatus()).toBe(422);
    expect(ApiException.currencyMismatch('x').getStatus()).toBe(422);
    expect(ApiException.providerUnavailable('x').getStatus()).toBe(503);
    expect(ApiException.internal('x').getStatus()).toBe(500);
  });

  it('carries the envelope as the response body', () => {
    const error = ApiException.noData('No EURUSD data after 2024-02-01.', { availableTo: 123 });
    expect(error.apiError).toEqual({
      code: 'no-data',
      message: 'No EURUSD data after 2024-02-01.',
      details: { availableTo: 123 },
    });
    expect(error.getResponse()).toBe(error.apiError);
  });

  it('omits `details` rather than sending an explicit undefined', () => {
    expect(Object.keys(ApiException.validation('x').apiError)).toEqual(['code', 'message']);
  });
});

function capture(fn: () => unknown): ApiException {
  try {
    fn();
  } catch (error: unknown) {
    if (error instanceof ApiException) return error;
    throw error;
  }
  throw new Error('expected an ApiException');
}
