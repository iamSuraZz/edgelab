import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * End-to-end runner. SEPARATE from `pnpm test` because these tests need the docker stack —
 * TimescaleDB with stored EURUSD bars, and Redis — so folding them into the unit suite would
 * turn a fresh clone's 491 passing tests red for reasons unrelated to the code.
 *
 * `singleFork` and no isolation: every file boots an API and real BullMQ workers against the
 * same Redis, and two suites consuming the same queues would steal each other's jobs.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@edgelab/shared/config': fileURLToPath(
        new URL('./packages/shared/src/config/env.ts', import.meta.url),
      ),
      '@edgelab/shared': pkg('shared'),
      '@edgelab/data': pkg('data'),
      '@edgelab/engine': pkg('engine'),
      '@edgelab/metrics': pkg('metrics'),
      '@edgelab/validation': pkg('validation'),
      '@edgelab/db': pkg('db'),
      '@edgelab/worker/boot': fileURLToPath(new URL('./apps/worker/src/boot.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['apps/**/test/e2e/**/*.e2e.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // A cold piscina thread has to load pinets and transpile Pine before the first bar runs.
    testTimeout: 240_000,
    hookTimeout: 120_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    fileParallelism: false,
    // Decorator metadata for Nest's DI. The apps are CommonJS, so esbuild needs telling.
    esbuild: { target: 'node22' },
  },
});
