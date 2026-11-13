#!/bin/sh
# Run inside the PostgreSQL 17 backup service; credentials come from PG* env.
set -eu
umask 077

backup_dir=${BACKUP_DIR:-/backups}
mkdir -p -- "$backup_dir"
target="$backup_dir/sonar-$(date -u +%Y-%m-%d_%H-%M-%S).dump"
temporary=$(mktemp "$backup_dir/.sonar-backup.XXXXXX")
trap 'rm -f -- "$temporary"' EXIT
trap 'exit 1' HUP INT TERM

# Never dump registry, publish partial files, or rotate after a failed dump.
pg_dump --dbname=sonar --format=custom --file="$temporary"
test -s "$temporary"
mv -- "$temporary" "$target"
find "$backup_dir" -maxdepth 1 -type f \
  -name 'sonar-????-??-??_??-??-??.dump' -mtime +13 -delete
echo "Created $target"
