import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * Root test runner for the whole monorepo. Aliases resolve workspace packages to
 * their TypeScript sources so `pnpm test` never depends on a prior `pnpm build`.
 */
export default defineConfig({
  resolve: {
    alias: {
      // BEFORE the bare '@edgelab/shared' entry, and that order is load-bearing: the bare alias
      // shadows the package's './config' subpath, so anything importing `@edgelab/shared/config`
      // fails to resolve at all. Verified — appending it after does not work.
      '@edgelab/shared/config': fileURLToPath(
        new URL('./packages/shared/src/config/env.ts', import.meta.url),
      ),
      '@edgelab/shared': pkg('shared'),
      '@edgelab/data': pkg('data'),
      // Importing db's source does not open a connection — the pool is created by an explicit
      // call — so aliasing it is safe, and without it app tests silently read a stale dist.
      '@edgelab/db': pkg('db'),
      '@edgelab/engine': pkg('engine'),
      '@edgelab/metrics': pkg('metrics'),
      '@edgelab/validation': pkg('validation'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/**/*.{test,spec}.ts',
      'apps/**/*.{test,spec}.ts',
      // Repo-level checks that belong to no package — the compose-drift guard lives here.
      'test/**/*.{test,spec}.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
