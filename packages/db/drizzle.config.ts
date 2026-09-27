import { defineConfig } from 'drizzle-kit';
import { loadLocalEnv, requireDatabaseUrl } from './src/env-file';

loadLocalEnv();

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: { url: requireDatabaseUrl() },
  strict: true,
  verbose: true,
});
