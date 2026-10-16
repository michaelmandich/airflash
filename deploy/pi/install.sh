#!/usr/bin/env bash
# Install AirFlash as a loopback-only relay node on a Raspberry Pi or any
# Debian/Ubuntu box. Published through a Cloudflare Tunnel (cloudflared/README.md).
#
# Run as root ON the box, not from your workstation:
#
#   scp -r deploy/pi pi@airflash-pi:/tmp/airflash-pi
#   ssh pi@airflash-pi 'sudo env REPO_URL=https://github.com/YOUR-GITHUB-USER/airflash.git \
#                                PUBLIC_HOST=relay.example.com bash /tmp/airflash-pi/install.sh'
#
# Every step is idempotent: re-running is always safe and never prompts.
#
# What it does, in order:
#   1. apt: git, curl, ca-certificates, iproute2; Node 22 from NodeSource (arm64/amd64)
#   2. system user `airflash` (no login shell, no password)
#   3. for an ssh REPO_URL only: /etc/airflash/deploy_key (ed25519), public half
#      printed, private half never; github.com's host keys pinned (no
#      trust-on-first-use). An https REPO_URL of a public repo needs no key.
#   4. /opt/airflash: git clone, or fast-forward pull
#   5. npm ci --omit=dev (no Electron on the box)
#   6. /etc/airflash/airflash.env (kept if it already exists)
#   7. /var/lib/airflash (optionally a tmpfs); airflash.service enabled + restarted
#   8. checks: bound to 127.0.0.1 only, /api/node answers, public hostname accepted
#
# Nothing here opens a port off this box: the service binds 127.0.0.1 only and
# runs with --no-discovery (no mDNS). The public path is cloudflared, see
# cloudflared/README.md. Nothing here touches your router.
#
# The long part runs detached under systemd-run (unit airflash-install, output
# in /var/log/airflash-install.log), so a dropped ssh session cannot leave dpkg
# half-configured. Re-run the script to re-attach to a run in progress.
# DETACH=0 runs in the foreground (containers, or when you want it in-line).
#
# Required (environment):
#   PUBLIC_HOST              the hostname the tunnel will publish, e.g. relay.example.com
#   REPO_URL                 where to clone AirFlash from, e.g.
#                            https://github.com/YOUR-GITHUB-USER/airflash.git (no key needed), or
#                            git@github.com:YOUR-GITHUB-USER/airflash.git (a read-only deploy key is
#                            generated on the first run and must be added to the repo).
#                            Not needed with INSTALL_SOURCE.
#
# Optional (environment):
#   AIRFLASH_NAME            name shown in the UI                      default: the hostname
#   AIRFLASH_PORT            loopback port                             default: 4747
#   AIRFLASH_HOST            bind address. 0.0.0.0 only for a plain LAN node
#                            (RELAY=0) that you want to reach directly.  default: 127.0.0.1
#   AIRFLASH_FLAGS           extra node flags. Unset = --no-discovery; AIRFLASH_FLAGS=
#                            (empty) turns mDNS discovery on for a LAN node.
#   AIRFLASH_ALLOWED_HOSTS   hostname(s) the node answers to, comma-separated. The node
#                            answers 421 to any other Host header.    default: PUBLIC_HOST
#   REPO_BRANCH              default: main
#   INSTALL_SOURCE           copy this local checkout instead of cloning (tests; USB/rsync deploys)
#   TMPFS_SIZE               e.g. 1G: keep drops in RAM instead of on the SD card.
#                            Default: unset = on disk, wiped at every service start.
#   RELAY                    1 (default): relay mode, docs/relay-mode.md. An access key is
#                            generated at /etc/airflash/access.key (never printed), TTL 24h,
#                            100mb per request, 12gb store, trust-proxy. 0: plain LAN node.
#   AIRFLASH_ACCESS_KEY_FILE, AIRFLASH_TTL, AIRFLASH_MAX_REQUEST_BYTES,
#   AIRFLASH_MAX_STORE_BYTES, AIRFLASH_TRUST_PROXY     the relay settings; defaults as above
#   FORCE_ENV=1              rewrite /etc/airflash/airflash.env from the values above
#   DETACH=0                 foreground instead of systemd-run
{ set +x; } 2>/dev/null
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
export HOME=/root

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$HERE/$(basename "${BASH_SOURCE[0]}")"

