import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

export default defineConfig(({ mode }) => {
  /**
   * Read the repo-root .env for dev-server wiring only. Nothing from here is passed to
   * `define`, so no secret can reach the browser bundle — Vite inlines only VITE_*
   * variables, and EdgeLab deliberately defines none.
   */
  const env = loadEnv(mode, repoRoot, '');
  const webPort = Number(env['WEB_PORT'] ?? 5173);
  const apiPort = Number(env['API_PORT'] ?? 3001);
  const apiTarget = `http://localhost:${String(apiPort)}`;

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(here, 'src'),

        /**
         * Workspace packages resolve to their TypeScript SOURCE, not to `dist`.
         *
         * Not a convenience — a correctness fix. These packages emit CommonJS (none sets
         * `"type": "module"`), and Vite discovers a CJS module's named exports statically with
         * cjs-module-lexer. That lexer cannot see through `export * from './costs'` re-export
         * chains, so `import { DEFAULT_COSTS } from '@edgelab/shared'` failed at runtime with
         * "does not provide an export named 'DEFAULT_COSTS'" and the app never mounted — a blank
         * white page, with the only clue in the browser console.
         *
         * Pointing at source sidesteps CJS interop entirely and removes the need to rebuild a
         * package before the dev server picks up a change. `vitest.config.mts` already does this,
         * which is why the unit tests never saw the problem.
         *
         * Deliberately NOT aliased: `@edgelab/shared/config`. It reads `process.env` and is kept
         * behind a separate subpath precisely so a browser bundle cannot reach it.
         */
        '@edgelab/shared': path.resolve(repoRoot, 'packages/shared/src/index.ts'),
        '@edgelab/metrics': path.resolve(repoRoot, 'packages/metrics/src/index.ts'),
      },
    },
    server: {
      port: webPort,
      strictPort: true,
      // Proxy so the browser only ever talks to one origin in dev.
      proxy: {
        '/api': { target: apiTarget, changeOrigin: true },
        '/health': { target: apiTarget, changeOrigin: true },
      },
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
