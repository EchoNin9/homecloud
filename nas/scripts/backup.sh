#!/usr/bin/env bash
# Archive ${DATA_ROOT} (minus caches) and optionally upload it to S3.
# Usage: DATA_ROOT=/volume1/docker/homecloud [BACKUP_DIR=...] [BACKUP_S3_URI=s3://bucket/prefix/] ./backup.sh
set -euo pipefail

DATA_ROOT="${DATA_ROOT:-/volume1/docker/homecloud}"
BACKUP_DIR="${BACKUP_DIR:-${DATA_ROOT%/}/backups}"
KEEP="${BACKUP_KEEP:-7}"

[ -d "$DATA_ROOT" ] || { echo "DATA_ROOT $DATA_ROOT not found" >&2; exit 1; }
mkdir -p "$BACKUP_DIR"
umask 077   # archive contains the IoT private key and HA secrets

archive="$BACKUP_DIR/homecloud-$(date +%Y%m%d-%H%M%S).tar.gz"
tar -czf "$archive" \
  --exclude='./backups' \
  --exclude='*/__pycache__' \
  --exclude='*/.cache' \
  --exclude='*/.storage/*.tmp' \
  --exclude='*/home-assistant.log*' \
  --exclude='*/deps' \
  --exclude='*/tts' \
  --exclude='*/log/*' \
  -C "$DATA_ROOT" .
echo "wrote $archive"

if [ -n "${BACKUP_S3_URI:-}" ]; then
  aws s3 cp "$archive" "${BACKUP_S3_URI%/}/$(basename "$archive")"
fi

# keep the newest $KEEP local archives
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/homecloud-*.tar.gz | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
