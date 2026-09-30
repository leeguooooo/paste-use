#!/bin/sh
# paste-use installer — GitHub Release binary, no token.
#   curl -fsSL https://raw.githubusercontent.com/leeguooooo/paste-use/main/install.sh | sh
# Windows: irm https://raw.githubusercontent.com/leeguooooo/paste-use/main/install.ps1 | iex
set -eu

REPO="leeguooooo/paste-use"
INSTALL_DIR="${PASTE_USE_INSTALL_DIR:-$HOME/.local/bin}"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
arch=$(uname -m)
case "$os-$arch" in
  darwin-arm64) asset="paste-use-darwin-arm64" ;;
  darwin-x86_64) asset="paste-use-darwin-x64" ;;
  *) echo "paste-use reads the Pastyx history on macOS and Windows (install.ps1); unsupported platform: $os-$arch" >&2; exit 1 ;;
esac

url="https://github.com/$REPO/releases/latest/download/$asset.tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "downloading $url"
curl -fsSL "$url" -o "$tmp/$asset.tar.gz"
# Fail closed: every release ships a .sha256.
curl -fsSL "$url.sha256" -o "$tmp/$asset.tar.gz.sha256"
expected=$(awk '{print $1}' "$tmp/$asset.tar.gz.sha256")
actual=$(shasum -a 256 "$tmp/$asset.tar.gz" | awk '{print $1}')
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "sha256 mismatch: expected $expected got $actual" >&2
  exit 1
fi

tar -xzf "$tmp/$asset.tar.gz" -C "$tmp"
chmod +x "$tmp/paste-use"
"$tmp/paste-use" version >/dev/null || { echo "downloaded binary failed smoke test" >&2; exit 1; }
mkdir -p "$INSTALL_DIR"
staged="$INSTALL_DIR/.paste-use.staged.$$"
mv "$tmp/paste-use" "$staged"
mv -f "$staged" "$INSTALL_DIR/paste-use"
echo "installed: $INSTALL_DIR/paste-use"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "note: add $INSTALL_DIR to your PATH" ;;
esac

if [ "${PASTE_USE_INSTALL_SKILLS:-1}" != "0" ]; then
  "$INSTALL_DIR/paste-use" skill install </dev/null || echo "warning: skill install failed; rerun: paste-use skill install" >&2
fi
echo "ok: run \`paste-use status\` (it reads the Pastyx app's history: https://paste.leeguoo.com/download)"
