#!/usr/bin/env bash
# On-node assertions for the AirFlash relay node. One PASS / FAIL / SKIP per
# line; exits 0 only when nothing FAILed. SKIP means "not applicable yet"
# (no tunnel installed, hostname not published, relay mode off) and says why.
#
# Run as root ON the box (socket owners and root-only files need it):
#   sudo bash /opt/airflash/deploy/pi/verify.sh
#
# A plain LAN node (RELAY=0 with AIRFLASH_HOST=0.0.0.0 and discovery on) is a
# supported configuration: those lines SKIP with a note instead of failing.
# Once relay mode is on, only 127.0.0.1 + --no-discovery pass.
#
# PUBLIC_HOST overrides the hostname to probe (default: the first entry of
# AIRFLASH_ALLOWED_HOSTS in /etc/airflash/airflash.env).
set -u

ETC_DIR=/etc/airflash
APP_DIR=/opt/airflash
DATA_DIR=/var/lib/airflash
SVC_USER=airflash
METRICS=127.0.0.1:20241     # cloudflared --metrics; cloudflared/README.md sets it

fail=0
pass()    { printf '  PASS  %s\n' "$1"; }
failed()  { printf '  FAIL  %s\n' "$1"; fail=$((fail + 1)); }
skipped() { printf '  SKIP  %s\n' "$1"; }
# assert <message> <command...>: PASS if the command succeeds.
assert()  { local msg="$1"; shift; if "$@" >/dev/null 2>&1; then pass "$msg"; else failed "$msg"; fi; }
# shellcheck disable=SC2329  # invoked through assert "$@"
not()      { ! "$@"; }
contains() { case "$1" in *"$2"*) return 0 ;; *) return 1 ;; esac; }
have_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }
setting() { sed -n "s/^$1=//p" "$ETC_DIR/airflash.env" 2>/dev/null | tail -n 1; }

port="$(setting AIRFLASH_PORT)"; port="${port:-4747}"
allowed="$(setting AIRFLASH_ALLOWED_HOSTS)"
public_host="${PUBLIC_HOST:-${allowed%%,*}}"
host_cfg="$(setting AIRFLASH_HOST)"
flags_cfg="$(setting AIRFLASH_FLAGS)"
key_file="$(setting AIRFLASH_ACCESS_KEY_FILE)"
# A plain LAN node: relay mode off and bound to every interface on purpose.
lan_node=0
if [ -z "$key_file" ] && [ "$host_cfg" = 0.0.0.0 ]; then
  lan_node=1
fi

echo "--- install ---"
nv="$(node --version 2>/dev/null || echo v0)"
major="${nv#v}"; major="${major%%.*}"
assert "node is $nv (want v22+)" test "${major:-0}" -ge 22
assert "user $SVC_USER exists" id -u "$SVC_USER"
shell="$(getent passwd "$SVC_USER" 2>/dev/null | cut -d: -f7)"
assert "$SVC_USER has no login shell ($shell)" test "$shell" = /usr/sbin/nologin -o "$shell" = /bin/false
assert "$APP_DIR checked out with node_modules" test -f "$APP_DIR/bin/airflash.js" -a -d "$APP_DIR/node_modules"
assert "no Electron in $APP_DIR/node_modules" test ! -d "$APP_DIR/node_modules/electron"
etc_mode="$(stat -c %U:%G:%a "$ETC_DIR" 2>/dev/null)"
assert "$ETC_DIR is root:root 700 (LAN) or root:$SVC_USER 750 (relay) (is $etc_mode)" test "$etc_mode" = root:root:700 -o "$etc_mode" = "root:$SVC_USER:750"
if [ -e "$ETC_DIR/deploy_key" ]; then
  assert "deploy key is root, mode 600" test "$(stat -c %U:%a "$ETC_DIR/deploy_key" 2>/dev/null)" = root:600
else
  skipped "no deploy key (https clone URL or local source)"
fi
assert "airflash.env is root, mode 600" test "$(stat -c %U:%a "$ETC_DIR/airflash.env" 2>/dev/null)" = root:600
if [ "$lan_node" = 1 ]; then
  skipped "AIRFLASH_HOST=0.0.0.0: plain LAN node; behind a tunnel set 127.0.0.1 (RELAY=1 FORCE_ENV=1 install.sh, or edit airflash.env and restart)"
else
  assert "AIRFLASH_HOST=127.0.0.1 in airflash.env (is '$host_cfg')" test "$host_cfg" = 127.0.0.1
fi
assert "AIRFLASH_ALLOWED_HOSTS set ('$allowed')" test -n "$allowed"

