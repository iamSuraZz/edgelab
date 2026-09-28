import { createDbClient } from '@edgelab/db';
import { describeGapBreakdown, describePerFill } from '@edgelab/validation';
import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';

import { validateRun } from '../validation/validate-run';

/**
 * Validate a stored run.
 *
 *   pnpm validate <runId>
 *
 * Step 1 of slice D: the validation engine without the queue or the API, the same way
 * `pnpm backtest` exercises the run pipeline. Useful on its own, and it is what proves the engine
 * works before an endpoint and a tab are built on top of it.
 */

const STATUS_MARK: Readonly<Record<string, string>> = {
  pass: '  ok ',
  warn: ' warn',
  fail: ' FAIL',
  'n/a': ' n/a ',
};

async function main(): Promise<void> {
  const runId = process.argv[2];
  if (runId === undefined || runId.startsWith('-')) {
    process.stderr.write('usage: pnpm validate <runId>\n');
    process.exitCode = 1;
    return;
  }

  loadDotEnvFile();
  const env = loadEnv(process.env);
  const db = createDbClient(env.DATABASE_URL, { max: 4 });

  try {
    let lastMessage = '';
    const report = await validateRun({
      db,
      runId,
      onProgress: (percent, message) => {
        // One line per distinct step rather than per percent, so the log stays readable.
        if (message === lastMessage) return;
        lastMessage = message;
        process.stdout.write(`[${String(Math.round(percent)).padStart(3)}%] ${message}\n`);
      },
    });

    process.stdout.write(`\n${report.headline}\n\n`);

    for (const r of report.results) {
      process.stdout.write(`${STATUS_MARK[r.status] ?? r.status} ${r.label}\n`);
      process.stdout.write(`       ${r.detail}\n`);
    }

    if (report.sameBar !== null && report.sameBar.assessed > 0) {
      const s = report.sameBar;
      process.stdout.write(
        `\n  same-bar execution estimate: ${s.totalAccountCost.toFixed(2)} over ` +
          `${String(s.assessed)} fills (positive = our fills were worse)\n`,
      );
      // Per fill, in pips: a total is unfalsifiable at a glance, a pip figure is not.
      process.stdout.write(`  ${describePerFill(s.perFill)}\n`);
      if (s.byGap.length > 0) {
        process.stdout.write(`  by gap — ${describeGapBreakdown(s.byGap)}\n`);
      }
      process.stdout.write(`  ${s.warning}\n`);
    }

    process.stdout.write(`\nverdict ${report.verdict} in ${String(report.elapsedMs)}ms\n`);

    // A failing verdict is a non-zero exit, so this is usable in a script.
    if (report.verdict === 'fail') process.exitCode = 1;
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`validate failed: ${String(error)}\n`);
  process.exitCode = 1;
});
