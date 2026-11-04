#!/usr/bin/env bash
# PostToolUse-хук: после правки файла гоняет линтеры по нему одному.
#
# Ловит и Edit/Write (`tool_input.file_path`), и Bash (`tool_input.command`):
# при работе через `sed -i` / heredoc / скрипты правка идёт мимо file_path,
# поэтому пути вытаскиваются из самой команды. Чтобы не линтовать файлы,
# которые команда только читала (`cat`, `grep`), из кандидатов остаются лишь
# изменённые за последние MTIME_WINDOW секунд.
#
#   .ts           → eslint + tsc по проекту
#   .js .mjs .cjs → eslint
#
# vendor/ccr не линтуется: это исходники upstream байт в байт.
#
# Автофикс намеренно не применяется: хук только сообщает, переписывать файл
# за спиной агента он не должен.
#
# Коды возврата:
#   0 — всё чисто или только warnings / tsc-ошибки в чужих файлах.
#   1 — сам линтер/компилятор не запустился (нет бинарника, unparseable output).
#   2 — есть errors в ПРАВЛЕННОМ файле (блокирует и возвращает вывод агенту).

set -uo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "[lint-hook] jq не найден в PATH. Установите: brew install jq (macOS) / apt install jq (Linux)." >&2
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TSC_CACHE="node_modules/.cache/claude-tsc.tsbuildinfo"
TSC_TIMEOUT=90
ESLINT_TIMEOUT=60
# Потолок печатаемых замечаний, чтобы большой файл не залил контекст.
LINT_MAX_LINES=80
# Окно, в котором правка Bash-командой считается свежей (сек).
MTIME_WINDOW=180

# macOS-совместимый таймаут через perl (timeout(1) нет в BSD по умолчанию).
# Печатает stdout+stderr команды; rc=124 при таймауте.
run_with_timeout() {
  local timeout="$1"; shift
  perl -e '
    use strict; use warnings;
    my $timeout = shift; my @cmd = @ARGV;
    my $pid = fork();
    if (!defined $pid) { die "fork failed"; }
    if ($pid == 0) { exec @cmd; die "exec failed"; }
    local $SIG{ALRM} = sub { kill "TERM", $pid; sleep 1; kill "KILL", $pid; exit 124; };
    alarm $timeout;
    waitpid($pid, 0);
    exit($? >> 8);
  ' "$timeout" "$@" 2>&1
}

input="$(cat)"

