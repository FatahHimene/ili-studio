#!/usr/bin/env bash
# Nightly encrypted backup of the ilidweb server to Cloudflare R2 (restic).
# What: ili studio data volume (/data of the app), Coolify database, Coolify .env, proxy config and certificates, Coolify SSH keys.
# Settings and secrets: /root/ili-backup/backup.env (chmod 600, never in git).
set -Eeuo pipefail
set -a; source /root/ili-backup/backup.env; set +a   # export the settings so restic sees them
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

ping() { [ -n "${HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 "${HEALTHCHECK_URL}$1" >/dev/null || true; }
trap 'echo "BACKUP FAILED (line $LINENO)"; ping /fail' ERR
ping /start

WORK=/root/ili-backup/dumps
mkdir -p "$WORK"; chmod 700 "$WORK"

# 1. Coolify database (projects, applications, settings)
docker exec coolify-db pg_dumpall -U coolify > "$WORK/coolify-db.sql"

# 2. ili studio data volume(s): every Docker volume whose name ends with "-data" and belongs to an ili app
PATHS=()
for v in $(docker volume ls -q | grep -E 'ili-(studio|sites)-data$' || true); do
  PATHS+=("$(docker volume inspect -f '{{.Mountpoint}}' "$v")")
done
[ ${#PATHS[@]} -gt 0 ] || { echo "No ili data volume found"; false; }

# 3. Send it all (encrypted, only changes are uploaded)
restic backup --tag nightly --host ilidweb-studio \
  "${PATHS[@]}" "$WORK" \
  /data/coolify/source/.env /data/coolify/proxy /data/coolify/ssh

# 4. Keep 7 daily, 4 weekly and 6 monthly backups, delete older ones
restic forget --tag nightly --keep-daily 7 --keep-weekly 4 --keep-monthly 6 --prune

# 5. On Sundays, check that a sample of the stored data can really be read back
if [ "$(date +%u)" = 7 ]; then restic check --read-data-subset=5%; fi

rm -f "$WORK/coolify-db.sql"
ping ""
echo "Backup OK $(date -Is)"
