#!/bin/sh
# Peer installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/OmarAshour02/peer/main/scripts/install.sh | sh
#
# Downloads the newest Peer release (prereleases included) for this machine from GitHub
# Releases, checks it against the release's SHA256SUMS.txt, and installs it:
#   macOS: Peer.app into /Applications (or ~/Applications when /Applications isn't writable).
#   Linux: the AppImage into ~/.local/share/peer, a `peer` command in ~/.local/bin, and a
#          desktop entry.
#
# Alpha macOS builds are ad-hoc signed, not notarized. A file downloaded with curl carries no
# quarantine flag, so Gatekeeper doesn't stop Peer on first launch the way it does for a DMG
# downloaded in a browser.
#
# Environment:
#   PEER_VERSION        install this version (e.g. 0.2.0-alpha.1) instead of the newest release
#   PEER_INSTALL_DIR    where Peer.app (macOS) or Peer.AppImage (Linux) goes
#   PEER_REPO           GitHub repository (default OmarAshour02/peer)
#   PEER_DOWNLOAD_BASE  download from <base>/v<version>/ instead of GitHub (for testing; needs PEER_VERSION)
#
# Everything runs inside main(), so a partially downloaded script does nothing.

set -eu

main() {
  repo="${PEER_REPO:-OmarAshour02/peer}"

  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os/$arch" in
    Darwin/arm64) platform=mac; asset_arch=mac-arm64; ext=zip ;;
    Darwin/x86_64) platform=mac; asset_arch=mac-x64; ext=zip ;;
    Linux/x86_64 | Linux/amd64) platform=linux; asset_arch=linux-x86_64; ext=AppImage ;;
    Linux/aarch64 | Linux/arm64) platform=linux; asset_arch=linux-arm64; ext=AppImage ;;
    *) fail "Peer has no build for $os $arch. Supported: macOS (Apple Silicon, Intel) and Linux (x64, arm64)." ;;
  esac

  need curl
  if [ "$platform" = mac ]; then
    need ditto
    sha_cmd="shasum -a 256"
    need shasum
  else
    sha_cmd="sha256sum"
    need sha256sum
  fi

  version="${PEER_VERSION:-}"
  version="${version#v}"
  if [ -n "${PEER_DOWNLOAD_BASE:-}" ]; then
    [ -n "$version" ] || fail "PEER_DOWNLOAD_BASE needs PEER_VERSION."
    base="${PEER_DOWNLOAD_BASE%/}/v$version"
  else
    if [ -z "$version" ]; then
      say "Finding the newest Peer release…"
      # /releases/latest skips prereleases, so read the release list (newest first; drafts are not listed).
      version="$(curl -fsSL --retry 3 -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$repo/releases?per_page=5" |
        sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1)" || true
      [ -n "$version" ] || fail "Could not find a Peer release on github.com/$repo."
    fi
    base="https://github.com/$repo/releases/download/v$version"
  fi

  file="Peer-$version-$asset_arch.$ext"
  tmp="$(mktemp -d "${TMPDIR:-/tmp}/peer-install.XXXXXX")"
  staging=""
  # Keep the exit status: a failure must never look like a successful install.
  trap 'rc=$?; rm -rf "$tmp" ${staging:+"$staging"}; exit $rc' EXIT
  trap 'exit 130' INT TERM

  say "Downloading Peer $version ($asset_arch)…"
  curl -fL --retry 3 --progress-bar -o "$tmp/$file" "$base/$file" || fail "Download failed: $base/$file"
  curl -fsSL --retry 3 -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt" || fail "Download failed: $base/SHA256SUMS.txt"

  expected="$(awk -v f="$file" '$2 == f || $2 == "*" f { print $1 }' "$tmp/SHA256SUMS.txt")"
  [ -n "$expected" ] || fail "SHA256SUMS.txt has no entry for $file."
  actual="$(cd "$tmp" && $sha_cmd "$file" | awk '{ print $1 }')"
  [ "$expected" = "$actual" ] || fail "Checksum mismatch for $file (expected $expected, got $actual). Nothing was installed."
  say "Checksum OK."

  if [ "$platform" = mac ]; then
    install_mac
  else
    install_linux
  fi
}