echo "--- service ---"
if have_systemd; then
  assert "airflash.service enabled" systemctl is-enabled --quiet airflash.service
  assert "airflash.service active" systemctl is-active --quiet airflash.service
  execstart="$(systemctl show -p ExecStart --value airflash.service 2>/dev/null)"
  if [ "$lan_node" = 1 ] && ! contains "$flags_cfg" "--no-discovery"; then
    skipped "discovery on (AIRFLASH_FLAGS empty): plain LAN node; behind a tunnel set AIRFLASH_FLAGS=--no-discovery"
  else
    assert "unit runs with --no-discovery" contains "$execstart $flags_cfg" "--no-discovery"
  fi
  u="$(systemctl show -p User --value airflash.service 2>/dev/null)"
  assert "unit runs as $SVC_USER (is '$u')" test "$u" = "$SVC_USER"
  assert "NoNewPrivileges=yes" test "$(systemctl show -p NoNewPrivileges --value airflash.service 2>/dev/null)" = yes
  assert "ProtectSystem=strict" test "$(systemctl show -p ProtectSystem --value airflash.service 2>/dev/null)" = strict
else
  skipped "systemd checks: no systemd on this host (container test)"
fi

echo "--- network ---"
all_binds="$(ss -H -ltn 2>/dev/null | awk '{print $4}')"
listening="$(printf '%s\n' "$all_binds" | awk -v p=":$port" 'substr($0, length($0) - length(p) + 1) == p' | sort -u)"
found="$(printf '%s' "$listening" | tr '\n' ' ')"
assert "something listens on port $port" test -n "$listening"
if [ "$lan_node" = 1 ]; then
  assert "port $port bound to 0.0.0.0:$port (LAN node; found: $found)" test "$listening" = "0.0.0.0:$port"
else
  assert "port $port is bound to 127.0.0.1 ONLY (found: $found)" test "$listening" = "127.0.0.1:$port"
  assert "no wildcard bind on $port" not grep -qE "^(0\.0\.0\.0|\*|\[::\]):$port$" <<<"$all_binds"
fi
body="$(curl -fsS --max-time 3 "http://127.0.0.1:$port/api/node" 2>/dev/null)"
assert "GET /api/node returns JSON with nodeId" contains "$body" '"nodeId"'
local_id="$(printf '%s' "$body" | sed -n 's/.*"nodeId":"\([^"]*\)".*/\1/p')"
if [ -n "$public_host" ]; then
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H "Host: $public_host" "http://127.0.0.1:$port/api/node" 2>/dev/null)"
  assert "answers 200 to Host: $public_host (got $code; the tunnel sends this header)" test "$code" = 200
fi
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -H 'Host: not-ours.example' "http://127.0.0.1:$port/api/node" 2>/dev/null)"
assert "refuses an unknown Host header with 421 (got $code)" test "$code" = 421
if [ "$lan_node" = 1 ]; then
  skipped "mDNS socket check: discovery is on for a LAN node"
else
  mdns="$(ss -H -lunp 2>/dev/null | grep ':5353 ' || true)"
  assert "node holds no mDNS socket (udp 5353)" not contains "$mdns" "node"
fi

echo "--- relay ---"
if [ -z "$key_file" ]; then
  skipped "relay mode off (no AIRFLASH_ACCESS_KEY_FILE in airflash.env): plain LAN node"
else
  assert "access key file is $SVC_USER, mode 600, non-empty (value never shown)" test "$(stat -c %U:%a "$key_file" 2>/dev/null)" = "$SVC_USER:600" -a -s "$key_file"
  assert "AIRFLASH_TRUST_PROXY=1 (is '$(setting AIRFLASH_TRUST_PROXY)')" test "$(setting AIRFLASH_TRUST_PROXY)" = 1
  assert "AIRFLASH_TTL / MAX_REQUEST_BYTES / MAX_STORE_BYTES set ($(setting AIRFLASH_TTL) / $(setting AIRFLASH_MAX_REQUEST_BYTES) / $(setting AIRFLASH_MAX_STORE_BYTES))" \
    test -n "$(setting AIRFLASH_TTL)" -a -n "$(setting AIRFLASH_MAX_REQUEST_BYTES)" -a -n "$(setting AIRFLASH_MAX_STORE_BYTES)"
  assert "/api/node says relay:true" contains "$body" '"relay":true'
  assert "/api/node advertises limits" contains "$body" '"limits"'
  assert "/api/node hides the node's addresses (no urls)" not contains "$body" '"urls"'
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 3 -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:$port/api/drops" 2>/dev/null)"
  assert "POST /api/drops without a key -> 401 (got $code)" test "$code" = 401
  if have_systemd; then
    banner="$(journalctl -u airflash --no-pager -o cat -n 60 2>/dev/null)"
    assert "banner: 'Relay mode: on'" contains "$banner" "Relay mode: on"
    assert "banner: 'Client IP: CF-Connecting-IP / X-Forwarded-For (trust-proxy)'" contains "$banner" "Client IP: CF-Connecting-IP / X-Forwarded-For (trust-proxy)"
    assert "banner: no WARNING line" not contains "$banner" "WARNING"
    assert "unit: RestartPreventExitStatus includes 78 (config errors stay down)" contains "$(systemctl show -p RestartPreventExitStatus --value airflash.service 2>/dev/null)" "78"
  fi
