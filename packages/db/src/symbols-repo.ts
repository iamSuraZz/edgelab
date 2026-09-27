import {
  normalizeSymbolCode,
  type SymbolPatch,
  type SymbolSpec,
  SymbolSpecSchema,
} from '@edgelab/shared';
import type { DbClient } from './client';

/**
 * Symbol registry access. The database is the runtime source of truth — SEED_SYMBOLS only
 * provides the initial rows, because everything here is editable from Settings.
 */

export interface StoredSymbol extends SymbolSpec {
  readonly id: string;
  readonly dataVersion: number;
}

interface SymbolRow {
  id: string;
  symbol: string;
  asset_class: string;
  base_ccy: string;
  quote_ccy: string;
  digits: number;
  mintick: number;
  pip_size: number;
  contract_size: number;
  point_value: number;
  default_spread_points: number;
  provider_symbols: unknown;
  session_type: string;
  enabled: boolean;
  data_version: number;
}

const SELECT_COLUMNS = `
  id, symbol, asset_class, base_ccy, quote_ccy, digits, mintick, pip_size,
  contract_size, point_value, default_spread_points, provider_symbols,
  session_type, enabled, data_version
`;

function toStoredSymbol(row: SymbolRow): StoredSymbol {
  // Parse through the shared schema so a hand-edited row cannot inject a bad assetClass or
  // sessionType into the rest of the system.
  const spec = SymbolSpecSchema.parse({
    symbol: row.symbol,
    assetClass: row.asset_class,
    baseCcy: row.base_ccy,
    quoteCcy: row.quote_ccy,
    digits: row.digits,
    mintick: row.mintick,
    pipSize: row.pip_size,
    contractSize: row.contract_size,
    pointValue: row.point_value,
    defaultSpreadPoints: row.default_spread_points,
    providerSymbols: row.provider_symbols ?? {},
    sessionType: row.session_type,
    enabled: row.enabled,
  });

  return { ...spec, id: row.id, dataVersion: row.data_version };
}

export async function listSymbols(client: DbClient): Promise<StoredSymbol[]> {
  const result = await client.pool.query<SymbolRow>(
    `SELECT ${SELECT_COLUMNS} FROM symbols ORDER BY asset_class, symbol`,
  );
  return result.rows.map(toStoredSymbol);
}

export async function findSymbolById(client: DbClient, id: string): Promise<StoredSymbol | null> {
  const result = await client.pool.query<SymbolRow>(
    `SELECT ${SELECT_COLUMNS} FROM symbols WHERE id = $1`,
    [id],
  );
  const row = result.rows[0];
  return row === undefined ? null : toStoredSymbol(row);
}

export async function findSymbolByCode(
  client: DbClient,
  symbol: string,
): Promise<StoredSymbol | null> {
  const result = await client.pool.query<SymbolRow>(
    `SELECT ${SELECT_COLUMNS} FROM symbols WHERE symbol = $1`,
    // Base upper-cased, feed tag preserved — see normalizeSymbolCode.
    [normalizeSymbolCode(symbol)],
  );
  const row = result.rows[0];
  return row === undefined ? null : toStoredSymbol(row);
}

/** Column mapping for PATCH. Keys absent from the patch are left untouched. */
const PATCH_COLUMNS: Record<keyof SymbolPatch, string> = {
  digits: 'digits',
  mintick: 'mintick',
  pipSize: 'pip_size',
  contractSize: 'contract_size',
  pointValue: 'point_value',
  defaultSpreadPoints: 'default_spread_points',
  providerSymbols: 'provider_symbols',
  sessionType: 'session_type',
  enabled: 'enabled',
};

export async function updateSymbol(
  client: DbClient,
  id: string,
  patch: SymbolPatch,
): Promise<StoredSymbol | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  for (const [key, column] of Object.entries(PATCH_COLUMNS) as [keyof SymbolPatch, string][]) {
    const value = patch[key];
    if (value === undefined) continue;
    values.push(key === 'providerSymbols' ? JSON.stringify(value) : value);
    assignments.push(`${column} = $${String(values.length + 1)}`);
  }

  if (assignments.length === 0) return findSymbolById(client, id);

  const result = await client.pool.query<SymbolRow>(
    `UPDATE symbols
     SET ${assignments.join(', ')}, updated_at = now()
     WHERE id = $1
     RETURNING ${SELECT_COLUMNS}`,
    [id, ...values],
  );

  const row = result.rows[0];
  return row === undefined ? null : toStoredSymbol(row);
}
