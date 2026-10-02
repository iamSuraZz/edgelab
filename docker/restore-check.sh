#!/bin/sh
# Restore the newest backup into a SCRATCH database and verify it, then leave it in place so the
# smoke suite can be pointed at it.
#
#   docker compose -f docker-compose.prod.yml exec backup /usr/local/bin/restore-check.sh
#   docker compose -f docker-compose.prod.yml exec backup /usr/local/bin/restore-check.sh /backups/edgelab-20261002T202125Z.sql.gz
#
# A dump you have never restored is a file, not a backup. What this proves that `ls /backups` does
# not: the gzip is intact, the schema loads, the hypertable comes back as a HYPERTABLE rather than a
# plain table, the compression policy survives, and the row counts match the source.
#
# TIMESCALEDB NEEDS pre/post RESTORE. Its catalog tables (`hypertable`, `chunk`, `continuous_agg`)
# carry circular foreign keys — which is what pg_dump warns about on every dump — and its background
# workers will fight a restore in progress. `timescaledb_pre_restore()` sets `timescaledb.restoring`
# and stops those workers; `timescaledb_post_restore()` puts both back. Restoring without them
# appears to work and leaves chunks the planner will not use.
set -eu

SCRATCH="${SCRATCH_DB:-edgelab_restore_check}"
SOURCE_DB="${PGDATABASE:-edgelab}"

log() { echo "[restore-check $(date -u +%H:%M:%SZ)] $*"; }
fail() { log "FAIL: $*"; exit 1; }

DUMP="${1:-}"
if [ -z "$DUMP" ]; then
    DUMP=$(ls -1t /backups/edgelab-*.sql.gz 2>/dev/null | head -1 || true)
fi
[ -n "$DUMP" ] || fail "no dump found in /backups. Has the backup service run yet?"
[ -f "$DUMP" ] || fail "no such dump: $DUMP"

log "dump: $DUMP ($(du -h "$DUMP" | cut -f1))"

# Integrity of the archive itself, before touching any database. A truncated gzip is the most likely
# way a backup is useless, and it is free to check.
gzip -t "$DUMP" || fail "gzip reports the archive is corrupt"
log "gzip: intact"

# Counts from the SOURCE, to compare against. Taken now rather than recorded at dump time: if the
# live database has moved on, a mismatch is expected and the operator should see both numbers.
source_bars=$(psql -d "$SOURCE_DB" -tAc 'SELECT count(*) FROM candles_m1' 2>/dev/null || echo 0)
source_runs=$(psql -d "$SOURCE_DB" -tAc 'SELECT count(*) FROM backtest_runs' 2>/dev/null || echo 0)
source_symbols=$(psql -d "$SOURCE_DB" -tAc 'SELECT count(*) FROM symbols' 2>/dev/null || echo 0)
log "source: $source_bars bars, $source_runs runs, $source_symbols symbols"

log "recreating scratch database $SCRATCH"
psql -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $SCRATCH WITH (FORCE)" > /dev/null
psql -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE $SCRATCH" > /dev/null

# The extension must exist BEFORE pre_restore, and pre_restore must run in the same database the
# dump lands in.
psql -d "$SCRATCH" -v ON_ERROR_STOP=1 -c 'CREATE EXTENSION IF NOT EXISTS timescaledb' > /dev/null
log "timescaledb extension created"

psql -d "$SCRATCH" -v ON_ERROR_STOP=1 -c "SELECT timescaledb_pre_restore()" > /dev/null
log "pre_restore: background workers stopped, restoring mode on"

# `ON_ERROR_STOP` deliberately NOT set for the restore itself: a dump of a Timescale database
# replays a few statements that are already satisfied by `CREATE EXTENSION` above, and aborting on
# the first of those would reject a perfectly good backup. The verification below is what decides
# whether the restore worked — not the absence of warnings.
restore_log=$(mktemp)
if gunzip -c "$DUMP" | psql -d "$SCRATCH" > "$restore_log" 2>&1; then
    log "restore: psql exited 0"
else
    log "restore: psql exited non-zero; verification below decides"
fi
errors=$(grep -c '^ERROR:' "$restore_log" || true)
log "restore: $errors ERROR line(s) in the replay log"

psql -d "$SCRATCH" -v ON_ERROR_STOP=1 -c "SELECT timescaledb_post_restore()" > /dev/null
log "post_restore: workers restarted, restoring mode off"

# ---- verification ----------------------------------------------------------
# Structure first. A restore that produced a plain table instead of a hypertable would still answer
# every SELECT correctly while silently losing chunk exclusion and compression.
is_hypertable=$(psql -d "$SCRATCH" -tAc \
    "SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_name = 'candles_m1'")
[ "$is_hypertable" = "1" ] || fail "candles_m1 came back as a plain table, not a hypertable"
log "hypertable: candles_m1 restored as a hypertable"

policies=$(psql -d "$SCRATCH" -tAc \
    "SELECT count(*) FROM timescaledb_information.jobs WHERE proc_name = 'policy_compression'")
log "compression policy: $policies job(s)"
[ "$policies" -ge 1 ] || fail "the compression policy did not survive the restore"

restored_bars=$(psql -d "$SCRATCH" -tAc 'SELECT count(*) FROM candles_m1')
restored_runs=$(psql -d "$SCRATCH" -tAc 'SELECT count(*) FROM backtest_runs')
restored_symbols=$(psql -d "$SCRATCH" -tAc 'SELECT count(*) FROM symbols')
log "restored: $restored_bars bars, $restored_runs runs, $restored_symbols symbols"

[ "$restored_bars" = "$source_bars" ] || fail "bar count differs: $restored_bars vs $source_bars"
[ "$restored_runs" = "$source_runs" ] || fail "run count differs: $restored_runs vs $source_runs"
[ "$restored_symbols" = "$source_symbols" ] ||
    fail "symbol count differs: $restored_symbols vs $source_symbols"

# One real read through the hypertable, so the check covers querying and not only counting.
span=$(psql -d "$SCRATCH" -tAc \
    "SELECT coalesce(to_char(min(ts), 'YYYY-MM-DD') || ' .. ' || to_char(max(ts), 'YYYY-MM-DD'), 'empty') FROM candles_m1")
log "bar span in the restored database: $span"

log "PASS — restored and verified into $SCRATCH"
log "point the stack at it to run the smoke suite:"
log "  DATABASE_URL=postgresql://USER:PASS@db:5432/$SCRATCH"
