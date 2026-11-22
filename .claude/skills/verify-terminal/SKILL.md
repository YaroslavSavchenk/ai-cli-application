---
name: verify-terminal
description: End-to-end verification that terminal sessions behave like real terminals. Use after changing the PTY layer, WebSocket protocol, or xterm.js frontend, and before declaring any terminal-related feature done.
---

# Verifying terminal correctness

Read `.claude/PROJECT-SCOPE.md` for context. The hosted CLIs are full TUIs;
"the text appears" is not a pass. A session passes only if it is
indistinguishable from a native terminal. Run every check below against a
live session (backend running, session open in the UI) — checks 10–12 when
the PTY layer, the pty-host, restart/update or adopt changed, and check 11 is
a step for the user on Windows (report it as handed over, not as passed).
Report each check as pass/fail — never skip and assume.

The backend tries its last port first and auto-picks when taken — read it from the runtime discovery file
(`~/.ai-session-manager/runtime.json`) or the backend's startup output;
never assume a fixed one.

## Checks

1. **Echo & colors** — in the session run:
   `printf '\e[31mred \e[32mgreen \e[1mbold\e[0m normal\n'`
   Colors and bold render; reset works.
2. **Raw keys reach the app** — run `vim`, press `i`, type, `Esc`, `:q!`.
   Then run a long `sleep 100` and press Ctrl+C: the *sleep* dies, not the
   backend or the WebSocket. Arrow keys recall shell history.
3. **Alt screen** — open `vim` or `htop`, then quit. The previous scrollback
   is restored intact (alt-screen enter/exit works).
4. **Resize propagation** — with `htop` running, resize the pane (drag
   divider or switch layout). htop reflows to the new size with no torn
   rows. Then `echo $COLUMNS` must match the pane width. Repeat after
   moving the session to a different-sized pane slot.
5. **Disconnect survival** — start `for i in $(seq 300); do echo $i; sleep 1; done`,
   close the browser tab entirely, wait ~10s, reopen. The session is still
   counting and recent scrollback is shown (state lives server-side).
6. **Hidden-pane survival** — switch to another tab for ~30s while a command
   runs; switch back: output is complete, no frozen or duplicated frames.
7. **Attention signal** — run `sleep 2; printf '\a'`, switch tabs before it
   fires. The tab/pane shows the attention badge.
8. **Stress render** — run `find / 2>/dev/null | head -5000` and rapidly
   switch layouts during output. No garbage characters, no crash, scrollback
   stays bounded.
9. **The real thing** — launch an actual `claude` session from a project
   entry, confirm the TUI draws correctly, responds to keys, and its
   permission prompt (standard mode) is usable.

### Sessions survive a restart (Nocturne D9)

Run these on a dev backend you started yourself on its OWN short data dir
(e.g. `mktemp -d /tmp/d9-XXXX`, mode 0700): the pty-host socket path must
stay ≤ 107 bytes, or the backend falls back in-process and Restart answers
409 `sessions-would-end` by design. Record every pid you start (backend,
`pty-host.json` pid, browser) and kill only those.

10. **Restart mid-output** — in one session run a counter that never stops
    (`echo "pid $$"; i=0; while :; do echo "tick $i"; i=$((i+1)); sleep 0.02; done`),
    keep a shell open in a second one (`echo "pid $$"`), then press
    Settings → Background service → Restart service (or `POST /api/restart`).
    Pass only if: (a) the same session ids are `running` afterwards; (b) the
    SAME pids, still children of the same pty-host (`/proc/<pid>/status`
    PPid = `pty-host.json` pid); (c) `server.log` has one `session <id>
    adopted: pid <n>, <k> byte(s) re-scanned` line per session; (d) no lost
    bytes: a fresh attach's replay starts at offset 0 (the `pid` line, ring
    not wrapped) and is byte-identical to `pid N` + `tick 0..last` — no gap,
    no duplicate across the handoff; (e) after a full PAGE RELOAD the pane
    repaints and keeps counting, rows contiguous, past the pre-restart tick.
11. **Claude mid-turn survives Update** — needs a real Claude and an
    installed build, so it is a Windows step for the user: start a Claude
    session, give it a task that runs for a minute, and while it works press
    Update (or Restart service). Pass: the window reconnects to the same
    pane, Claude finishes the turn it was in (no resume, no new
    conversation), the status line still draws. After the NEXT Setup (which
    prunes the old version dir) the status line of that same session still
    draws (it runs through `<app>/current`).
12. **Resize after re-attach reaches the same PTY** — after check 10's
    restart and reload, in the shell pane run
    `clear; printf '%400s\n' '' | tr ' ' x; echo "SZ $(stty size) PID $$"`:
    `stty size` equals the pane (rows = visible rows, cols = a full `x` row)
    and `PID` is the pre-restart shell pid. Resize the pane (or the window),
    run it again: the new size arrives, same PID.

Headless driving from WSL (when no human runs the UI): Playwright's
Chromium in `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome` with
`--headless=new --no-sandbox --disable-gpu --disable-3d-apis` (no WebGL ⇒
xterm's DOM renderer, so `.xterm-rows` is readable), raw CDP over the
repo's `ws`; take a `Page.captureScreenshot` before reading rows (headless
throttles rAF); tabs activate through their `.tab-sel` button;
`Emulation.setDeviceMetricsOverride` resizes for check 12.

**Never drive `launcher/launch.ps1` (any switch) from WSL with the data dir
passed through `WSLENV`** — `AI_SM_DATA_DIR/u` is Win32 → WSL only, the
launcher falls back to `~/.ai-session-manager` and `-Stop` kills the
user's INSTALLED backend (happened twice, 2026-11-21/22). Set it INSIDE
PowerShell, and prove it with `-Status` before any `-Stop`. This is a BASH
command line: `\$env` and `\$LASTEXITCODE` are escaped so bash hands them to
PowerShell untouched (an unescaped `$env` inside bash double quotes expands to
nothing, and PowerShell never sees the assignment — the same incident again):

```bash
D=/tmp/d9-XXXX                                  # YOUR scratch data dir
WIN=$(wslpath -w launcher/launch.ps1)
ps1() { powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \
  "\$env:AI_SM_DATA_DIR='$D'; & '$WIN' $1; exit \$LASTEXITCODE"; }
OUT=$(ps1 -Status); printf '%s\n' "$OUT"
case $OUT in
  *"$D/runtime.json in '"*) ;;                  # names YOUR dir: go on
  *) echo 'ABORT: -Status did not name the scratch dir'; exit 1 ;;
esac
case $OUT in *.ai-session-manager*) echo 'ABORT: default data dir'; exit 1 ;; esac
ps1 -Stop
```

Record the installed backend's pid first (`~/.ai-session-manager/runtime.json`,
read only) and check it is still alive after every PowerShell step.

## On failure

Fix and re-run the FULL list (as scoped at the top), not just the failed
check — resize and alt-screen bugs love to regress each other. In your report, state which
checks ran, on which layout(s), and paste failing output verbatim.
