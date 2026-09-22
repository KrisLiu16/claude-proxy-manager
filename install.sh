#!/bin/sh
# Claude Proxy Manager installer. CPM_INSTALL_DIR changes the destination;
# CPM_NO_MODIFY_PATH=1 leaves shell startup files untouched; CPM_VERSION pins a release.
set -eu

REPO=${CPM_REPO:-KrisLiu16/claude-proxy-manager}
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64|Linux-amd64) PLATFORM=linux-x64 ;;
  Linux-aarch64|Linux-arm64) PLATFORM=linux-arm64 ;;
  Darwin-arm64) PLATFORM=darwin-arm64 ;;
  Darwin-x86_64) PLATFORM=darwin-x64 ;;
  *) echo "cpm: 不支持的平台 $(uname -s)-$(uname -m)（只支持 Linux 与 macOS）" >&2; exit 1 ;;
esac
command -v curl >/dev/null 2>&1 || { echo "cpm: 安装需要 curl" >&2; exit 1; }

REQUESTED=${CPM_VERSION:-latest}
if [ "$REQUESTED" = latest ]; then
  LATEST=$(curl -fsIL -o /dev/null -w '%{url_effective}' "https://github.com/$REPO/releases/latest")
  VERSION=${LATEST##*/}
else
  case "$REQUESTED" in v*) VERSION=$REQUESTED ;; *) VERSION="v$REQUESTED" ;; esac
fi
BASE="https://github.com/$REPO/releases/download/$VERSION"
ASSET="cpm-$PLATFORM"

if [ -t 1 ]; then
  LIVE=1
  BOLD=$(printf '\033[1m')
  DIM=$(printf '\033[2m')
  GREEN=$(printf '\033[32m')
  RESET=$(printf '\033[0m')
  ERASE=$(printf '\r\033[K')
else
  LIVE=''
  BOLD=''
  DIM=''
  GREEN=''
  RESET=''
  ERASE=''
fi

row() { printf '%s  %s%s%s  %s\n' "$ERASE" "$DIM" "$1" "$RESET" "$2"; }
tick() { printf '%s  %s%s%s  %s✓%s %s\n' "$ERASE" "$DIM" "$1" "$RESET" "$GREEN" "$RESET" "$2"; }
note() { printf '        %s%s%s\n' "$DIM" "$1" "$RESET"; }
short() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}
mib() { printf '%d.%d' "$(( $1 / 1048576 ))" "$(( $1 * 10 / 1048576 % 10 ))"; }
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}
bytes_in() {
  if [ -f "$1" ]; then wc -c < "$1" | tr -d ' \n'; else printf 0; fi
}

BAR_WIDTH=24
draw() {
  [ -n "$LIVE" ] || return 0
  filled=0
  percent=0
  if [ "$SIZE" -gt 0 ]; then
    filled=$(( $1 * BAR_WIDTH / SIZE ))
    percent=$(( $1 * 100 / SIZE ))
  fi
  [ "$filled" -le "$BAR_WIDTH" ] || filled=$BAR_WIDTH
  [ "$percent" -le 100 ] || percent=100
  done_part=''
  left_part=''
  count=0
  while [ "$count" -lt "$BAR_WIDTH" ]; do
    if [ "$count" -lt "$filled" ]; then done_part="${done_part}█"; else left_part="${left_part}░"; fi
    count=$(( count + 1 ))
  done
  printf '\r  %s下载%s  %s%s%s%s  %3d%%  %s / %s MiB' \
    "$DIM" "$RESET" "$done_part" "$DIM" "$left_part" "$RESET" \
    "$percent" "$(mib "$1")" "$(mib "$SIZE")"
}

printf '\n  %sClaude Proxy Manager%s %s%s%s\n\n' "$BOLD" "$RESET" "$DIM" "$VERSION" "$RESET"
row "平台" "$PLATFORM"
row "来源" "github.com/$REPO"

DEFAULT_BIN_DIR="$HOME/.local/bin"
BIN_DIR=${CPM_INSTALL_DIR:-$DEFAULT_BIN_DIR}
mkdir -p "$BIN_DIR"
TMP="$BIN_DIR/.cpm.download.$$"
ERR="$BIN_DIR/.cpm.download.$$.err"
SUMS="$BIN_DIR/.cpm.checksums.$$"
cleanup() { rm -f "$TMP" "$ERR" "$SUMS"; }
trap cleanup EXIT HUP INT TERM

