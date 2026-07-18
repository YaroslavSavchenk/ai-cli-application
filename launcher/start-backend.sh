#!/usr/bin/env bash
# start-backend.sh - start the AI CLI Session Manager backend DETACHED.
#
# Invoked by launch.ps1 as:  wsl.exe -d <distro> -- bash -lc "<repo>/launcher/start-backend.sh <datadir>"
# ($1 arrives already tilde-expanded by that shell, i.e. absolute.)
#
# Lives on the Linux side so no nontrivial shell code has to survive the
# PowerShell -> wsl.exe -> default-shell quoting gauntlet.
#
# Responsibilities:
#   - resolve a Node >= 24: nvm installs are invisible to non-interactive
#     login shells (~/.bashrc returns before the nvm lines), so when the
#     PATH node is missing or too old, source nvm.sh explicitly;
#   - start the server in a NEW SESSION (setsid) with stdin/stdout/stderr
#     on /dev/null so it survives wsl.exe (and this shell) exiting - the
#     backend must never die with the launcher or window. The server logs
#     to $AI_SM_DATA_DIR/server.log itself.
#
# Exit codes (mapped to messages in launch.ps1):
#   0  started (detached; launcher polls runtime.json + /health for truth)
#   10 repo dir missing / cd failed
#   11 no usable node found (PATH and nvm both checked)
#   12 node found but older than 24
#   13 data dir argument not absolute after shell expansion

DATADIR="${1:-$HOME/.ai-session-manager}"
case "$DATADIR" in
  /*) ;;
  *)
    echo "start-backend.sh: data dir must be absolute after expansion, got: $DATADIR" >&2
    exit 13
    ;;
esac

REPO="$(cd "$(dirname "$0")/.." >/dev/null 2>&1 && pwd)" || exit 10
cd "$REPO" || exit 10

get_major() {
  command -v node >/dev/null 2>&1 || return 0
  node -p 'parseInt(process.versions.node, 10)' 2>/dev/null
}

MAJOR="$(get_major)"
case "$MAJOR" in '' | *[!0-9]*) MAJOR=0 ;; esac
if [ "$MAJOR" -lt 24 ]; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
  fi
  MAJOR="$(get_major)"
  case "$MAJOR" in '' | *[!0-9]*) MAJOR=0 ;; esac
fi
[ "$MAJOR" -gt 0 ] || exit 11
[ "$MAJOR" -ge 24 ] || exit 12

export AI_SM_DATA_DIR="$DATADIR"
# NOTE: foreground `setsid --fork`, deliberately NOT `setsid ... &`.
# On current WSL2, processes backgrounded with `&` through a
# `wsl.exe -- bash -lc` invocation are killed when that wsl.exe session is
# torn down (verified 2026-07-18: `setsid nohup sleep &` dies, with or
# without a wrapping subshell). With --fork in the foreground, this shell
# waits for the intermediate setsid parent, so by the time bash (and
# wsl.exe) exit, the server is already reparented to init in its own
# session - and survives.
setsid --fork nohup node server/index.ts </dev/null >/dev/null 2>&1
exit 0
