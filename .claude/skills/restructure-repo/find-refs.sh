#!/usr/bin/env bash
# find-refs.sh — list every textual reference to a path that is about to move.
#
#   .claude/skills/restructure-repo/find-refs.sh <old-path> [<old-path>...]
#
# Per path it searches all TRACKED files (plus the untracked, non-ignored ones)
# for: the full repo-relative path, the path relative to each ancestor folder
# (how a sibling cites it), and — for markdown — the [[wikilink]] basename.
# Read-only. Exit 0 = no references anywhere, 1 = references found, 2 = usage.
#
# It finds text only. References from OUTSIDE the repo (Windows shortcut,
# Obsidian, settings.local.json, .git/info/exclude) are SKILL.md § 2 class 8.
set -euo pipefail

if [ "$#" -eq 0 ]; then
  echo "usage: find-refs.sh <repo-relative-path>..." >&2
  exit 2
fi

root="$(git rev-parse --show-toplevel)"
cd "$root"

found=0

search() { # $1 = label, $2 = fixed string, $3 = path to leave out of the hits
  local hits
  hits="$(git grep -nIF --untracked -e "$2" -- . ":(exclude)$3" 2>/dev/null || true)"
  if [ -n "$hits" ]; then
    found=1
    printf '  [%s] %s\n' "$1" "$2"
    printf '%s\n' "$hits" | sed 's/^/    /'
  fi
}

for target in "$@"; do
  target="${target#./}"
  target="${target%/}"
  printf '== %s\n' "$target"
  if [ ! -e "$target" ]; then
    printf '  (not on disk — searching anyway: useful AFTER a move)\n'
  fi

  search 'full path' "$target" "$target"

  # Relative forms: strip leading segments one at a time, stop before a bare
  # basename (searched separately below, because it is the noisiest form).
  rest="$target"
  while [[ "$rest" == */*/* ]]; do
    rest="${rest#*/}"
    search 'relative' "$rest" "$target"
  done

  base="$(basename "$target")"
  case "$base" in
    *.md)
      search 'wikilink' "[[${base%.md}" "$target"
      ;;
  esac
  search 'basename' "$base" "$target"
done

exit "$found"