usage() {
  cat >&2 <<EOF
install: $1

usage: sudo env REPO_URL=<clone url> PUBLIC_HOST=<public hostname> bash $SELF

  REPO_URL      https://github.com/YOUR-GITHUB-USER/airflash.git   (public repo, no key)
                git@github.com:YOUR-GITHUB-USER/airflash.git       (deploy key, printed on the first run)
                Not needed when INSTALL_SOURCE points at a local checkout.
  PUBLIC_HOST   the hostname the tunnel will publish, e.g. relay.example.com

The header of this script lists the optional settings.
EOF
  exit 64
}

PUBLIC_HOST="${PUBLIC_HOST:-}"
REPO_URL="${REPO_URL:-}"
INSTALL_SOURCE="${INSTALL_SOURCE:-}"
[ -n "$PUBLIC_HOST" ] || usage "PUBLIC_HOST is not set"
[ -n "$REPO_URL" ] || [ -n "$INSTALL_SOURCE" ] || usage "REPO_URL is not set (or set INSTALL_SOURCE)"
case "$PUBLIC_HOST" in
  *://*|*/*|*:*|*' '*) usage "PUBLIC_HOST must be a bare hostname such as relay.example.com (got '$PUBLIC_HOST')" ;;
esac

AIRFLASH_NAME="${AIRFLASH_NAME:-$(hostname)}"
AIRFLASH_PORT="${AIRFLASH_PORT:-4747}"
AIRFLASH_HOST="${AIRFLASH_HOST:-127.0.0.1}"   # 0.0.0.0 only for a plain LAN node; verify.sh says so
# Extra node flags. Unset = --no-discovery (no mDNS on the network segment). A
# LAN node passes AIRFLASH_FLAGS= (empty) so the desktop apps can discover it.
AIRFLASH_FLAGS="${AIRFLASH_FLAGS---no-discovery}"
AIRFLASH_ALLOWED_HOSTS="${AIRFLASH_ALLOWED_HOSTS:-$PUBLIC_HOST}"
REPO_BRANCH="${REPO_BRANCH:-main}"
TMPFS_SIZE="${TMPFS_SIZE:-}"
FORCE_ENV="${FORCE_ENV:-0}"
DETACH="${DETACH:-1}"

SVC_USER=airflash
APP_DIR=/opt/airflash
ETC_DIR=/etc/airflash
DATA_DIR=/var/lib/airflash
LOG=/var/log/airflash-install.log
UNIT=airflash-install
NODE_MAJOR=22

# Relay mode (docs/relay-mode.md). RELAY=0 leaves all of this out.
RELAY="${RELAY:-1}"
AIRFLASH_ACCESS_KEY_FILE="${AIRFLASH_ACCESS_KEY_FILE:-$ETC_DIR/access.key}"
AIRFLASH_TTL="${AIRFLASH_TTL:-24h}"
AIRFLASH_MAX_REQUEST_BYTES="${AIRFLASH_MAX_REQUEST_BYTES:-100mb}"
AIRFLASH_MAX_STORE_BYTES="${AIRFLASH_MAX_STORE_BYTES:-12gb}"
AIRFLASH_TRUST_PROXY="${AIRFLASH_TRUST_PROXY:-1}"

# An ssh clone URL gets a deploy key and pinned host keys; https needs neither.
case "$REPO_URL" in
  git@*|ssh://*) USE_DEPLOY_KEY=1 ;;
  *)             USE_DEPLOY_KEY=0 ;;
esac

die() { echo "install: $*" >&2; exit 1; }
[ "$EUID" -eq 0 ] || die "must run as root (use sudo)"

