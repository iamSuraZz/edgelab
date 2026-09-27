import { SEED_SYMBOLS } from '@edgelab/shared';
import type { DbClient } from './client';

/**
 * Insert the seed symbol registry.
 *
 * ON CONFLICT DO NOTHING, never DO UPDATE: symbols are editable from the Settings UI, and
 * re-running a migration must not silently revert a user's contract-size or spread edits.
 * New seed rows added in a later release still appear.
 */
export async function seedSymbols(
  client: DbClient,
): Promise<{ inserted: number; existing: number }> {
  let inserted = 0;

  for (const spec of SEED_SYMBOLS) {
    const result = await client.pool.query(
      `INSERT INTO symbols (
         symbol, asset_class, base_ccy, quote_ccy, digits, mintick, pip_size,
         contract_size, point_value, default_spread_points, provider_symbols,
         session_type, enabled
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (symbol) DO NOTHING`,
      [
        spec.symbol,
        spec.assetClass,
        spec.baseCcy,
        spec.quoteCcy,
        spec.digits,
        spec.mintick,
        spec.pipSize,
        spec.contractSize,
        spec.pointValue,
        spec.defaultSpreadPoints,
        JSON.stringify(spec.providerSymbols),
        spec.sessionType,
        spec.enabled,
      ],
    );
    inserted += result.rowCount ?? 0;
  }

  return { inserted, existing: SEED_SYMBOLS.length - inserted };
}
