#!/usr/bin/env bash
# Nightly Borg backup of the Postgres dump + receipt photos to a Hetzner
# Storage Box (§11). Non-optional — the one real weakness of a home box.
#
# Receipt photos live in Postgres (§7), so the DB dump covers everything that
# must survive. RECEIPT_DIR is a placeholder for any on-disk assets a future
# version might add outside the DB.
#
# Schedule via cron/systemd-timer on the host, e.g.:
#   15 3 * * *  /path/to/scripts/backup.sh >> /var/log/mealplanner-backup.log 2>&1
set -euo pipefail

# --- config (override via environment) ---
: "${BORG_REPO:?set BORG_REPO, e.g. ssh://uXXXXXX@uXXXXXX.your-storagebox.de:23/./mealplanner}"
: "${BORG_PASSPHRASE:?set BORG_PASSPHRASE for the encrypted repo}"
export BORG_PASSPHRASE

POSTGRES_CONTAINER="${POSTGRES_CONTAINER:-mealplanner-db-1}"
POSTGRES_USER="${POSTGRES_USER:-mealplanner}"
POSTGRES_DB="${POSTGRES_DB:-mealplanner}"
RECEIPT_DIR="${RECEIPT_DIR:-/var/lib/mealplanner/receipts}"

STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT

# 1. Dump the database.
docker exec "$POSTGRES_CONTAINER" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
	| gzip > "$STAGING/db.sql.gz"

# 2. Create an encrypted, deduplicated, incremental archive.
borg create --stats --compression zstd \
	"${BORG_REPO}::mealplanner-{now:%Y-%m-%dT%H:%M:%S}" \
	"$STAGING" \
	"$RECEIPT_DIR"

# 3. Prune to a sensible retention window.
borg prune --list "$BORG_REPO" \
	--keep-daily=7 --keep-weekly=4 --keep-monthly=6

borg compact "$BORG_REPO"