have_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
# Detach: re-run this same script as a transient unit and follow its log. The
# unit survives a dropped ssh session; this foreground part is only a viewer.
# ---------------------------------------------------------------------------
if [ "$DETACH" = 1 ] && [ -z "${AIRFLASH_INSTALL_INNER:-}" ] && have_systemd; then
  touch "$LOG"; chmod 0600 "$LOG"
  if systemctl is-active --quiet "$UNIT"; then
    echo "an install is already running as $UNIT; re-attaching to $LOG"
    offset=$(( $(stat -c %s "$LOG") > 4000 ? $(stat -c %s "$LOG") - 4000 : 0 ))
  else
    offset="$(stat -c %s "$LOG")"
    env_args=()
    for v in PUBLIC_HOST REPO_URL REPO_BRANCH INSTALL_SOURCE \
             AIRFLASH_NAME AIRFLASH_PORT AIRFLASH_HOST AIRFLASH_FLAGS AIRFLASH_ALLOWED_HOSTS TMPFS_SIZE FORCE_ENV \
             RELAY AIRFLASH_ACCESS_KEY_FILE AIRFLASH_TTL AIRFLASH_MAX_REQUEST_BYTES AIRFLASH_MAX_STORE_BYTES AIRFLASH_TRUST_PROXY; do
      env_args+=(-E "$v=${!v}")
    done
    # No `$` in this command line: systemd would expand it before bash does.
    systemd-run --quiet --unit="$UNIT" --collect \
      -p "StandardOutput=append:$LOG" -p "StandardError=append:$LOG" \
      -E DEBIAN_FRONTEND=noninteractive -E AIRFLASH_INSTALL_INNER=1 -E DETACH=0 "${env_args[@]}" \
      /bin/bash "$SELF"
    echo "running detached as $UNIT; log: $LOG"
    echo "Ctrl-C or a dropped ssh does not stop it. Re-run this script to re-attach."
    echo
  fi
  pid="$(systemctl show -p MainPID --value "$UNIT" 2>/dev/null || echo 0)"
  if [ "${pid:-0}" -gt 0 ]; then
    tail -c "+$((offset + 1))" -f --pid="$pid" "$LOG"
  else
    tail -c "+$((offset + 1))" "$LOG"
  fi
  last="$(tail -n 5 "$LOG" | grep -E '^=== INSTALL-(DONE|FAILED|KEY-NEEDED)' | tail -n 1 || true)"
  case "$last" in
    *INSTALL-DONE*)       exit 0 ;;
    *INSTALL-KEY-NEEDED*) exit 2 ;;
    *) echo "install did not finish cleanly; see $LOG" >&2; exit 1 ;;
  esac
fi

finish() {
  rc=$?
  date -Is
  if   [ "$rc" -eq 0 ]; then echo "=== INSTALL-DONE ==="
  elif [ "$rc" -eq 2 ]; then echo "=== INSTALL-KEY-NEEDED ==="
  else echo "=== INSTALL-FAILED rc=$rc ==="; fi
}
trap finish EXIT
date -Is
echo "=== airflash install starting on $(hostname) ==="

# ---------------------------------------------------------------------------
echo "== packages"
arch="$(dpkg --print-architecture)"
case "$arch" in
  arm64|amd64) ;;
  *) die "unsupported architecture '$arch': NodeSource ships arm64 and amd64, so this box needs a 64-bit OS" ;;
esac
apt_get() { apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold "$@"; }
apt-get update -qq
apt_get install ca-certificates curl gnupg git openssh-client iproute2 openssl >/dev/null
echo "   base packages present"

echo "== Node $NODE_MAJOR (NodeSource apt repo)"
# NodeSource's manual recipe, not its setup_22.x script piped into bash. The
# suite is literally 'nodistro': the same packages serve bookworm and trixie.
install -d -m 0755 /etc/apt/keyrings
if [ ! -s /etc/apt/keyrings/nodesource.gpg ]; then
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
  chmod 0644 /etc/apt/keyrings/nodesource.gpg
