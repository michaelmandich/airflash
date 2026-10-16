#!/usr/bin/env bash
# Install the Cloudflare Tunnel connector (cloudflared) on this box and run it
# as a hardened systemd service, publishing AirFlash as
# https://<your public hostname> -> http://127.0.0.1:4747.
#
# This is the dashboard-token flow: create the tunnel and the public hostname
# in Zero Trust first (README.md next to this file, "Option B"), then run this
# as root ON the box. Idempotent: re-run to upgrade cloudflared, to reinstall
# the unit, or to replace the token.
#
# The tunnel token is the one secret. It is never an argument (argv is visible
# to every process and lands in shell history), never echoed and never logged.
# It reaches this script from exactly one of these, checked in this order:
#
#   TUNNEL_TOKEN        environment variable, for automation that already holds it safely
#   TUNNEL_TOKEN_FILE   a root-only (0600) file holding just the token
#                       default: /etc/cloudflared/tunnel.token, if it exists; deleted once installed
#   stdin               otherwise one line is read. At a terminal the prompt hides the input;
#                       pasting the whole "cloudflared service install eyJ..." line is fine,
#                       the last word is taken. Or pipe it:  sudo bash install-connector.sh < token
#
# It is stored once, in /etc/cloudflared/tunnel-token.env (root, 0600), which
# the unit reads as EnvironmentFile. The unit file itself holds no secret.
#
# PACKAGE_ONLY=1   install or upgrade the package and the unit file only: no
#                  token, nothing started (the container tests use this).
{ set +x; } 2>/dev/null   # tracing would print the token
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ETC=/etc/cloudflared
ENV_FILE="$ETC/tunnel-token.env"
TOKEN_FILE="${TUNNEL_TOKEN_FILE:-$ETC/tunnel.token}"
METRICS=127.0.0.1:20241
PACKAGE_ONLY="${PACKAGE_ONLY:-0}"

die() { echo "install-connector: $*" >&2; exit 1; }
[ "$EUID" -eq 0 ] || die "must run as root (use sudo)"
have_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }

# ---------------------------------------------------------------------------
echo "== cloudflared apt repo"
# Cloudflare's own repo, not the distro's. The suite is literally 'any':
# dists/any/Release lists arm64, while dists/<codename>/ is not published for
# every Debian release. Do not "fix" this to $(lsb_release -cs).
install -d -m 0755 /usr/share/keyrings
if [ ! -s /usr/share/keyrings/cloudflare-main.gpg ]; then
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  chmod 0644 /usr/share/keyrings/cloudflare-main.gpg
fi
cat > /etc/apt/sources.list.d/cloudflared.list <<'EOF'
deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main
EOF
apt-get update -qq
apt-get install -y -q cloudflared ca-certificates curl >/dev/null
echo "   $(cloudflared --version 2>&1 | head -n 1)"

# ---------------------------------------------------------------------------
echo "== unit"
unit_src="$HERE/cloudflared.service"
[ -f "$unit_src" ] || unit_src=/opt/airflash/deploy/pi/cloudflared/cloudflared.service
[ -f "$unit_src" ] || die "cloudflared.service not found next to this script"
if grep -q -- '--token' /etc/systemd/system/cloudflared.service 2>/dev/null; then
  echo "   replacing a unit that carried the token on its command line"
fi
install -m 0644 "$unit_src" /etc/systemd/system/cloudflared.service
have_systemd && systemctl daemon-reload
echo "   /etc/systemd/system/cloudflared.service (token read from $ENV_FILE)"

if [ "$PACKAGE_ONLY" = 1 ]; then
  echo "PACKAGE_ONLY=1: package and unit installed, no token, nothing started"
  exit 0
fi

# ---------------------------------------------------------------------------
echo "== token"
install -d -m 0700 "$ETC"

