import { describe, expect, it } from 'vitest';
import { EnvValidationError, hasProviderKey, loadEnv, toPublicEnv } from './env';

const base = {
  DATABASE_URL: 'postgresql://edgelab:edgelab@localhost:5432/edgelab',
  REDIS_URL: 'redis://localhost:6379',
};

describe('env config', () => {
  it('applies documented defaults', () => {
    const env = loadEnv({ ...base });
    expect(env.ACCOUNT_CURRENCY).toBe('USD');
    expect(env.API_PORT).toBe(3001);
    expect(env.WEB_PORT).toBe(5173);
    expect(env.DATA_CACHE_DIR).toBe('./.cache');
    expect(env.NODE_ENV).toBe('development');
  });

  it('coerces ports from strings', () => {
    const env = loadEnv({ ...base, API_PORT: '4000' });
    expect(env.API_PORT).toBe(4000);
  });

  it('uppercases the account currency', () => {
    expect(loadEnv({ ...base, ACCOUNT_CURRENCY: 'eur' }).ACCOUNT_CURRENCY).toBe('EUR');
  });

  it('rejects a missing database url, naming the key', () => {
    try {
      loadEnv({ REDIS_URL: base.REDIS_URL });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EnvValidationError);
      expect((err as EnvValidationError).keys).toContain('DATABASE_URL');
    }
  });

  it('rejects an out-of-range port', () => {
    expect(() => loadEnv({ ...base, API_PORT: '70000' })).toThrow(EnvValidationError);
  });

  it('never puts a secret value in the error message', () => {
    const secret = 'super-secret-key-value';
    try {
      loadEnv({ ...base, TWELVEDATA_API_KEY: secret, API_PORT: 'not-a-number' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('strips secrets from the public view', () => {
    const env = loadEnv({ ...base, TWELVEDATA_API_KEY: 'abc123' });
    const pub = toPublicEnv(env);
    expect(JSON.stringify(pub)).not.toContain('abc123');
    expect('TWELVEDATA_API_KEY' in pub).toBe(false);
    expect(pub.DATABASE_URL).toBe(base.DATABASE_URL);
  });

  it('reports key presence without revealing it', () => {
    expect(hasProviderKey(loadEnv({ ...base }))).toBe(false);
    expect(hasProviderKey(loadEnv({ ...base, TWELVEDATA_API_KEY: 'x' }))).toBe(true);
  });
});