install_mac() {
  if [ -n "${PEER_INSTALL_DIR:-}" ]; then
    dest_dir="$PEER_INSTALL_DIR"
  elif [ -w /Applications ]; then
    dest_dir=/Applications
  else
    dest_dir="$HOME/Applications"
  fi
  mkdir -p "$dest_dir" || fail "Could not create $dest_dir."
  # Absolute, symlink-free path, so it can be compared with running executables' paths.
  dest_dir="$(cd "$dest_dir" && pwd -P)" || fail "Could not open $dest_dir."
  app="$dest_dir/Peer.app"

  if [ -e "$app" ]; then
    # Only ever replace a Peer bundle.
    id="$(/usr/libexec/PlistBuddy -c "Print :CFBundleIdentifier" "$app/Contents/Info.plist" 2>/dev/null || true)"
    [ "$id" = "dev.peer.app" ] || fail "$app exists but is not Peer (bundle id: ${id:-unknown}). Move it away and run the installer again."
    if peer_running_from "$app"; then
      fail "Peer is running from $app. Quit Peer, then run the installer again."
    fi
  fi

  # ditto keeps the bundle's symlinks and code signature intact (unzip can break them).
  ditto -x -k "$tmp/$file" "$tmp/unpacked" || fail "Could not unpack $file."
  [ -d "$tmp/unpacked/Peer.app" ] || fail "$file does not contain Peer.app."
  if ! codesign --verify --deep --strict "$tmp/unpacked/Peer.app" >/dev/null 2>&1; then
    fail "The downloaded Peer.app has an invalid code signature. Nothing was installed."
  fi

  # Stage the new bundle next to the old one (same filesystem), then swap with renames. The old
  # bundle is removed only after the new one is in place, and restored if the swap fails.
  staging="$dest_dir/.Peer.app.installing.$$"
  old="$dest_dir/.Peer.app.previous.$$"
  rm -rf "$staging"
  mv "$tmp/unpacked/Peer.app" "$staging" || fail "Could not copy Peer.app into $dest_dir. Nothing was changed."
  if [ -e "$app" ]; then
    mv "$app" "$old" || fail "Could not move the current Peer.app aside. Nothing was changed."
  fi
  if ! mv "$staging" "$app"; then
    [ -e "$old" ] && mv "$old" "$app"
    fail "Could not put the new Peer.app in place. The previous installation was kept."
  fi
  rm -rf "$old"

  say ""
  say "Installed Peer $version to $app"
  say "Open it from $dest_dir, or run: open \"$app\""
}

# Is a Peer executable running from this bundle? Paths are compared literally (pgrep -f would read
# the path as a regular expression) after resolving symlinks, because ps reports the path a process
# was started with (/var/… rather than /private/var/…).
peer_running_from() {
  procs="$(ps -axo comm=)" || fail "Could not list running processes to check whether Peer is running."
  want="$(cd "$1/Contents/MacOS" 2>/dev/null && pwd -P)" || return 1
  # The loop lives in its own function: macOS's /bin/sh (bash 3.2) misparses a `case` inside $( ).
  found="$(printf '%s\n' "$procs" | match_peer_dir "$want")"
  [ "$found" = yes ]
}

# Reads executable paths on stdin; prints "yes" if one is a Peer executable inside directory $1.
match_peer_dir() {
  while IFS= read -r p; do
    case "$p" in
      */Peer.app/Contents/MacOS/Peer) ;;
      *) continue ;;
    esac
    d="$(cd "${p%/Peer}" 2>/dev/null && pwd -P)" || continue
    if [ "$d" = "$1" ]; then
      echo yes
      return 0
    fi
  done
}

install_linux() {
  data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
  dest_dir="${PEER_INSTALL_DIR:-$data_home/peer}"
  bin_dir="$HOME/.local/bin"
  mkdir -p "$dest_dir" "$bin_dir" "$data_home/applications"

  image="$dest_dir/Peer.AppImage"
  mv "$tmp/$file" "$image.new"
  chmod 755 "$image.new"
  mv -f "$image.new" "$image"
  ln -sf "$image" "$bin_dir/peer"

  cat >"$data_home/applications/peer.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Peer
Comment=AI coding that makes developers better, not just faster.
Exec="$image" %U
Terminal=false
Categories=Development;
EOF

  say ""
  say "Installed Peer $version to $image"
  case ":$PATH:" in
    *":$bin_dir:"*) say "Run it with: peer" ;;
    *) say "Run it with: $bin_dir/peer   (add $bin_dir to your PATH to use just 'peer')" ;;
  esac
  if command -v ldconfig >/dev/null 2>&1 && ! ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2'; then
    say "Note: AppImages need FUSE 2 (libfuse2). On Ubuntu/Debian: sudo apt install libfuse2t64 (or libfuse2)."
    say "      Or use the .deb from https://github.com/${PEER_REPO:-OmarAshour02/peer}/releases instead."
  fi
}

say() { printf '%s\n' "$*"; }
fail() {
  printf 'peer-install: %s\n' "$*" >&2
  exit 1
}
need() { command -v "$1" >/dev/null 2>&1 || fail "'$1' is required but not installed."; }

main "$@"