# Абсолютный путь → rel внутри репозитория; пустая строка, если файл вне репо,
# не существует или лежит в игнорируемых каталогах.
to_rel() {
  local abs="$1"

  case "$abs" in
    "$REPO_ROOT"/*) ;;
    *) return 0 ;;
  esac

  [ -f "$abs" ] || return 0

  local rel="${abs#"$REPO_ROOT"/}"

  case "$rel" in
    node_modules/*|dist/*|vendor/*|artifacts/*|.work/*) return 0 ;;
  esac

  printf '%s\n' "$rel"
}

collect_from_file_path() {
  local file_path
  file_path="$(jq -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null)"
  [ -z "$file_path" ] && return 0

  case "$file_path" in
    /*) to_rel "$file_path" ;;
    *)  to_rel "$REPO_ROOT/$file_path" ;;
  esac
}

# Пути из тела Bash-команды. Расширение отсекает мусор вроде `git status`,
# окно по mtime — файлы, которые команда только читала.
collect_from_command() {
  local command
  command="$(jq -r '.tool_input.command // empty' <<<"$input" 2>/dev/null)"
  [ -z "$command" ] && return 0

  local now candidate abs
  now="$(date +%s)"

  while IFS= read -r candidate; do
    [ -z "$candidate" ] && continue

    case "$candidate" in
      /*) abs="$candidate" ;;
      *)  abs="$REPO_ROOT/$candidate" ;;
    esac

    local rel mtime
    rel="$(to_rel "$abs")"
    [ -z "$rel" ] && continue

    mtime="$(stat -f %m "$abs" 2>/dev/null || stat -c %Y "$abs" 2>/dev/null)"
    [ -z "$mtime" ] && continue
    [ "$((now - mtime))" -gt "$MTIME_WINDOW" ] && continue

    printf '%s\n' "$rel"
  done < <(grep -oE '[A-Za-z0-9_@./~-]+\.(ts|js|mjs|cjs)' <<<"$command")
}

files="$({ collect_from_file_path; collect_from_command; } | awk 'NF && !seen[$0]++')"
[ -z "$files" ] && exit 0

cd "$REPO_ROOT"

had_error=0

run_eslint() {
  local bin="node_modules/.bin/eslint"

  if [ ! -x "$bin" ]; then
    echo "[eslint-hook] eslint binary not found at $bin, skipping" >&2
    return 1
  fi

  local raw rc
  raw="$(run_with_timeout "$ESLINT_TIMEOUT" "$bin" --format json "$rel")"
  rc=$?

  if [ "$rc" -eq 124 ]; then
    echo "[eslint] timed out after ${ESLINT_TIMEOUT}s — линт не проверен" >&2
    return 0
  fi

  if [ -z "$raw" ]; then
    echo "[eslint-hook] empty output for $rel (linter likely crashed)" >&2
    return 1
  fi

  local errors warnings
  errors="$(jq -r '[.[].messages[]? | select(.severity==2)] | length' <<<"$raw" 2>/dev/null)"
  warnings="$(jq -r '[.[].messages[]? | select(.severity==1)] | length' <<<"$raw" 2>/dev/null)"

  if [ -z "$errors" ] || [ -z "$warnings" ]; then
    echo "[eslint-hook] unparseable JSON output for $rel:" >&2
    echo "$raw" | head -c 500 >&2
    return 1
  fi

  if [ "$errors" -gt 0 ] || [ "$warnings" -gt 0 ]; then
    echo "[eslint] $errors error(s), $warnings warning(s) in $rel:" >&2
    jq -r --arg file "$rel" '
      .[].messages[]? |
      "\($file):\(.line):\(.column) \(if .severity==2 then "error" else "warn" end) \(.message) [\(.ruleId // "?")]"
    ' <<<"$raw" | head -"$LINT_MAX_LINES" >&2
  fi

  [ "$errors" -gt 0 ] && had_error=1
  return 0
}

# tsc -p tsconfig.json (noEmit — в самом tsconfig) c инкрементальным кэшем.
# Блокируем только ошибки в правленых файлах; ошибки в других файлах (в том числе
# в vendor/ccr, который tsc проверяет транзитивно) — предупреждения, чтобы агент
# не застрял на "долгах" существующего кода.
# Запускается один раз на всю правку: tsc и так проверяет проект целиком.
run_tsc() {
  local bin="node_modules/.bin/tsc"

  if [ ! -x "$bin" ]; then
    echo "[tsc-hook] tsc binary not found at $bin, skipping" >&2
    return 1
  fi

  mkdir -p "$(dirname "$TSC_CACHE")"

  local raw rc
  raw="$(run_with_timeout "$TSC_TIMEOUT" \
    "$bin" -p tsconfig.json \
           --incremental --tsBuildInfoFile "$TSC_CACHE" \
           --pretty false)"
  rc=$?

  if [ "$rc" -eq 124 ]; then
    echo "[tsc] timed out after ${TSC_TIMEOUT}s — типы не проверены" >&2
    return 0
  fi

  # tsc rc=0 — чисто; rc=1/2 — есть ошибки (в stdout); остальные rc — запуск не удался
  if [ "$rc" -ne 0 ] && [ "$rc" -ne 1 ] && [ "$rc" -ne 2 ]; then
    echo "[tsc-hook] tsc crashed (exit $rc):" >&2
    echo "$raw" | head -c 500 >&2
    return 1
  fi

  [ -z "$raw" ] && return 0

  # Строки вида: path/to/file.ts(line,col): error TSxxxx: message
  local list errors_here errors_other
  list=":$(tr '\n' ':' <<<"$ts_files")"
  errors_here="$(awk -v files="$list" -F'[()]' '/: error TS[0-9]+:/ && index(files, ":" $1 ":")' <<<"$raw")"
  errors_other="$(awk -v files="$list" -F'[()]' '/: error TS[0-9]+:/ && !index(files, ":" $1 ":")' <<<"$raw")"

  if [ -n "$errors_here" ]; then
    local n
    n=$(wc -l <<<"$errors_here" | tr -d ' ')
    echo "[tsc] $n error(s) в правленых файлах:" >&2
    echo "$errors_here" >&2
    had_error=1
  fi

  if [ -n "$errors_other" ]; then
    local n
    n=$(wc -l <<<"$errors_other" | tr -d ' ')
    echo "[tsc] $n error(s) in ДРУГИХ файлах (правку не блокирует):" >&2
    echo "$errors_other" | head -30 >&2
  fi

  return 0
}

ts_files=""

while IFS= read -r rel; do
  case "${rel##*.}" in
    ts)
      run_eslint
      ts_files="${ts_files}${rel}"$'\n'
      ;;
    js|mjs|cjs)
      run_eslint
      ;;
  esac
done <<<"$files"

[ -n "$ts_files" ] && run_tsc

[ "$had_error" -eq 1 ] && exit 2
exit 0
