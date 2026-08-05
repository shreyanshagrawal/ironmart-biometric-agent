#!/usr/bin/env bash
# Self-update check for the biometric agent, meant to run on a schedule
# (systemd timer / cron) — NOT as the long-running agent process itself.
#
# This agent runs on an office-LAN machine with no inbound network
# reachability, so it can't receive a webhook/push notification the way the
# VPS deploy does. Instead it periodically pulls to see if anything new
# landed on origin/main and restarts itself if so.
#
# Safe to run repeatedly: if there's nothing new, it's a no-op (git fetch +
# a comparison, no install/restart).
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_DIR="$(pwd)"
LOG_PREFIX="[update.sh]"

echo "$LOG_PREFIX Checking for updates in $REPO_DIR..."

git fetch origin main --quiet

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse origin/main)"

if [ "$LOCAL_HEAD" = "$REMOTE_HEAD" ]; then
  echo "$LOG_PREFIX Already up to date ($LOCAL_HEAD)."
  exit 0
fi

echo "$LOG_PREFIX New commit(s) found: $LOCAL_HEAD -> $REMOTE_HEAD"

# Refuse to silently discard uncommitted local edits (e.g. someone hand-
# patched .env or a script directly on the box) — that's a human's work,
# not something an unattended updater should ever throw away.
if [ -n "$(git status --porcelain)" ]; then
  echo "$LOG_PREFIX ERROR: local working tree has uncommitted changes — refusing to pull." >&2
  echo "$LOG_PREFIX Resolve manually (git status), then re-run this script." >&2
  exit 1
fi

# Did package.json/package-lock.json change in this update? If so, a fresh
# npm install is needed before restarting — if not, skip it (faster, and
# avoids an unnecessary network dependency on npm's registry every cycle).
DEPS_CHANGED=false
if ! git diff --quiet "$LOCAL_HEAD" "$REMOTE_HEAD" -- package.json package-lock.json; then
  DEPS_CHANGED=true
fi

git pull --ff-only origin main

if [ "$DEPS_CHANGED" = true ]; then
  echo "$LOG_PREFIX package.json/package-lock.json changed — running npm install..."
  npm install
fi

echo "$LOG_PREFIX Update applied ($REMOTE_HEAD). Restarting agent..."

if command -v systemctl >/dev/null 2>&1 && systemctl is-enabled ironmart-biometric-agent.service >/dev/null 2>&1; then
  sudo systemctl restart ironmart-biometric-agent.service
  echo "$LOG_PREFIX Restarted via systemd."
else
  echo "$LOG_PREFIX No systemd service found named 'ironmart-biometric-agent' — restart the agent process manually."
  echo "$LOG_PREFIX (If you followed the systemd setup in README.md, this branch shouldn't run — check the service name.)"
fi
