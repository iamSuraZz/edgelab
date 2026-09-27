import process from 'node:process';

/**
 * Loads the repo-root .env for CLI tooling only (drizzle-kit, the migrate script).
 * Long-running apps must use the zod-validated loader in @edgelab/shared/config
 * instead of reaching for process.env directly.
 *
 * This intentionally duplicates `loadDotEnvFile` from @edgelab/shared/config rather
 * than importing it: drizzle-kit and the migrate script run outside turbo, so relying
 * on shared's compiled dist/ would make them fail on a clean checkout before a build.
 */
export function loadLocalEnv(): void {
  // drizzle-kit may run from the package dir or the repo root.
  for (const candidate of ['.env', '../../.env']) {
    try {
      process.loadEnvFile(candidate);
      return;
    } catch {
      // Missing at this location — try the next, and fall through to real env vars.
    }
  }
}

export function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env at the repo root, or export it.',
    );
  }
  return url;
}
