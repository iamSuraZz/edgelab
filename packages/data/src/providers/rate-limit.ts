/**
 * Cross-process rate limiting for keyed providers.
 *
 * Limits are per API key, not per process: the API and the worker both make calls, and
 * the worker may run several ingest jobs at once. So the counters live in Redis and are
 * incremented inside a Lua script, which is the only way to make "check then increment"
 * atomic across processes.
 */

/** The subset of ioredis we need, so this package does not depend on ioredis. */
export interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
}

export interface BudgetLimits {
  /** Requests permitted per wall-clock minute. */
  readonly perMinute: number;
  /** Requests permitted per UTC day. */
  readonly perDay: number;
}

export interface BudgetStatus {
  readonly perMinute: number;
  readonly perDay: number;
  readonly minuteUsed: number;
  readonly dayUsed: number;
  readonly minuteRemaining: number;
  readonly dayRemaining: number;
  /** When the daily budget resets, as UTC epoch ms. */
  readonly dayResetsAt: number;
}

export type AcquireOutcome =
  | { readonly ok: true; readonly minuteUsed: number; readonly dayUsed: number }
  | { readonly ok: false; readonly blockedBy: 'minute'; readonly retryAfterMs: number }
  | { readonly ok: false; readonly blockedBy: 'day'; readonly retryAfterMs: number };

/**
 * Atomically: refuse if either budget is exhausted, otherwise consume one unit of both.
 *
 * Checking before incrementing (rather than increment-then-rollback) means a refused call
 * never consumes budget, which matters when the daily allowance is only 800.
 */
const ACQUIRE_SCRIPT = `
local minuteKey = KEYS[1]
local dayKey = KEYS[2]
local minuteLimit = tonumber(ARGV[1])
local dayLimit = tonumber(ARGV[2])
local minuteTtl = tonumber(ARGV[3])
local dayTtl = tonumber(ARGV[4])

local dayUsed = tonumber(redis.call('GET', dayKey) or '0')
if dayUsed >= dayLimit then
  return {0, 'day', dayUsed, 0}
end

local minuteUsed = tonumber(redis.call('GET', minuteKey) or '0')
if minuteUsed >= minuteLimit then
  return {0, 'minute', dayUsed, minuteUsed}
end

minuteUsed = redis.call('INCR', minuteKey)
redis.call('EXPIRE', minuteKey, minuteTtl)
dayUsed = redis.call('INCR', dayKey)
redis.call('EXPIRE', dayKey, dayTtl)

return {1, 'ok', dayUsed, minuteUsed}
`;

export class BudgetExhaustedError extends Error {
  public readonly blockedBy: 'minute' | 'day';
  public readonly retryAfterMs: number;

  constructor(provider: string, blockedBy: 'minute' | 'day', retryAfterMs: number) {
    super(
      `[${provider}] ${blockedBy} budget exhausted; next attempt in ` +
        `${String(Math.ceil(retryAfterMs / 1000))}s`,
    );
    this.name = 'BudgetExhaustedError';
    this.blockedBy = blockedBy;
    this.retryAfterMs = retryAfterMs;
  }
}

export class RedisBudget {
  constructor(
    private readonly redis: RedisLike,
    private readonly provider: string,
    private readonly limits: BudgetLimits,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private minuteKey(at: number): string {
    return `edgelab:budget:${this.provider}:minute:${Math.floor(at / 60_000)}`;
  }

  private dayKey(at: number): string {
    return `edgelab:budget:${this.provider}:day:${new Date(at).toISOString().slice(0, 10)}`;
  }

  /** Try to consume one request. Never blocks. */
  async tryAcquire(): Promise<AcquireOutcome> {
    const at = this.now();
    const secondsToNextDay = Math.ceil((nextUtcMidnight(at) - at) / 1000);

    const raw = await this.redis.eval(
      ACQUIRE_SCRIPT,
      2,
      this.minuteKey(at),
      this.dayKey(at),
      this.limits.perMinute,
      this.limits.perDay,
      // A minute bucket only needs to outlive its own minute.
      120,
      secondsToNextDay,
    );

    const parsed = parseAcquire(raw);

    if (parsed.allowed) {
      return { ok: true, minuteUsed: parsed.minuteUsed, dayUsed: parsed.dayUsed };
    }

    if (parsed.blockedBy === 'day') {
      return { ok: false, blockedBy: 'day', retryAfterMs: nextUtcMidnight(at) - at };
    }

    // The per-minute quota resets on the wall-clock boundary, so exponential backoff is
    // the wrong shape — sleep to the next :00 instead.
    return { ok: false, blockedBy: 'minute', retryAfterMs: nextMinuteBoundary(at) - at };
  }

  /**
   * Consume one request, waiting for the per-minute window if necessary.
   * A spent DAILY budget throws instead of sleeping for hours — the ingest job records
   * its cursor and resumes tomorrow.
   */
  async acquire(sleep: (ms: number) => Promise<void>): Promise<void> {
    for (;;) {
      const outcome = await this.tryAcquire();
      if (outcome.ok) return;
      if (outcome.blockedBy === 'day') {
        throw new BudgetExhaustedError(this.provider, 'day', outcome.retryAfterMs);
      }
      // +50ms so we land safely past the boundary rather than on it.
      await sleep(outcome.retryAfterMs + 50);
    }
  }

  /** For the provider card in the UI. Read-only, consumes nothing. */
  async status(): Promise<BudgetStatus> {
    const at = this.now();
    const [minuteRaw, dayRaw] = await Promise.all([
      this.redis.get(this.minuteKey(at)),
      this.redis.get(this.dayKey(at)),
    ]);

    const minuteUsed = Number(minuteRaw ?? 0);
    const dayUsed = Number(dayRaw ?? 0);

    return {
      perMinute: this.limits.perMinute,
      perDay: this.limits.perDay,
      minuteUsed,
      dayUsed,
      minuteRemaining: Math.max(0, this.limits.perMinute - minuteUsed),
      dayRemaining: Math.max(0, this.limits.perDay - dayUsed),
      dayResetsAt: nextUtcMidnight(at),
    };
  }
}

interface ParsedAcquire {
  allowed: boolean;
  blockedBy: 'minute' | 'day' | null;
  dayUsed: number;
  minuteUsed: number;
}

/** Redis returns a Lua table as a JS array of numbers and Buffers/strings. */
function parseAcquire(raw: unknown): ParsedAcquire {
  if (!Array.isArray(raw)) {
    return { allowed: false, blockedBy: 'minute', dayUsed: 0, minuteUsed: 0 };
  }
  const allowed = Number(raw[0]) === 1;
  const reason = String(raw[1]);
  return {
    allowed,
    blockedBy: allowed ? null : reason === 'day' ? 'day' : 'minute',
    dayUsed: Number(raw[2] ?? 0),
    minuteUsed: Number(raw[3] ?? 0),
  };
}

export function nextMinuteBoundary(at: number): number {
  return (Math.floor(at / 60_000) + 1) * 60_000;
}

export function nextUtcMidnight(at: number): number {
  const d = new Date(at);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}
