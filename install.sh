#!/bin/sh
set -eu

repo=${CPM_REPO:-KrisLiu16/claude-proxy-manager}
install_dir=${CPM_INSTALL_DIR:-$HOME/.local/bin}
version=${CPM_VERSION:-latest}

case $(uname -s) in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "cpm: unsupported operating system: $(uname -s)" >&2; exit 1 ;;
esac
case $(uname -m) in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) echo "cpm: unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

asset="cpm-$os-$arch"
if [ "$version" = latest ]; then
  base="https://github.com/$repo/releases/latest/download"
else
  case "$version" in v*) : ;; *) version="v$version" ;; esac
  base="https://github.com/$repo/releases/download/$version"
fi

tmp_dir=$(mktemp -d "${TMPDIR:-/tmp}/cpm-install.XXXXXX")
cleanup() { rm -rf "$tmp_dir"; }
trap cleanup EXIT HUP INT TERM

download() {
  url=$1
  output=$2
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 "$url" -o "$output"
  elif command -v wget >/dev/null 2>&1; then
    wget -q "$url" -O "$output"
  else
    echo "cpm: curl or wget is required" >&2
    exit 1
  fi
}

download "$base/$asset" "$tmp_dir/$asset"
download "$base/checksums.txt" "$tmp_dir/checksums.txt"
expected=$(awk -v name="$asset" '$2 == name {print $1}' "$tmp_dir/checksums.txt")
[ -n "$expected" ] || { echo "cpm: checksum for $asset is missing" >&2; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then
  actual=$(sha256sum "$tmp_dir/$asset" | awk '{print $1}')
else
  actual=$(shasum -a 256 "$tmp_dir/$asset" | awk '{print $1}')
fi
[ "$actual" = "$expected" ] || { echo "cpm: checksum verification failed" >&2; exit 1; }

mkdir -p "$install_dir"
chmod 700 "$install_dir" 2>/dev/null || true
install -m 755 "$tmp_dir/$asset" "$install_dir/cpm"
printf 'Installed cpm %s to %s/cpm\n' "$("$install_dir/cpm" --version)" "$install_dir"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) printf 'Add %s to PATH, for example:\n  export PATH="%s:$PATH"\n' "$install_dir" "$install_dir" ;;
esac
