#!/bin/sh
set -eu

out_dir=${1:-release}
bun_bin=${BUN:-bun}
mkdir -p "$out_dir"

build() {
  target=$1
  output=$2
  "$bun_bin" build --compile --minify --target="$target" \
    --define process.env.NODE_ENV='"production"' \
    src/cli.tsx --outfile "$out_dir/$output"
}

build bun-linux-x64-baseline cpm-linux-x64
build bun-linux-arm64 cpm-linux-arm64
build bun-darwin-x64-baseline cpm-darwin-x64
build bun-darwin-arm64 cpm-darwin-arm64

(
  cd "$out_dir"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum cpm-* > checksums.txt
  else
    shasum -a 256 cpm-* > checksums.txt
  fi
)
