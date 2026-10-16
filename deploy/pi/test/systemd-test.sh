#!/usr/bin/env bash
# Runs INSIDE the systemd container started by run-systemd-test.sh. Covers what
# container-test.sh cannot: the detached install under systemd-run, the
# hardened unit actually serving and writing drops, verify.sh with systemd
# present, the tmpfs mount, update.sh's restart, and cloudflared.service under
# its sandbox (with a well-formed but bogus token: it must run and fail at
# Cloudflare, not at systemd).
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
SRC="${SRC:-/src}"
PI="$SRC/deploy/pi"
export PUBLIC_HOST=relay.example.com   # install.sh refuses to run without it
step() { echo; echo "### $*"; }
# must_not <command...>: the test fails if the command succeeds ("! cmd" would
# not abort under set -e).
must_not() { if "$@"; then echo "FAILED: succeeded but must not: $*"; exit 1; fi; }

step "systemd state"
systemctl is-system-running || true

step "install.sh detached under systemd-run (the default on a real box)"
INSTALL_SOURCE="$SRC" AIRFLASH_NAME="Pi test" bash "$PI/install.sh"
systemctl is-active airflash
grep -q 'INSTALL-DONE' /var/log/airflash-install.log
test "$(stat -c %a /var/log/airflash-install.log)" = 600

step "install.sh again: idempotent, restarts the service"
INSTALL_SOURCE="$SRC" bash "$PI/install.sh" | tail -n 12
systemctl is-active airflash

step "unit facts"
systemctl show -p User,DynamicUser,NoNewPrivileges,ProtectSystem,ProtectHome,PrivateTmp,RestrictAddressFamilies airflash
journalctl -u airflash -n 6 --no-pager -o cat

step "round trip through the hardened unit: share-link drop, upload, download"
node - <<'JS'
const base = 'http://127.0.0.1:4747';
const secret = 'systemd-test-device-secret-0123456789';
const H = { 'X-AirFlash-Device': secret, 'Content-Type': 'application/json' };
(async () => {
  let r = await fetch(base + '/api/me', { method: 'POST', headers: H, body: JSON.stringify({ name: 'tester', kind: 'laptop' }) });
  if (r.status !== 200) throw new Error('me ' + r.status);
  const content = 'hello from the hardened unit\n';
  r = await fetch(base + '/api/drops', { method: 'POST', headers: H, body: JSON.stringify({ link: true, text: 'hi', files: [{ name: 'a.txt', size: content.length, type: 'text/plain' }] }) });
  if (r.status !== 201) throw new Error('create ' + r.status + ' ' + (await r.text()));
  const { drop, uploadToken } = await r.json();
  r = await fetch(`${base}/api/drops/${drop.id}/files/${drop.files[0].id}?token=${uploadToken}`, { method: 'PUT', headers: { 'Content-Length': String(content.length) }, body: content });
  if (r.status !== 200) throw new Error('upload ' + r.status + ' ' + (await r.text()));
  r = await fetch(`${base}/api/link/${drop.code}`);
  if (r.status !== 200) throw new Error('link ' + r.status);
  r = await fetch(`${base}/api/drops/${drop.id}/files/${drop.files[0].id}`);
  const back = await r.text();
  if (back !== content) throw new Error('content mismatch: ' + JSON.stringify(back));
  console.log('ok: drop', drop.id, 'code', drop.code, 'stored under /var/lib/airflash and served back');
})().catch((e) => { console.error(e); process.exit(1); });
JS
find /var/lib/airflash -maxdepth 3 -printf '%M %u %p\n' | head

step "verify.sh (cloudflared / public / sshd SKIP; everything else PASS)"
bash "$PI/verify.sh" | tee /tmp/verify.out
grep -q '^ALL-CHECKS-PASSED$' /tmp/verify.out

step "LAN-node variant: RELAY=0, AIRFLASH_HOST=0.0.0.0, discovery on"
RELAY=0 FORCE_ENV=1 AIRFLASH_HOST=0.0.0.0 AIRFLASH_FLAGS='' INSTALL_SOURCE="$SRC" bash "$PI/install.sh" | tail -n 8
systemctl is-active airflash
bash "$PI/verify.sh" | tee /tmp/verify-lan.out
grep -q '^ALL-CHECKS-PASSED$' /tmp/verify-lan.out
grep -q 'SKIP  AIRFLASH_HOST=0.0.0.0' /tmp/verify-lan.out
grep -q 'SKIP  discovery on' /tmp/verify-lan.out
ss -H -ltn | grep -q '^LISTEN.* 0.0.0.0:4747 '
echo "ok: a LAN node binds 0.0.0.0, verify.sh marks it as a LAN node"

step "back to the loopback configuration"
FORCE_ENV=1 INSTALL_SOURCE="$SRC" bash "$PI/install.sh" | tail -n 8
ss -H -ltn | grep -q '^LISTEN.* 127.0.0.1:4747 '
must_not grep -q ' 0.0.0.0:4747 ' <<<"$(ss -H -ltn)"
bash "$PI/verify.sh" >/dev/null

step "tmpfs variant"
TMPFS_SIZE=64M INSTALL_SOURCE="$SRC" bash "$PI/install.sh" | tail -n 5
findmnt -t tmpfs /var/lib/airflash
systemctl is-active airflash
bash "$PI/verify.sh" | grep -E 'tmpfs|ALL-CHECKS|CHECKS-FAILED'
bash "$PI/verify.sh" >/dev/null

step "update.sh"
bash "$PI/update.sh"
systemctl is-active airflash

step "cloudflared.service under its sandbox, with a well-formed but bogus token"
bogus="$(printf '{"a":"0123456789abcdef0123456789abcdef","t":"00000000-0000-0000-0000-000000000000","s":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="}' | base64 -w0)"
if printf '%s\n' "$bogus" | bash "$PI/cloudflared/install-connector.sh"; then
  echo "unexpected: a bogus token connected"; exit 1
else
  echo "(expected: no connection with a bogus token)"
fi
sleep 3
journalctl -u cloudflared -n 12 --no-pager -o cat
journal="$(journalctl -u cloudflared --no-pager)"
# cloudflared itself must have run and complained; a sandbox failure would show
# as "Failed at step ..." with exit status 2xx from systemd.
must_not grep -qE 'Failed at step|status=2[0-9][0-9]' <<<"$journal"
grep -qiE 'unauthorized|invalid|token|tunnel|failed' <<<"$journal"
must_not grep -q "$bogus" <<<"$journal"
test "$(stat -c %U:%a /etc/cloudflared/tunnel-token.env)" = root:600
must_not grep -q -- '--token' /etc/systemd/system/cloudflared.service
systemctl show -p DynamicUser,NoNewPrivileges,ProtectSystem,ProtectHome cloudflared
echo "ok: cloudflared ran under the sandbox and failed only at Cloudflare"

step "verify.sh now: only the two cloudflared lines may FAIL"
bash "$PI/verify.sh" > /tmp/verify2.out || true
grep -E '^  FAIL' /tmp/verify2.out || true
test "$(grep -c '^  FAIL' /tmp/verify2.out)" -le 2
systemctl disable --now cloudflared >/dev/null 2>&1

echo; echo "### SYSTEMD-TEST-PASSED"