curl -fL --silent --show-error "$BASE/checksums.txt" -o "$SUMS"
EXPECTED=$(awk -v name="$ASSET" '$2 == name {print $1; exit}' "$SUMS")
[ -n "$EXPECTED" ] || { echo "cpm: ${VERSION} 没有 ${ASSET} 的摘要" >&2; exit 1; }
SIZE=$(curl -fsIL "$BASE/$ASSET" | tr -d '\r' | awk 'tolower($1)=="content-length:" && $2+0>0 {size=$2} END {print size+0}')
case "$SIZE" in ''|*[!0-9]*) SIZE=0 ;; esac

curl -fL --silent --show-error "$BASE/$ASSET" -o "$TMP" 2>"$ERR" </dev/null &
fetching=$!
while kill -0 "$fetching" 2>/dev/null; do
  have=$(bytes_in "$TMP")
  case "$have" in ''|*[!0-9]*) have=0 ;; esac
  draw "$have"
  sleep 0.1
done
if ! wait "$fetching"; then
  printf '%s' "$ERASE"
  cat "$ERR" >&2
  echo "cpm: 下载失败" >&2
  exit 1
fi
have=$(bytes_in "$TMP")
tick "下载" "$(mib "$have") MiB"

ACTUAL=$(sha256 "$TMP")
if [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "cpm: 下载的二进制摘要不对（期望 ${EXPECTED}，实际 ${ACTUAL}）" >&2
  exit 1
fi
tick "校验" "SHA-256 一致"
chmod 755 "$TMP"
if [ "$(uname -s)" = Darwin ] && ! codesign -v "$TMP" >/dev/null 2>&1; then
  codesign --force --sign - "$TMP" >/dev/null 2>&1 || true
  tick "签名" "已就地重新签名"
fi
mv "$TMP" "$BIN_DIR/cpm"
tick "安装" "$(short "$BIN_DIR/cpm")"

ENV_FILE="$HOME/.config/claude-proxy-manager/env"
if [ "$BIN_DIR" = "$DEFAULT_BIN_DIR" ]; then PATH_DIR='$HOME/.local/bin'; else PATH_DIR="$BIN_DIR"; fi
if [ "${CPM_NO_MODIFY_PATH:-0}" = 1 ]; then
  row "路径" "没改 shell 配置（CPM_NO_MODIFY_PATH=1）"
  note "自己把 $(short "$BIN_DIR") 加进 PATH"
else
  mkdir -p "$(dirname "$ENV_FILE")"
  printf 'case ":$PATH:" in *":%s:"*) ;; *) export PATH="%s:$PATH" ;; esac\n' "$PATH_DIR" "$PATH_DIR" > "$ENV_FILE"
  chmod 644 "$ENV_FILE"
  WROTE=''
  add_line() {
    if ! grep -qsF -e "$2" "$1"; then
      mkdir -p "$(dirname "$1")"
      printf '\n# Claude Proxy Manager\n%s\n' "$2" >> "$1"
      WROTE="$WROTE $(short "$1")"
    fi
  }
  SOURCE_LINE='. "$HOME/.config/claude-proxy-manager/env"'
  add_line "$HOME/.profile" "$SOURCE_LINE"
  if command -v bash >/dev/null 2>&1; then
    add_line "$HOME/.bashrc" "$SOURCE_LINE"
    if [ -f "$HOME/.bash_profile" ]; then add_line "$HOME/.bash_profile" "$SOURCE_LINE"
    elif [ -f "$HOME/.bash_login" ]; then add_line "$HOME/.bash_login" "$SOURCE_LINE"; fi
  fi
  if command -v zsh >/dev/null 2>&1; then add_line "${ZDOTDIR:-$HOME}/.zshenv" "$SOURCE_LINE"; fi
  if command -v fish >/dev/null 2>&1; then
    add_line "$HOME/.config/fish/conf.d/cpm.fish" "fish_add_path -g $PATH_DIR"
  fi
  if [ -n "$WROTE" ]; then tick "路径" "已写进${WROTE}"; else tick "路径" "已配置过"; fi
  note "新开一个终端，或运行 . $(short "$ENV_FILE")"
fi
row "启动" "运行 ${BOLD}cpm${RESET}"
printf '\n'
