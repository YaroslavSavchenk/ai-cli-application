# Q17 — When WSL goes down: a notice that says what happened, one button that starts everything again, and the sessions resumed

Status: LANDED 2026-11-24 (P1 backend, P2 host `relaunch`, P3 browser; gate 4811/4811, mutation probe 112 mutants, /verify-terminal 1–8, 10, 12 pass; the user's Windows checks — § Final gate — still open); earlier: DECIDED 2026-11-24 (the user's answers the same day, below).

Part Q17 of `.claude/plans/PLAN-QUALITY.md`. Conventions: `.claude/plans/README.md`.
Q16 (the OOM order inside WSL) is its sibling and has no spec of its own.

## Why

2026-11-24 12:53 a session in another project ran 16 agents with heavy
python backtests (13 processes, ~14.4 GB RSS, swap full). WSL hit a global
OOM, powered off 31 s later, and took the backend and the pty-host with it
(`server.log`: `received SIGTERM, shutting down: sessions=3 presence=1`;
`journalctl -b -1 -k`: `Out of memory: Killed process 46783 (python)
… anon-rss:2796156kB`; then `The system will power off now!`). The window
said `Offline`, the Restart dialog said "The backend did not come back. Close
this window and start the app again from the desktop shortcut", and nothing
told the user WHY. Outside the app the user raised `.wslconfig` to 24 GB and
installed `earlyoom`; this part is the app's half.

## The user's decisions (2026-11-24)

1. Planned as Q16 + Q17 in this master plan (not a Nocturne part).
2. **The button restarts WSL + the backend, reloads the window, and every
   session that was running comes back resumed** — automatically, no second
   question. (The pty-host cannot keep PTYs through a dead VM; resume is the
   only way back. `memory/decisions/pty-host-session-survival.md` rejected
   resume-restore as the way to survive a RESTART — that stays; this is the
   VM-death case D9 cannot cover.)