fi
cat > /etc/apt/sources.list.d/nodesource.list <<EOF
deb [arch=$arch signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main
EOF
# Debian's own nodejs (18 on bookworm, 20 on trixie) must never win an upgrade.
cat > /etc/apt/preferences.d/nodesource <<'EOF'
Package: nodejs
Pin: origin deb.nodesource.com
Pin-Priority: 600
EOF
apt-get update -qq
apt_get install nodejs >/dev/null
node_v="$(node --version)"
case "$node_v" in
  "v${NODE_MAJOR}".*) echo "   node $node_v, npm $(npm --version)" ;;
  *) die "node is $node_v, expected v${NODE_MAJOR}.x (is Debian's nodejs pinned above NodeSource?)" ;;
esac

# ---------------------------------------------------------------------------
echo "== user $SVC_USER"
if id -u "$SVC_USER" >/dev/null 2>&1; then
  echo "   exists"
else
  useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home \
    --shell /usr/sbin/nologin "$SVC_USER"
  echo "   created (system account, shell /usr/sbin/nologin, no password)"
fi

# ---------------------------------------------------------------------------
install -d -m 0700 "$ETC_DIR"
if [ "$USE_DEPLOY_KEY" = 1 ]; then
  echo "== deploy key (ssh clone URL)"
  if [ ! -s "$ETC_DIR/deploy_key" ]; then
    ssh-keygen -q -t ed25519 -N '' -C "airflash-node@$(hostname)" -f "$ETC_DIR/deploy_key"
    echo "   generated $ETC_DIR/deploy_key"
  fi
  chmod 0600 "$ETC_DIR/deploy_key"
  chmod 0644 "$ETC_DIR/deploy_key.pub"

  # GitHub's public host keys for github.com, taken from https://api.github.com/meta
  # (the ssh_keys list). Compare them with the fingerprints GitHub publishes at
  # https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/githubs-ssh-key-fingerprints
  # and re-fetch with `gh api meta --jq '.ssh_keys[]'` if GitHub ever rotates them.
  cat > "$ETC_DIR/github_known_hosts" <<'EOF'
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFB9nkt5YRrYMjNuG5N87uRgg6CLrbo5wAdT/y6v0mKV0U2w0WZ2YB/++Tpockg=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHBL9j1aNUkY4Ue1gvwnGLVlOhGeYrnZaMgRK6+PKCUXaDbC7qtbW8gIkhL7aGCsOr/C56SJMy/BCZfxd1nWzAOxSDPgVsmerOBYfNqltV9/hWCqBywINIR+5dIg6JTJ72pcEpEjcYgXkE2YEFXV1JHnsKgbLWNlhScqb2UmyRkQyytRLtL+38TGxkxCflmO+5Z8CSSNY7GidjMIZ7Q4zMjA2n1nGrlTDkzwDCsw+wqFPGQA179cnfGWOWRVruj16z6XyvxvjJwbz0wQZ75XK5tKSb7FNyeIEs4TT4jk+S4dhPeAUC5y+bDYirYgM4GC7uEnztnZyaVWQ7B381AK4Qdrwt51ZqExKbQpTUNn+EjqoTwvqNj4kqx5QUCI0ThS/YkOxJCXmPUWZbhjpCg56i+2aB6CmK2JGhn57K5mj0MNdBXA4/WnwH6XoPWJzK5Nyu2zB3nAZp+S5hpQs+p1vN1/wsjk=
EOF
  chmod 0644 "$ETC_DIR/github_known_hosts"
  cat > "$ETC_DIR/ssh_config" <<EOF
# Used by install.sh and update.sh: GIT_SSH_COMMAND="ssh -F $ETC_DIR/ssh_config"
Host github.com
    User git
    IdentityFile $ETC_DIR/deploy_key
    IdentitiesOnly yes
    UserKnownHostsFile $ETC_DIR/github_known_hosts
    StrictHostKeyChecking yes
    BatchMode yes
EOF
  chmod 0600 "$ETC_DIR/ssh_config"
  export GIT_SSH_COMMAND="ssh -F $ETC_DIR/ssh_config"

  echo "   public key (add it to the repo as a read-only deploy key):"
  echo
  echo "   $(cat "$ETC_DIR/deploy_key.pub")"
  echo
