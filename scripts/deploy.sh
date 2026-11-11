#!/usr/bin/env bash
# Pull-based deploy: runs every minute from the sonar-deploy systemd timer.
# Deploys only when origin/main moved (or with --force). Never edits code on the server.
set -euo pipefail

APP_DIR=/opt/sonar-v2
LOG=/var/log/sonar-deploy.log
COMPOSE=(docker compose --env-file "$APP_DIR/.env" -f "$APP_DIR/docker/compose.yml")

cd "$APP_DIR"
exec 9>/run/sonar-deploy.lock
flock -n 9 || exit 0

git fetch -q origin main
if [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && [ "${1:-}" != "--force" ]; then
  exit 0
fi

log() { echo "$(date -Is) $*" >> "$LOG"; }

git merge -q --ff-only origin/main
rev=$(git rev-parse --short HEAD)
log "deploying $rev"

if "${COMPOSE[@]}" up --build -d --remove-orphans >> "$LOG" 2>&1; then
  for _ in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:58000/api/health >/dev/null 2>&1; then
      log "ok $rev"
      docker image prune -f >/dev/null 2>&1 || true
      exit 0
    fi
    sleep 2
  done
  log "FAILED $rev: health check did not pass in 60s"
else
  log "FAILED $rev: docker compose up failed"
fi
exit 1