3. The notice names what happened ("WSL ran out of memory at 12:53 — python
   (2.8 GB) was killed").

## Orchestrator's defaults (named here, not asked — change on the user's word)

- A launch from the desktop shortcut after such a stop (no button pressed)
  shows the same notice with a `Resume N sessions` button instead of
  resuming by itself — a Windows reboot also stops WSL, and a silent mass
  resume on every boot is not what decision 2 asked for.
- Outside the WebView2 host (Edge `--app` fallback) there is no host to
  restart anything: the panel says to start the app from the desktop
  shortcut, and the next launch shows the notice with the resume button.
- What counts as "was running": the sessions live at the moment the backend
  received a signal while at least one window was open. A stop after the
  window closed (presence grace) or an app restart/update is NOT an
  unexpected stop and shows nothing.

## Pieces (phases)

### P1 — backend (`backend-pty`)

1. **Exit record.** On every shutdown path the backend writes
   `<dataDir>/last-exit.json` (0600, atomic, via the existing `atomicWriteFile`):
   `{ at: ISO, startedAt: ISO, why: 'signal' | 'presence-grace' | 'restart' | 'other', signal?: 'SIGTERM'|'SIGHUP'|'SIGINT', presence: number, sessions: string[] }`
   — `sessions` = the HISTORY ids of the sessions live at that moment (ids only:
   never argv, cwd or names). Written BEFORE sessions are destroyed. A restart
   /update handoff writes `why: 'restart'` (or nothing — the child's boot must
   not read it as unexpected; pick the simpler, test it). Read back
   FIFO-safe (`readSmallRegularFile`); a bad file is set aside like the other
   data-dir files, never thrown.
2. **The verdict at boot.** `server/previous-exit-model.ts` (pure) +
   a reader. "Unexpected" = `why === 'signal'` with `presence > 0`, OR no
   `last-exit.json` newer than the previous run while history entries were
   stamped `crash` at this boot (a hard kill: the record never got written).
   Cause, in order:
   - **`oom`** — the VM booted after the exit (`/proc/stat` `btime` > `at`)
     and `journalctl -b -1 -k -o short-iso --no-pager -g "Out of memory: Killed process"`
     (spawned with argv, NO shell, 5 s timeout, output capped at 64 KiB)
     has a line within `[startedAt, at + 60 s]`: detail = the killed
     process's NAME (`comm`, ≤ 32 chars, sanitised to `[A-Za-z0-9._-]`) and its
     anon-rss in MB. Several lines → the largest.
   - **`wsl-stopped`** — the VM booted after the exit, no OOM line (or the
     journal is unreadable: no `adm`/`systemd-journal` group, no systemd).
   - **`stopped`** — a signal with presence, VM still the same boot.
   - **`crash`** — the hard-kill case above.
   One `info` line in `server.log` with the verdict (cause, time, counts —
   the killed process's name is fine, it is not a secret; never argv).
3. **Routes** (authed like every `/api/*`, JSON, same error shapes as the
   history routes):
   - `GET /api/previous-exit` → `200 { at, cause, detail: { process, rssMb } | null, sessions: number }`
     or `204` when there is nothing to tell.
   - `POST /api/previous-exit/resume` → resumes every listed history id that
     is still resumable (the same path as `POST /api/history/:id/resume`:
     `resumeSpawn`, the 409 for a live conversation, the D9 single-flight)
     and answers `200 { resumed: [{ historyId, session: SessionInfo }], failed: [{ historyId, error }] }`.
     Idempotent: a second call resumes nothing new. Body ignored (≤ 1 KiB).
   - `POST /api/previous-exit/dismiss` → `204`; the notice is gone for good
     (the record is marked seen, not deleted — the log keeps the history).
   The record is consumed by resume or dismiss; the next clean run writes a
   new one anyway.
4. **Q16 lives here too** (see the master plan's Q16 bullet).

### P2 — Windows host + launcher (`wsl-launcher`)

1. **One new page→host message: exactly `relaunch`** (no arguments, no
   path, ordinal compare; origin-locked like `copy-files`; anything else
   ignored). The host:
   - runs the SAME launcher that started it (path known to the host or to
     `launch.ps1`, never from the page; installed and clone layouts both;
     a dev instance relaunches the dev instance — `--dev-instance` and its
     `AI_SM_DATA_DIR` carried over, NEVER the installed app's data dir —
     see `memory/decisions/native-webview2-host.md` and the D9 P5 `-Stop`
     incident) in its normal attach-or-start mode. `wsl.exe` boots a stopped
     VM by itself; `Start-Backend` + `Wait-ForHealthy` already exist.
   - single flight: a second `relaunch` while one runs is ignored.
   - when the new window is up (the existing ready sentinel), this window
     closes. A failure (launcher exit ≠ 0, timeout 120 s) posts
     `relaunch-failed` back to the page and keeps the window open.
   - `host.log`: one line per relaunch (start, outcome), no URL, no token.
2. The launcher must not open a SECOND window when a host for the same data
   dir is already open and about to close — check how the sentinel and the
   host's single-instance behaviour work today and say what you chose.
3. Never run `launch.ps1 -Stop` from WSL against the default data dir (see
   the incident). Real Windows checks go to the user's manual list.

### P3 — browser (`terminal-ui`, after P1; `/frontend-designer` applies)

1. **Offline panel.** When the backend has been unreachable for 10 s
   (health/WS reconnects failing; not during the app's own restart or
   update flow) a panel replaces the `Offline` pill alone: title "The app
   stopped responding", one line ("WSL or the background service stopped."),
   primary button `Restart` (in the host) → stores a recover flag in
   `localStorage` (`aism.recover` = epoch ms; try/catch) and posts
   `relaunch`; it shows `Restarting…` until the window is replaced or
   `relaunch-failed` arrives (then: the error line + the shortcut advice).
   Outside the host: no button, the shortcut advice. The Restart-service
   dialog's "did not come back" state gets the same `Restart` button in the host.
2. **Notice at boot.** `GET /api/previous-exit`; on `200`:
   - recover flag set and < 10 min old → `POST /api/previous-exit/resume`
     at once, clear the flag;
   - otherwise → the notice offers `Resume N sessions` + `Dismiss`.
   Copy by cause (English, like the rest of the UI):
   `oom` "WSL ran out of memory at 12:53 — python (2.8 GB) was stopped, and WSL shut down." ·
   `wsl-stopped` "WSL shut down at 12:53." · `stopped` "The app was stopped at 12:53." ·
   `crash` "The app stopped unexpectedly at 12:53."
   After a resume: "3 sessions resumed" (+ "1 could not be resumed" when
   `failed` is non-empty).
3. **The resumed sessions take the old ones' places** in the tabs and
   panes (layout in `localStorage` keyed by session id → remap
   old id → new id from the `resumed` answer; the history id ↔ old session
   id link is what the backend gives or what the layout already stores —
   find it and say). A session that failed leaves its pane in the normal
   "ended" state. *(As built: the boot prunes dead session ids before the
   resume answer arrives, so a failed one has no pane to keep — it is gone
   from the tabs and stays in History, like any session of a dead backend.
   The remap key is `previousSessionId`, not `historyId`.)*

## Test gate

- P1: model tests for every verdict branch (signal+presence, presence-grace,
  restart, no record + crash stamps, btime before/after, OOM line inside /
  outside the window, unreadable journal, several OOM lines, hostile `comm`);
  the journal runner behind a seam (no real `journalctl` in tests); route
  tests (204, 200 shape, resume idempotent, 409 live, dismiss); the record
  written on SIGTERM with presence (real backend test, existing helpers).
- P2: PowerShell/C# pieces the suite can check (message parsing is C#: keep
  the parse in a function the existing host tests style can reach, or a
  `tests/launcher/` static check like the existing ones); the rest is the
  user's Windows checklist.
- P3: model tests for the panel timing, the flag age, the remap; DOM tests
  as the existing `web/` tests do.
- Final: full suite, `tsc`, `npm run build`; `/verify-terminal` only for the
  remap/replay seam.

## Final gate (manual, Windows — the user)

1. `wsl --shutdown` from PowerShell with the app open → panel within ~10 s →
   `Restart` → new window, notice "WSL shut down at …", sessions back in
   their panes.
2. Shortcut launch after a `wsl --shutdown` with the window closed first →
   nothing shown (presence 0). With the window open, then close it after the
   stop, then shortcut → notice with `Resume N sessions`.
3. Dev instance `Restart` relaunches the DEV instance only.