else
  echo "== deploy key: not needed (https clone URL or local source)"
  # An earlier ssh install may have left a checkout whose origin is ssh.
  [ -f "$ETC_DIR/ssh_config" ] && export GIT_SSH_COMMAND="ssh -F $ETC_DIR/ssh_config"
fi

# ---------------------------------------------------------------------------
if [ "$RELAY" = 1 ]; then
  echo "== access key (relay mode)"
  if [ ! -s "$AIRFLASH_ACCESS_KEY_FILE" ]; then
    ( umask 077; openssl rand -base64 24 > "$AIRFLASH_ACCESS_KEY_FILE" )
    echo "   generated $AIRFLASH_ACCESS_KEY_FILE"
  else
    echo "   kept $AIRFLASH_ACCESS_KEY_FILE"
  fi
  # Never printed here. Hand it over out of band: sudo cat $AIRFLASH_ACCESS_KEY_FILE
  chown "$SVC_USER:$SVC_USER" "$AIRFLASH_ACCESS_KEY_FILE"
  chmod 0600 "$AIRFLASH_ACCESS_KEY_FILE"
  # The service user reads its key as itself, so it must traverse $ETC_DIR.
  # Everything else in there stays root-only (0600).
  chgrp "$SVC_USER" "$ETC_DIR"
  chmod 0750 "$ETC_DIR"
  echo "   $AIRFLASH_ACCESS_KEY_FILE is $SVC_USER, mode 600; $ETC_DIR is root:$SVC_USER, mode 750"
fi

# ---------------------------------------------------------------------------
echo "== source -> $APP_DIR"
# The repo's web page, derived from a GitHub clone URL, for the deploy-key hint.
repo_web="$(printf '%s' "$REPO_URL" | sed -E 's#^(git@|ssh://git@|https://)github\.com[:/]([^/]+)/([^/]+)/?$#https://github.com/\2/\3#; s#\.git$##')"
if [ -n "$INSTALL_SOURCE" ]; then
  [ -f "$INSTALL_SOURCE/package.json" ] || die "INSTALL_SOURCE=$INSTALL_SOURCE has no package.json"
  install -d -m 0755 "$APP_DIR"
  tar -C "$INSTALL_SOURCE" --exclude=./node_modules --exclude=./dist --exclude=./.airflash-data -cf - . \
    | tar -C "$APP_DIR" -xf -
  echo "local:$INSTALL_SOURCE" > "$ETC_DIR/source"
  echo "   copied from $INSTALL_SOURCE (no git remote: update.sh will only rebuild and restart)"
