#!/usr/bin/env bash
# Exercise the relay tooling inside a throwaway Debian container with NO
# systemd: install.sh's package/user/copy/npm parts, the node started the way
# the unit starts it, verify.sh, update.sh, and the cloudflared package + token
# handling. Started by run-container-tests.sh with the repo mounted read-only
# at /src. Not for a real box.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
SRC="${SRC:-/src}"
PI="$SRC/deploy/pi"
HOST=relay.example.com
step() { echo; echo "### $*"; }
# must_not <command...>: the test fails if the command succeeds ("! cmd" would
# not abort under set -e).
must_not() { if "$@"; then echo "FAILED: succeeded but must not: $*"; exit 1; fi; }
# shellcheck source=/dev/null
. /etc/os-release
step "$PRETTY_NAME on $(uname -m)"

step "install.sh refuses to run without PUBLIC_HOST / REPO_URL"
must_not env DETACH=0 INSTALL_SOURCE="$SRC" bash "$PI/install.sh" >/tmp/usage.out 2>&1
grep -q 'PUBLIC_HOST is not set' /tmp/usage.out
must_not env DETACH=0 PUBLIC_HOST="$HOST" bash "$PI/install.sh" >/tmp/usage.out 2>&1
grep -q 'REPO_URL is not set' /tmp/usage.out
echo "ok"

step "install.sh (foreground, local source, non-systemd parts)"
DETACH=0 INSTALL_SOURCE="$SRC" PUBLIC_HOST="$HOST" AIRFLASH_NAME=container-test bash "$PI/install.sh"

step "install.sh again (idempotent)"
DETACH=0 INSTALL_SOURCE="$SRC" PUBLIC_HOST="$HOST" bash "$PI/install.sh" | tail -n 4

step "assertions"
node --version | grep -q '^v22\.'
id airflash >/dev/null
getent passwd airflash | grep -q nologin
test ! -e /etc/airflash/deploy_key            # local source: no deploy key
test "$(stat -c %U:%G:%a /etc/airflash)" = root:airflash:750
test "$(stat -c %U:%a /etc/airflash/access.key)" = airflash:600
test -s /etc/airflash/access.key
test "$(stat -c %U:%a /etc/airflash/airflash.env)" = root:600
test -d /opt/airflash/node_modules/bonjour-service
test ! -d /opt/airflash/node_modules/electron
grep -q '^AIRFLASH_HOST=127.0.0.1$' /etc/airflash/airflash.env
grep -q "^AIRFLASH_ALLOWED_HOSTS=$HOST\$" /etc/airflash/airflash.env
grep -q '^AIRFLASH_NAME=container-test$' /etc/airflash/airflash.env
grep -q '^AIRFLASH_FLAGS=--no-discovery$' /etc/airflash/airflash.env
grep -q '^AIRFLASH_ACCESS_KEY_FILE=/etc/airflash/access.key$' /etc/airflash/airflash.env
test -f /etc/systemd/system/airflash.service
test "$(stat -c %U:%a /var/lib/airflash)" = airflash:700
echo "ok"

step "start the node as the service user with the unit's environment"
# shellcheck disable=SC2046
runuser -u airflash -- env $(grep -v '^#' /etc/airflash/airflash.env | xargs) \
  node /opt/airflash/bin/airflash.js --data /var/lib/airflash --no-discovery > /tmp/airflash.log 2>&1 &
node_pid=$!
for _ in $(seq 1 40); do curl -fsS --max-time 1 http://127.0.0.1:4747/api/node >/dev/null 2>&1 && break; sleep 0.5; done
cat /tmp/airflash.log
curl -fsS http://127.0.0.1:4747/api/node | grep -q '"nodeId"'
test "$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $HOST" http://127.0.0.1:4747/api/node)" = 200
test "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: not-ours.example' http://127.0.0.1:4747/api/node)" = 421
binds="$(ss -H -ltn | awk '$4 ~ /:4747$/ {print $4}' | sort -u | tr '\n' ' ')"
test "$binds" = "127.0.0.1:4747 "
echo "ok: /api/node answers, Host header handling, bound to $binds"

step "verify.sh (systemd / cloudflared / public sections SKIP; nothing may FAIL)"
bash "$PI/verify.sh" | tee /tmp/verify.out
grep -q '^ALL-CHECKS-PASSED$' /tmp/verify.out

step "update.sh (local-copy path; no systemd, so no restart)"
bash "$PI/update.sh"
kill "$node_pid"; wait "$node_pid" 2>/dev/null || true

step "cloudflared: package from Cloudflare's apt repo (suite 'any'), unit only, no token"
PACKAGE_ONLY=1 bash "$PI/cloudflared/install-connector.sh"
cloudflared --version
test -f /etc/systemd/system/cloudflared.service
must_not grep -q -- '--token' /etc/systemd/system/cloudflared.service
# The unit's command line must be accepted by this build: with no token it must
# complain about the missing tunnel, never about an unknown flag.
out="$(timeout 20 cloudflared --no-autoupdate tunnel --metrics 127.0.0.1:20241 run 2>&1 || true)"
printf '%s\n' "$out" | tail -n 3
must_not grep -qi 'flag provided but not defined' <<<"$out"
grep -qiE 'token|tunnel|cert' <<<"$out"
echo "ok: command line accepted"

step "install-connector.sh rejects a malformed token and stores nothing"
if printf 'not-a-token\n' | bash "$PI/cloudflared/install-connector.sh" > /tmp/tok.out 2>&1; then
  echo "a bad token was accepted"; exit 1
fi
grep -q 'not a tunnel token' /tmp/tok.out
test ! -e /etc/cloudflared/tunnel-token.env
echo "ok"

step "install-connector.sh takes the token from a pasted command line, stores it root-only, never echoes it"
bogus="$(printf '{"a":"0123456789abcdef0123456789abcdef","t":"00000000-0000-0000-0000-000000000000","s":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}' | base64 -w0)"
printf 'sudo cloudflared service install %s\n' "$bogus" | bash "$PI/cloudflared/install-connector.sh" | tee /tmp/tok2.out
test "$(stat -c %U:%a /etc/cloudflared/tunnel-token.env)" = root:600
grep -q "^TUNNEL_TOKEN=$bogus\$" /etc/cloudflared/tunnel-token.env
must_not grep -q "$bogus" /tmp/tok2.out
echo "ok"

step "install-connector.sh takes the token from a root-only file and removes the file"
printf '%s\n' "$bogus" > /etc/cloudflared/tunnel.token; chmod 600 /etc/cloudflared/tunnel.token
rm -f /etc/cloudflared/tunnel-token.env
bash "$PI/cloudflared/install-connector.sh" < /dev/null | tee /tmp/tok3.out
test ! -e /etc/cloudflared/tunnel.token
grep -q "^TUNNEL_TOKEN=$bogus\$" /etc/cloudflared/tunnel-token.env
must_not grep -q "$bogus" /tmp/tok3.out
echo "ok"

echo; echo "### CONTAINER-TEST-PASSED ($PRETTY_NAME $(uname -m))"