fi

echo "--- data ---"
assert "$DATA_DIR owned by $SVC_USER" test "$(stat -c %U "$DATA_DIR" 2>/dev/null)" = "$SVC_USER"
m="$(stat -c %a "$DATA_DIR" 2>/dev/null)"
assert "$DATA_DIR mode is 700/750 (is $m)" test "$m" = 700 -o "$m" = 750
if findmnt -n -t tmpfs "$DATA_DIR" >/dev/null 2>&1; then
  pass "$DATA_DIR is a tmpfs ($(findmnt -n -o SIZE "$DATA_DIR"))"
else
  pass "$DATA_DIR is on disk, $(df -h --output=avail "$DATA_DIR" 2>/dev/null | tail -n 1 | tr -d ' ') free (wiped at every start)"
fi

echo "--- cloudflared ---"
if ! command -v cloudflared >/dev/null 2>&1; then
  skipped "cloudflared not installed yet (cloudflared/README.md)"
elif ! have_systemd; then
  skipped "cloudflared $(cloudflared --version 2>/dev/null | awk '{print $3}') installed; no systemd to run it here"
else
  assert "cloudflared.service active" systemctl is-active --quiet cloudflared.service
  assert "unit carries no token on its command line" not grep -q -- '--token' /etc/systemd/system/cloudflared.service
  if [ -f /etc/cloudflared/tunnel-token.env ]; then
    assert "tunnel-token.env is root, mode 600" test "$(stat -c %U:%a /etc/cloudflared/tunnel-token.env 2>/dev/null)" = root:600
  fi
  if [ -e /root/.cloudflared/cert.pem ]; then
    failed "/root/.cloudflared/cert.pem still exists: the account certificate must be deleted once the tunnel is routed (cloudflared/README.md)"
  else
    pass "no account certificate left on the box (/root/.cloudflared/cert.pem)"
  fi
  ready="$(curl -fsS --max-time 3 "http://$METRICS/ready" 2>/dev/null)"
  conns="$(printf '%s' "$ready" | sed -n 's/.*"readyConnections":\([0-9]*\).*/\1/p')"
  assert "tunnel connected (${conns:-0} connections to Cloudflare; metrics on $METRICS)" test "${conns:-0}" -gt 0
fi

echo "--- public ---"
if [ -z "$public_host" ]; then
  skipped "no public hostname configured (AIRFLASH_ALLOWED_HOSTS empty)"
elif ! getent ahosts "$public_host" >/dev/null 2>&1; then
  skipped "$public_host does not resolve yet: hostname not published (cloudflared tunnel route dns)"
else
  pub="$(curl -fsS --max-time 15 "https://$public_host/api/node" 2>/dev/null)"
  if contains "$pub" '"nodeId"'; then
    pass "https://$public_host/api/node answers with JSON"
    pub_id="$(printf '%s' "$pub" | sed -n 's/.*"nodeId":"\([^"]*\)".*/\1/p')"
    assert "the public hostname reaches THIS node (nodeId matches)" test -n "$local_id" -a "$pub_id" = "$local_id"
  else
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$public_host/api/node" 2>/dev/null)"
    failed "https://$public_host/api/node -> HTTP ${code:-none} (530 = tunnel not connected; 502 = connector up, origin refused; 421 = hostname missing from AIRFLASH_ALLOWED_HOSTS)"
  fi
fi

echo "--- host ---"
if ! command -v sshd >/dev/null 2>&1; then
  skipped "no sshd on this host"
elif [ "$(id -u)" -ne 0 ]; then
  skipped "sshd config check needs root"
else
  assert "sshd: password authentication off (key-only login on a box with a public hostname)" grep -qix 'passwordauthentication no' <<<"$(sshd -T 2>/dev/null)"
fi

echo "--- state ---"
ip -br -4 addr 2>/dev/null | grep -v '^lo ' | sed 's/^/  /'
if [ "$fail" = 0 ]; then echo "ALL-CHECKS-PASSED"; exit 0; fi
echo "CHECKS-FAILED: $fail"
exit 1