# A tunnel token is base64 of {"a":<account>,"t":<tunnel id>,"s":<secret>}.
# Decoded only inside this function, never printed.
valid_token() {
  local t="$1" json
  case "$t" in ''|*[!A-Za-z0-9+/=_-]*) return 1 ;; esac
  [ "${#t}" -ge 80 ] || return 1
  t="$(printf '%s' "$t" | tr '_-' '/+')"
  while [ $(( ${#t} % 4 )) -ne 0 ]; do t="$t="; done
  json="$(printf '%s' "$t" | base64 -d 2>/dev/null)" || return 1
  case "$json" in *\"a\":*\"t\":*\"s\":*) return 0 ;; *) return 1 ;; esac
}

token=""
src=""
if [ -n "${TUNNEL_TOKEN:-}" ]; then
  token="$TUNNEL_TOKEN"; src="environment"
elif [ -s "$TOKEN_FILE" ]; then
  [ "$(stat -c %U:%a "$TOKEN_FILE")" = "root:600" ] \
    || die "$TOKEN_FILE must be owned by root with mode 600 (chown root; chmod 600)"
  token="$(head -n 1 "$TOKEN_FILE")"; src="$TOKEN_FILE"
else
  if [ -t 0 ]; then
    if [ -s "$ENV_FILE" ]; then
      printf '   Paste the tunnel token (input hidden; Enter keeps the installed one): ' >&2
    else
      printf '   Paste the tunnel token from the Zero Trust connector command (input hidden): ' >&2
    fi
    IFS= read -rs token || true
    echo >&2
  else
    IFS= read -r token || true
  fi
  src="stdin"
fi
# Whole command pasted? Keep the last word. Strip CR/LF and surrounding blanks.
token="$(printf '%s' "$token" | tr -d '\r\n' | sed 's/[[:space:]]*$//; s/^.*[[:space:]]//')"

if [ -z "$token" ]; then
  [ -s "$ENV_FILE" ] || die "no token given and none installed yet (see the header of this script)"
  echo "   keeping the installed token"
else
  valid_token "$token" || die "that is not a tunnel token (expected the long eyJ... value from the connector command)"
  ( umask 077; printf 'TUNNEL_TOKEN=%s\n' "$token" > "$ENV_FILE.tmp" && mv -f "$ENV_FILE.tmp" "$ENV_FILE" )
  chown root:root "$ENV_FILE"; chmod 0600 "$ENV_FILE"
  echo "   installed from $src into $ENV_FILE (root, 0600)"
  if [ "$src" = "$TOKEN_FILE" ]; then
    rm -f "$TOKEN_FILE"
    echo "   removed $TOKEN_FILE: the token now lives only in $ENV_FILE"
  fi
fi
unset token TUNNEL_TOKEN

# ---------------------------------------------------------------------------
echo "== service"
if ! have_systemd; then
  echo "   no systemd here (container?): unit and token installed, nothing started"
  exit 0
fi
systemctl enable --quiet cloudflared.service
# restart, not `enable --now`: a re-run with a new token must pick it up.
systemctl restart cloudflared.service
printf '   waiting for the tunnel to connect'
conns=""
for _ in $(seq 1 30); do
  ready="$(curl -fsS --max-time 2 "http://$METRICS/ready" 2>/dev/null || true)"
  conns="$(printf '%s' "$ready" | sed -n 's/.*"readyConnections":\([0-9]*\).*/\1/p')"
  if [ -n "$conns" ] && [ "$conns" -gt 0 ]; then break; fi
  printf '.'
  sleep 1
done
echo
if [ -n "$conns" ] && [ "$conns" -gt 0 ]; then
  echo "   OK   connected: $conns connections to Cloudflare"
  cat <<'EOF'

The public hostname is live as soon as it exists in the dashboard. Check:
    sudo bash /opt/airflash/deploy/pi/verify.sh
EOF
else
  echo "   FAIL no connection after 30 s. Last log lines (cloudflared never logs the token):"
  journalctl -u cloudflared -n 15 --no-pager -o cat | sed 's/^/     /'
  exit 1
fi
