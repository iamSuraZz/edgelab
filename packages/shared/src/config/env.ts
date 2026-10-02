import process from 'node:process';
import { z } from 'zod';

/**
 * The ONLY place environment variables are read and validated. Nothing outside this
 * module touches process.env.
 *
 * Secrets rule: values under SECRET_KEYS must never be logged, returned from the API,
 * or serialised to the browser. Validation errors below report key names only — never
 * the offending value — so a malformed key cannot leak into logs.
 */

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  TWELVEDATA_API_KEY: z.string().default(''),

  ACCOUNT_CURRENCY: z
    .string()
    .length(3)
    .transform((s) => s.toUpperCase())
    .default('USD'),

  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  WEB_PORT: z.coerce.number().int().min(1).max(65535).default(5173),
  DATA_CACHE_DIR: z.string().min(1).default('./.cache'),

  /**
   * Threads for the worker's piscina pools. Unset means "the CPUs available to this container".
   *
   * `preprocess` because compose writes an EMPTY string when the variable is absent
   * (`${WORKER_POOL_SIZE:-}`), and `z.coerce.number()` turns '' into 0, which then fails `min(1)`
   * and takes the whole worker down over a variable nobody set.
   */
  WORKER_POOL_SIZE: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.coerce.number().int().min(1).optional(),
  ),

  /**
   * Nightly backfill targets, `SYMBOL:provider:fromISO:toISO` separated by commas.
   *
   * Empty by default, deliberately: a server that began hitting a provider merely because it was
   * deployed would be worse than one that needs a variable set.
   */
  BACKFILL_TARGETS: z.string().default(''),
  /** Cron for those targets, UTC. Off the hour, because everything else in the world runs at :00. */
  BACKFILL_CRON: z.string().min(1).default('17 3 * * *'),
});

export type Env = z.infer<typeof envSchema>;

/** Keys whose values must never leave the server process. */
export const SECRET_KEYS = ['TWELVEDATA_API_KEY'] as const;
export type SecretKey = (typeof SECRET_KEYS)[number];

/** Env minus every secret — safe to log or expose. */
export type PublicEnv = Omit<Env, SecretKey>;

export class EnvValidationError extends Error {
  public readonly keys: readonly string[];

  constructor(keys: readonly string[]) {
    // Key names only. Never interpolate received values into this message.
    super(
      `Invalid environment configuration. Check these keys in your .env: ${keys.join(', ')}. ` +
        `See .env.example for the expected shape.`,
    );
    this.name = 'EnvValidationError';
    this.keys = keys;
  }
}

/**
 * Validate a raw environment record.
 *
 * The source is an explicit parameter rather than a `process.env` default: it keeps
 * this package free of Node globals and lets tests pass a fake instead of mutating
 * real process state. Callers in apps/api and apps/worker pass `process.env`.
 */
export function loadEnv(source: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const keys = [
      ...new Set(parsed.error.issues.map((i) => i.path.map(String).join('.') || '(root)')),
    ];
    throw new EnvValidationError(keys);
  }
  return parsed.data;
}

/**
 * Load a `.env` file into `process.env`, returning the path used or null if none was
 * found. Server entrypoints call this once at startup, before `loadEnv(process.env)`.
 *
 * Deliberately separate from `loadEnv`, which stays pure and takes its source
 * explicitly — this is the one side-effecting function in the module. Candidates are
 * tried in order because apps run with their own directory as cwd under turbo, while
 * scripts may run from the repo root.
 */
export function loadDotEnvFile(
  candidates: readonly string[] = ['.env', '../../.env'],
): string | null {
  for (const candidate of candidates) {
    try {
      process.loadEnvFile(candidate);
      return candidate;
    } catch {
      // Not present at this location — try the next.
    }
  }
  return null;
}

/** Strip secrets so the result can be logged or sent to a client. */
export function toPublicEnv(env: Env): PublicEnv {
  const clone: Record<string, unknown> = { ...env };
  for (const key of SECRET_KEYS) {
    delete clone[key];
  }
  return clone as PublicEnv;
}

/** True when the provider key is present, without revealing it. */
export function hasProviderKey(env: Env): boolean {
  return env.TWELVEDATA_API_KEY.length > 0;
}
