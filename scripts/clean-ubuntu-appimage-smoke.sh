#!/bin/bash
# Runs inside a bare ubuntu:24.04 container (see ci.yml): checks that Peer's AppImage, from /r,
# starts on a clean system. No FUSE and no development packages; only Electron's runtime
# libraries and Xvfb are installed. Launched through AppRun as a normal user, without --no-sandbox.
set -euo pipefail

apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  xvfb xauth libnss3 libgbm1 libasound2t64 libgtk-3-0t64 ca-certificates >/dev/null
for pkg in zlib1g-dev fuse fuse3 libfuse2t64; do
  if dpkg -l "$pkg" 2>/dev/null | grep -q '^ii'; then echo "not a clean system: $pkg is installed"; exit 1; fi
done

cp /r/*.AppImage /tmp/peer.AppImage
chmod 755 /tmp/peer.AppImage
cd /tmp

# The runtime must unpack itself, and the desktop entry must carry Peer's icon and window class.
./peer.AppImage --appimage-extract peer.desktop >/dev/null
grep -x "Icon=peer" squashfs-root/peer.desktop
grep -x "StartupWMClass=peer" squashfs-root/peer.desktop

# Full smoke test. Chromium refuses to run as root, so use a normal user. Without FUSE the AppImage
# runs by unpacking itself (APPIMAGE_EXTRACT_AND_RUN), still through AppRun.
useradd -m peer-smoke
# Peer exits 0 only when every check passed and it shut down cleanly; a crash or the timeout (124)
# after the result line must fail too, so require both the exit status and the result.
status=0
su peer-smoke -c "cd /tmp && APPIMAGE_EXTRACT_AND_RUN=1 timeout 360 xvfb-run -a ./peer.AppImage --smoke-test" >/tmp/smoke.txt 2>&1 || status=$?
grep -E '^(PASS|FAIL) ' /tmp/smoke.txt || true
if [ "$status" -ne 0 ] || ! grep -q '^PEER_SMOKE_RESULT {"ok":true' /tmp/smoke.txt; then
  echo "AppImage smoke test failed on a clean Ubuntu (exit $status)"; tail -40 /tmp/smoke.txt; exit 1
fi
echo "AppImage OK on a clean Ubuntu"
