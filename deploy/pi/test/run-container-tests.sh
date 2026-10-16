#!/usr/bin/env bash
# Run container-test.sh on arm64 Debian bookworm and trixie, emulated through
# Docker Desktop's binfmt on an x86 PC: slow (qemu), but the same packages a
# 64-bit Pi gets. No systemd inside; run-systemd-test.sh covers the units.
#
#   bash deploy/pi/test/run-container-tests.sh                     # both images
#   IMAGES=debian:trixie bash deploy/pi/test/run-container-tests.sh
#   PLATFORM=linux/amd64 bash deploy/pi/test/run-container-tests.sh  # native, quick
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PLATFORM="${PLATFORM:-linux/arm64}"
IMAGES="${IMAGES:-debian:bookworm debian:trixie}"

case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    # Git Bash would rewrite "/src" into a Windows path; the bind source must be one.
    src="$(cygpath -w "$REPO")"
    export MSYS_NO_PATHCONV=1 ;;
  *) src="$REPO" ;;
esac

rc=0
for img in $IMAGES; do
  echo "================ $img ($PLATFORM) ================"
  if docker run --rm --platform "$PLATFORM" -v "$src:/src:ro" "$img" \
       bash /src/deploy/pi/test/container-test.sh; then
    echo "PASS $img"
  else
    echo "FAIL $img"; rc=1
  fi
done
exit "$rc"
