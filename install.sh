#!/bin/sh
# Установка standalone-бинарника claude-codex из GitHub Releases: Bun и Node не нужны.
#
#   curl -fsSL https://raw.githubusercontent.com/mcar2107/claude-codex/master/install.sh | sh
#
# Переменные окружения:
#   CLAUDE_CODEX_VERSION      тег релиза (v0.1.0); по умолчанию — самый новый, включая prerelease
#   CLAUDE_CODEX_INSTALL_DIR  каталог бинарника; по умолчанию ~/.local/bin
#   CLAUDE_CODEX_SHARE_DIR    каталог лицензий; по умолчанию ${XDG_DATA_HOME:-~/.local/share}/claude-codex
#
# Скрипт трогает только эти два пути: state (~/.claude-codex), настройки и команды Claude не меняет.
set -eu

REPO=mcar2107/claude-codex
BIN_DIR=${CLAUDE_CODEX_INSTALL_DIR:-$HOME/.local/bin}
SHARE_DIR=${CLAUDE_CODEX_SHARE_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/claude-codex}

fail() {
  echo "claude-codex install: $*" >&2
  exit 1
}

for tool in curl tar uname mktemp; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is required"
done

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "unsupported OS $(uname -s); only macOS and Linux are supported" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
# Rosetta: x64-оболочка на Apple Silicon получает нативный arm64-бинарник.
if [ "$os-$arch" = darwin-x64 ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi
# Linux-бинарники собраны под glibc; musl (Alpine) не поддерживается.
if [ "$os" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  fail 'musl libc (e.g. Alpine) is not supported; a glibc-based Linux is required'
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha256() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  fail 'sha256sum or shasum is required to verify the download'
fi

# `releases/latest` не отдаёт prerelease, поэтому без явной версии берётся первый релиз из списка.
version=${CLAUDE_CODEX_VERSION:-}
if [ -z "$version" ]; then
  version=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=1" |
    sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$version" ] || fail "could not determine the latest release of $REPO"
fi

name="claude-codex-$os-$arch"
base="https://github.com/$REPO/releases/download/$version"
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT
trap 'exit 130' INT TERM

echo "Downloading claude-codex $version ($os-$arch)..."
curl -fsSL -o "$temp/$name.tar.gz" "$base/$name.tar.gz" || fail "could not download $base/$name.tar.gz"
curl -fsSL -o "$temp/SHA256SUMS" "$base/SHA256SUMS" || fail "could not download $base/SHA256SUMS"

# Имя сравнивается целиком, а не регэкспом: точка в имени не должна совпадать с любым символом.
expected=$(awk -v file="$name.tar.gz" '$2 == file || $2 == "*" file { print $1; exit }' "$temp/SHA256SUMS")
[ -n "$expected" ] || fail "no checksum for $name.tar.gz in SHA256SUMS"
[ "$(sha256 "$temp/$name.tar.gz")" = "$expected" ] || fail 'checksum mismatch; aborting'

tar -xzf "$temp/$name.tar.gz" -C "$temp"
[ -f "$temp/$name/claude-codex" ] || fail 'archive does not contain the claude-codex executable'

mkdir -p "$BIN_DIR" "$SHARE_DIR"
# Замена через временный файл в том же каталоге: запущенные сессии сохраняют старый бинарник.
cp "$temp/$name/claude-codex" "$BIN_DIR/.claude-codex.new"
chmod 755 "$BIN_DIR/.claude-codex.new"
mv -f "$BIN_DIR/.claude-codex.new" "$BIN_DIR/claude-codex"
for file in "$temp/$name"/*; do
  [ "$(basename "$file")" = claude-codex ] || cp "$file" "$SHARE_DIR/"
done

# Смоук отдельной командой: сбой подстановки внутри аргумента echo `set -e` не прерывает.
installed_version=$("$BIN_DIR/claude-codex" --version) || fail "installed binary does not run: $BIN_DIR/claude-codex"
echo "Installed $BIN_DIR/claude-codex ($installed_version)"
echo "License notices: $SHARE_DIR"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "Note: $BIN_DIR is not in PATH; add it to your shell profile." ;;
esac
echo 'Claude Code must be installed separately (claude in PATH). Next: claude-codex auth login'