elif [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --quiet origin "$REPO_BRANCH" \
    || die "git fetch failed: deploy key removed from the repo, or no route to github.com?"
  git -C "$APP_DIR" checkout --quiet "$REPO_BRANCH"
  git -C "$APP_DIR" merge --ff-only --quiet "origin/$REPO_BRANCH"
  echo "   at $(git -C "$APP_DIR" rev-parse --short HEAD) ($REPO_BRANCH, fast-forwarded)"
else
  if ! git ls-remote --exit-code --quiet "$REPO_URL" "refs/heads/$REPO_BRANCH" >/dev/null 2>&1; then
    if [ "$USE_DEPLOY_KEY" = 1 ]; then
      cat <<EOF
The repo does not accept this box's deploy key yet (or $REPO_URL has no branch '$REPO_BRANCH').

  1. Open $repo_web/settings/keys and click "Add deploy key".
  2. Title: airflash-node@$(hostname)    Key: the ssh-ed25519 line printed above
     Leave "Allow write access" OFF.
  3. Run this script again. Everything done so far is kept.
EOF
      exit 2
    fi
    die "cannot read $REPO_URL (branch '$REPO_BRANCH'): is the URL right, the repo public, and github.com reachable?"
  fi
  git clone --quiet --branch "$REPO_BRANCH" "$REPO_URL" "$APP_DIR"
  echo "git:$REPO_URL" > "$ETC_DIR/source"
  echo "   cloned $(git -C "$APP_DIR" rev-parse --short HEAD) ($REPO_BRANCH)"
fi
chown -R root:root "$APP_DIR"
chmod 0755 "$APP_DIR"

# ---------------------------------------------------------------------------
echo "== npm ci --omit=dev"
export npm_config_cache=/var/cache/airflash-npm
export npm_config_update_notifier=false npm_config_fund=false npm_config_audit=false
(cd "$APP_DIR" && npm ci --omit=dev --no-progress --loglevel=error)
[ -d "$APP_DIR/node_modules/bonjour-service" ] || die "npm ci did not produce node_modules"
if [ -d "$APP_DIR/node_modules/electron" ]; then
  echo "   WARN electron was installed; devDependencies should have been omitted"
else
  echo "   $(find "$APP_DIR/node_modules" -mindepth 1 -maxdepth 1 -type d | wc -l) packages, no Electron"
fi

# ---------------------------------------------------------------------------
echo "== $ETC_DIR/airflash.env"
if [ -s "$ETC_DIR/airflash.env" ] && [ "$FORCE_ENV" != 1 ]; then
  echo "   kept as is (FORCE_ENV=1 rewrites it)"
else
  cat > "$ETC_DIR/airflash.env" <<EOF
# AirFlash node settings, read by airflash.service (EnvironmentFile).
# Edit, then: systemctl restart airflash. A configuration error exits 78 and the
# unit stays down (RestartPreventExitStatus=78): journalctl -u airflash -n 5.
# AIRFLASH_HOST stays 127.0.0.1 when the tunnel is the way in; 0.0.0.0 only for
# a plain LAN node you reach directly. verify.sh knows the difference.
AIRFLASH_HOST=$AIRFLASH_HOST
AIRFLASH_PORT=$AIRFLASH_PORT
AIRFLASH_NAME=$AIRFLASH_NAME
AIRFLASH_DATA=$DATA_DIR
# Hostnames the node answers to besides IPs, localhost and *.local
# (DNS-rebinding guard). Comma-separated. Must include the tunnel's public hostname.
AIRFLASH_ALLOWED_HOSTS=$AIRFLASH_ALLOWED_HOSTS
# Extra flags for bin/airflash.js. --no-discovery behind a tunnel; empty on a LAN node.
AIRFLASH_FLAGS=$AIRFLASH_FLAGS
EOF
  if [ "$RELAY" = 1 ]; then
    cat >> "$ETC_DIR/airflash.env" <<EOF
# Relay mode (docs/relay-mode.md): any access key switches it on. The service
# user reads the key file; that is why /etc/airflash is 0750 root:airflash.
AIRFLASH_ACCESS_KEY_FILE=$AIRFLASH_ACCESS_KEY_FILE
AIRFLASH_TTL=$AIRFLASH_TTL
AIRFLASH_MAX_REQUEST_BYTES=$AIRFLASH_MAX_REQUEST_BYTES
AIRFLASH_MAX_STORE_BYTES=$AIRFLASH_MAX_STORE_BYTES
AIRFLASH_TRUST_PROXY=$AIRFLASH_TRUST_PROXY
EOF
  else
    echo "# Relay mode off (plain LAN node). RELAY=1 FORCE_ENV=1 bash install.sh turns it on." >> "$ETC_DIR/airflash.env"
  fi
  echo "   written ($([ "$RELAY" = 1 ] && echo relay mode || echo LAN mode))"
fi
chmod 0600 "$ETC_DIR/airflash.env"

# ---------------------------------------------------------------------------
echo "== data dir $DATA_DIR"
install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$DATA_DIR"
if [ -n "$TMPFS_SIZE" ]; then
  cat > /etc/systemd/system/var-lib-airflash.mount <<EOF
# Written by deploy/pi/install.sh (TMPFS_SIZE=$TMPFS_SIZE). Drops live in RAM.
[Unit]
Description=AirFlash drop storage (tmpfs, $TMPFS_SIZE)

[Mount]
What=tmpfs
Where=$DATA_DIR
Type=tmpfs
Options=size=$TMPFS_SIZE,mode=0700,uid=$(id -u "$SVC_USER"),gid=$(id -g "$SVC_USER"),noexec,nosuid,nodev

[Install]
WantedBy=multi-user.target
EOF
  if have_systemd; then
    systemctl daemon-reload
    systemctl enable --quiet --now var-lib-airflash.mount
  fi
  echo "   tmpfs, $TMPFS_SIZE (an upload larger than the free RAM fails with 507)"
else
  rm -f /etc/systemd/system/var-lib-airflash.mount
  echo "   on disk; wiped at every service start"
fi

# ---------------------------------------------------------------------------
echo "== airflash.service"
unit_src="$HERE/airflash.service"
[ -f "$unit_src" ] || unit_src="$APP_DIR/deploy/pi/airflash.service"
[ -f "$unit_src" ] || die "airflash.service not found next to this script or in $APP_DIR/deploy/pi"
install -m 0644 "$unit_src" /etc/systemd/system/airflash.service
if ! have_systemd; then
  echo "   no systemd here (container?): unit installed, nothing started"
  echo
  echo "Installed without starting. On a real box the service would now be running."
  exit 0
fi
systemctl daemon-reload
systemctl enable --quiet airflash.service
# restart, not `enable --now`: a re-run must pick up new code and a new unit.
systemctl restart airflash.service
for _ in $(seq 1 20); do
  curl -fsS --max-time 2 "http://127.0.0.1:$AIRFLASH_PORT/api/node" >/dev/null 2>&1 && break
  sleep 0.5
done

# ---------------------------------------------------------------------------
echo "== checks"
binds="$(ss -H -ltn | awk -v p=":$AIRFLASH_PORT" 'substr($4, length($4) - length(p) + 1) == p {print $4}' | sort -u | tr '\n' ' ' | sed 's/ $//')"
if [ -z "$binds" ]; then
  echo "   FAIL nothing listening on $AIRFLASH_PORT. Last log lines:"
  journalctl -u airflash -n 20 --no-pager -o cat | sed 's/^/     /'
  exit 1
elif [ "$binds" = "127.0.0.1:$AIRFLASH_PORT" ]; then
  echo "   OK   bound to 127.0.0.1:$AIRFLASH_PORT only"
elif [ "$binds" = "$AIRFLASH_HOST:$AIRFLASH_PORT" ]; then
  echo "   WARN bound to $binds: reachable on every interface. Fine for a plain LAN node;"
  echo "        behind a tunnel set AIRFLASH_HOST=127.0.0.1 (FORCE_ENV=1 or edit airflash.env) and restart."
else
  echo "   FAIL bound to '$binds' but expected $AIRFLASH_HOST only: a wider bind publishes the node"
  echo "        to every host on the same network segment. Stopping the service."
  systemctl stop airflash.service
  exit 1
fi
if curl -fsS --max-time 3 "http://127.0.0.1:$AIRFLASH_PORT/api/node" | grep -q '"nodeId"'; then
  echo "   OK   /api/node answers"
else
  echo "   FAIL /api/node does not answer: journalctl -u airflash -n 30"
  exit 1
fi
first_host="${AIRFLASH_ALLOWED_HOSTS%%,*}"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H "Host: $first_host" "http://127.0.0.1:$AIRFLASH_PORT/api/node" || true)"
if [ "$code" = 200 ]; then
  echo "   OK   answers to Host: $first_host"
else
  echo "   WARN Host: $first_host -> HTTP $code. Through the tunnel every request carries that"
  echo "        Host header, so the public hostname would fail. Is bin/airflash.js older than"
  echo "        the --allowed-hosts change?"
fi

cat <<EOF

Installed.
  app        $APP_DIR ($(cat "$ETC_DIR/source"))
  settings   $ETC_DIR/airflash.env
  data       $DATA_DIR
  service    systemctl status airflash   |   journalctl -u airflash -f
  on-node    http://127.0.0.1:$AIRFLASH_PORT  (loopback only; nothing is reachable off this box yet)

Next: deploy/pi/verify.sh, then cloudflared/README.md to publish https://$PUBLIC_HOST.
EOF
