#!/usr/bin/env bash
# Update the AirFlash relay node: pull, npm ci, restart, show status.
#
# Run as root ON the box:
#   sudo bash /opt/airflash/deploy/pi/update.sh
#
# Fast-forward only: the checkout on the box is never meant to carry local
# changes. If the unit file in the repo changed, it is reinstalled too.
# REPO_BRANCH overrides the branch (default main). The clone URL and, for an
# ssh URL, the deploy key are whatever install.sh set up.
{ set +x; } 2>/dev/null
set -euo pipefail
export HOME=/root

APP_DIR=/opt/airflash
ETC_DIR=/etc/airflash
BRANCH="${REPO_BRANCH:-main}"

die() { echo "update: $*" >&2; exit 1; }
[ "$EUID" -eq 0 ] || die "must run as root (use sudo)"
[ -f "$APP_DIR/package.json" ] || die "$APP_DIR is not an AirFlash checkout; run install.sh first"
have_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }

# Not sourced: the file is ours, but parsing one key is cheaper than trusting it.
port="$(sed -n 's/^AIRFLASH_PORT=//p' "$ETC_DIR/airflash.env" 2>/dev/null | tail -n 1)"
port="${port:-4747}"

echo "== source"
if [ -d "$APP_DIR/.git" ] && git -C "$APP_DIR" remote get-url origin >/dev/null 2>&1; then
  # ssh_config exists only for an ssh clone URL (deploy key + pinned host keys).
  [ -f "$ETC_DIR/ssh_config" ] && export GIT_SSH_COMMAND="ssh -F $ETC_DIR/ssh_config"
  before="$(git -C "$APP_DIR" rev-parse --short HEAD)"
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH" \
    || die "git fetch failed: deploy key removed from the repo, or no route to github.com?"
  git -C "$APP_DIR" checkout --quiet "$BRANCH"
  git -C "$APP_DIR" merge --ff-only --quiet "origin/$BRANCH" \
    || die "not a fast-forward: someone changed files in $APP_DIR. Inspect with: git -C $APP_DIR status"
  after="$(git -C "$APP_DIR" rev-parse --short HEAD)"
  if [ "$before" = "$after" ]; then echo "   already at $after"; else echo "   $before -> $after"; fi
  git -C "$APP_DIR" log --oneline -n 3 | sed 's/^/   /'
else
  echo "   no git remote (installed from a local copy): rebuilding what is here"
fi
chown -R root:root "$APP_DIR"

echo "== npm ci --omit=dev"
export npm_config_cache=/var/cache/airflash-npm
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
(cd "$APP_DIR" && npm ci --omit=dev --no-progress --loglevel=error)
echo "   done"

echo "== unit"
if [ ! -f "$APP_DIR/deploy/pi/airflash.service" ]; then
  echo "   $APP_DIR/deploy/pi/airflash.service is not in this checkout (branch without deploy/pi?); keeping the installed unit"
elif ! cmp -s "$APP_DIR/deploy/pi/airflash.service" /etc/systemd/system/airflash.service; then
  install -m 0644 "$APP_DIR/deploy/pi/airflash.service" /etc/systemd/system/airflash.service
  have_systemd && systemctl daemon-reload
  echo "   airflash.service updated"
else
  echo "   unchanged"
fi

if ! have_systemd; then
  echo "== no systemd here (container?): not restarting"
  exit 0
fi

echo "== restart"
systemctl restart airflash.service
for _ in $(seq 1 20); do
  curl -fsS --max-time 2 "http://127.0.0.1:$port/api/node" >/dev/null 2>&1 && break
  sleep 0.5
done
systemctl --no-pager --lines=0 status airflash.service || true
echo
if out="$(curl -fsS --max-time 3 "http://127.0.0.1:$port/api/node")"; then
  echo "   /api/node: $out"
else
  echo "   FAIL /api/node does not answer: journalctl -u airflash -n 30" >&2
  exit 1
fi
