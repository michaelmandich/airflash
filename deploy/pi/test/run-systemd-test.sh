#!/usr/bin/env bash
# Boot a privileged Debian container with systemd as PID 1 and run
# systemd-test.sh inside it. amd64 by default: systemd under qemu-user arm64
# emulation is not reliable, and the units are architecture-independent.
#
#   bash deploy/pi/test/run-systemd-test.sh
#   BASE=debian:trixie bash deploy/pi/test/run-systemd-test.sh
#   KEEP=1 ...   leave the container running afterwards (docker exec -it airflash-systemd-test bash)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PLATFORM="${PLATFORM:-linux/amd64}"
BASE="${BASE:-debian:bookworm}"
NAME=airflash-systemd-test

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) src="$(cygpath -w "$REPO")"; export MSYS_NO_PATHCONV=1 ;;
  *) src="$REPO" ;;
esac

docker build --platform "$PLATFORM" --build-arg "BASE=$BASE" -t "$NAME" -f "$HERE/Dockerfile.systemd" "$HERE"
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --platform "$PLATFORM" --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock --tmpfs /tmp -v "$src:/src:ro" "$NAME" >/dev/null
if [ "${KEEP:-0}" != 1 ]; then trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT; fi

for _ in $(seq 1 60); do
  state="$(docker exec "$NAME" systemctl is-system-running 2>/dev/null || true)"
  case "$state" in running|degraded) break ;; esac
  sleep 1
done
echo "systemd: ${state:-not up}"
docker exec "$NAME" bash /src/deploy/pi/test/systemd-test.sh
