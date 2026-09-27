import { sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolClient } from 'pg';
import { schema } from './schema';

export type Database = NodePgDatabase<typeof schema>;

export interface DbClient {
  readonly db: Database;
  /** The raw pool, for COPY streams and Timescale-specific DDL. */
  readonly pool: Pool;
  /** Cheap liveness probe used by the API health endpoint. */
  ping(): Promise<void>;
  /**
   * Run `fn` on a single dedicated connection. Required for COPY and for TEMP tables,
   * which are session-scoped and would otherwise land on an arbitrary pooled connection.
   */
  withConnection<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface DbClientOptions {
  /** Pool size. Keep small for the API, larger for the worker. */
  max?: number;
  connectTimeoutMs?: number;
  /** Kill a query that overruns; ingest COPY batches need a generous ceiling. */
  statementTimeoutMs?: number;
}

/**
 * Build a database client.
 *
 * node-postgres rather than postgres.js specifically because pg-copy-streams — which the
 * bulk loader needs — is built for this driver.
 */
export function createDbClient(databaseUrl: string, options: DbClientOptions = {}): DbClient {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 10_000,
    statement_timeout: options.statementTimeoutMs ?? 120_000,
  });

  // An idle-client error would otherwise become an unhandled 'error' event and kill the
  // process on a transient network blip.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  const db = drizzle(pool, { schema });

  return {
    db,
    pool,
    async ping(): Promise<void> {
      await db.execute(sql`select 1`);
    },
    async withConnection<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
