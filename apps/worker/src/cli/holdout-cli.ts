import {
  createDbClient,
  findSymbolByCode,
  getHoldout,
  holdoutHistory,
  retireHoldout,
  sealHoldout,
} from '@edgelab/db';
import { describeHoldout, sealLabel } from '@edgelab/shared';
import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';

/**
 * Manage a symbol's sealed holdout.
 *
 *   pnpm holdout EURUSD --status
 *   pnpm holdout EURUSD --seal 0.2
 *   pnpm holdout EURUSD --retire
 *
 * There is deliberately no `--unseal` that hands over the data: reading past the seal happens through
 * `readM1Unsealed` at the point of use, which counts the view. A command that dumped the holdout
 * would make looking feel like administration rather than a decision.
 */

async function main(): Promise<void> {
  loadDotEnvFile();
  const env = loadEnv(process.env);

  const [code, ...rest] = process.argv.slice(2);
  if (code === undefined || code.startsWith('--')) {
    throw new Error('Usage: pnpm holdout <SYMBOL> [--status | --seal <fraction> | --retire]');
  }

  const db = createDbClient(env.DATABASE_URL);

  try {
    const symbol = await findSymbolByCode(db, code);
    if (symbol === null) throw new Error(`Unknown symbol ${code}.`);

    const sealAt = rest.indexOf('--seal');
    const retire = rest.includes('--retire');

    if (sealAt >= 0) {
      const fraction = Number(rest[sealAt + 1]);
      const range = await storedRange(db, symbol.id);
      if (range === null) throw new Error(`${code} has no stored bars to seal.`);

      const h = await sealHoldout({
        client: db,
        symbolId: symbol.id,
        fraction,
        earliestMs: range.earliestMs,
        latestMs: range.latestMs,
      });
      process.stdout.write(`sealed ${code}: ${sealLabel(h)}\n`);
    } else if (retire) {
      const h = await retireHoldout(db, symbol.id);
      if (h === null) {
        process.stdout.write(`${code} has no active holdout to retire.\n`);
      } else {
        process.stdout.write(
          `retired ${sealLabel(h)} after ${String(h.viewCount)} view(s). It stays in the ` +
            `history — a new seal cannot pretend this ground is untouched.\n`,
        );
      }
    }

    await printStatus(db, symbol.id, code);
  } finally {
    await db.close();
  }
}

async function printStatus(
  db: ReturnType<typeof createDbClient>,
  symbolId: string,
  code: string,
): Promise<void> {
  const active = await getHoldout(db, symbolId);
  const history = await holdoutHistory(db, symbolId);

  process.stdout.write(`\n${code}: ${describeHoldout(active, history)}\n`);

  if (history.length === 0) return;

  process.stdout.write(`\n  seal history (newest first):\n`);
  for (const h of history) {
    const state = h.retiredAtMs === null ? 'ACTIVE ' : 'retired';
    const viewed =
      h.lastViewedAtMs === null
        ? 'never viewed'
        : `${String(h.viewCount)} view(s), last ${new Date(h.lastViewedAtMs).toISOString().slice(0, 10)}`;
    process.stdout.write(
      `    ${state}  ${h.id.slice(0, 8)}  from ${new Date(h.sealedFromMs).toISOString().slice(0, 10)}  ${viewed}\n`,
    );
  }
}

async function storedRange(
  db: ReturnType<typeof createDbClient>,
  symbolId: string,
): Promise<{ earliestMs: number; latestMs: number } | null> {
  const r = await db.pool.query<{ lo: Date | null; hi: Date | null }>(
    `SELECT min(ts) AS lo, max(ts) AS hi FROM candles_m1 WHERE symbol_id = $1`,
    [symbolId],
  );
  const row = r.rows[0];
  if (row?.lo == null || row.hi == null) return null;
  return { earliestMs: row.lo.getTime(), latestMs: row.hi.getTime() };
}

main().catch((error: unknown) => {
  process.stderr.write(`holdout failed: ${String(error)}\n`);
  process.exitCode = 1;
});
