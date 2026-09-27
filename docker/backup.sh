#!/bin/sh
# Nightly pg_dump with N-day retention.
#
# Deliberately a shell loop rather than cron: the schedule is visible in
# docker-compose.prod.yml, there is no second init system in the container, and
# the logs go straight to `docker logs edgelab-backup`.
set -eu

BACKUP_DIR=/backups
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
# 03:00 UTC.
TARGET_HOUR="${BACKUP_HOUR:-3}"

mkdir -p "$BACKUP_DIR"

log() {
    echo "[backup $(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"
}

run_backup() {
    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    target="$BACKUP_DIR/edgelab-$stamp.sql.gz"
    tmp="$target.partial"

    log "dumping $PGDATABASE -> $(basename "$target")"

    # --no-owner/--no-privileges so the dump restores cleanly into a fresh
    # cluster with a differently named role.
    if pg_dump --no-owner --no-privileges | gzip -9 > "$tmp"; then
        mv "$tmp" "$target"
        log "wrote $(du -h "$target" | cut -f1)"
    else
        # Never leave a truncated file that looks like a usable backup.
        rm -f "$tmp"
        log "DUMP FAILED — leaving previous backups untouched"
        return 1
    fi

    # Prune only AFTER a successful dump, so a broken database cannot quietly
    # age out the last good backup.
    deleted=$(find "$BACKUP_DIR" -name 'edgelab-*.sql.gz' -type f -mtime "+$KEEP_DAYS" -print -delete | wc -l)
    log "retention ${KEEP_DAYS}d: pruned $deleted file(s), $(find "$BACKUP_DIR" -name 'edgelab-*.sql.gz' | wc -l) remain"
}

log "started; nightly at ${TARGET_HOUR}:00 UTC, keeping ${KEEP_DAYS} days"

# Take one immediately so a fresh deployment is covered without waiting a day,
# and so a misconfiguration surfaces now rather than at 03:00.
run_backup || log "initial backup failed; will retry on schedule"

while true; do
    hour=$(date -u +%-H)
    if [ "$hour" -eq "$TARGET_HOUR" ]; then
        run_backup || log "scheduled backup failed"
        # Past the target hour so it cannot fire twice in the same window.
        sleep 3600
    fi
    sleep 600
done
