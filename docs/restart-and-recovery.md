# Restarting the backend, and recovery after WSL stops

Two ways the background service is replaced: on purpose, by the restart
(after an update or on request), and after WSL itself went down. Sessions are
held by a separate process, the pty-host, so a restart keeps them; a stopped
WSL virtual machine ends them, and the app brings them back by resuming them.

## Restarting the backend

Settings → Background service → `Restart service` replaces the running backend
with a fresh one on the same port, without closing the window. The app also
watches for a newer version on disk — changed dependencies, a new commit, a
missing or rebuilt frontend build, frontend sources newer than the build being
served, or an edited server file — and offers the same restart through a notice
and a small `update` mark in the top bar.

What happens, in order. Nothing is torn down until a replacement has been
proven, so a restart that cannot succeed leaves the running backend exactly as
it was — same process, same sessions, same screens:

1. **dependencies** — if `node_modules` is missing or older than
   `package-lock.json`, the restart is refused and asks you to install them
   yourself (never automatically: `node-pty` is a native module and an install
   runs lifecycle scripts);
2. **the frontend is rebuilt** into `web/dist-next` with the project's own
   vite and verified (`index.html`, the entry bundle, `build-id.json`). It is
   only staged there — the old build keeps being served — so a failed build is
   refused with `web/dist` untouched. This is what makes a restart after a
   `git pull` serve the new UI;
3. **a standby backend** is started, boots completely — everything except
   binding the port — and reports in. A replacement that fails to boot is
   refused here. Until it says `go` that process writes nothing at all: the
   data dir still belongs to the backend that is serving;
4. **only then is the new frontend swapped in** (`web/dist` → `web/dist-prev`,
   `web/dist-next` → `web/dist`), so new screens never end up in front of the
   old backend. A served directory is only moved aside when it looks like a
   frontend build (an `index.html` plus its entry bundle); anything else is
   refused with nothing renamed. A swap that fails puts the old build back,
   stops the standby and refuses too.

Only then does the old process let go of every running session — it detaches
from the session holder (the pty-host process that owns the terminals) without
ending anything or stamping `history.json` — close its listener, tell the
standby to take the port, wait until that one answers `/health`, and answer the
browser and exit. The new backend takes every session over before it listens:
same id, same process, same scrollback. The standby checks during its own boot
whether it CAN take the session holder over; when it cannot (another
protocol), or the sessions run inside the backend itself (no session holder
could be started), the restart is refused before anything moves and the UI
asks again. Only after that second "yes" are the sessions ended, each one
stamped `shutdown` in `history.json`, so it can be resumed from the Sessions
panel's Earlier list.

The route is `POST /api/restart` (same token and Origin/Host check as every
other `/api` route). It answers `202` with the new port once the replacement
is healthy, `409` when a restart is already running, `409 { error, code:
'sessions-would-end' }` when the running sessions cannot be kept this time,
`422` when one of the four steps above refused (**the old backend is untouched
and still serving** after either refusal), `500` when the replacement failed
after the handoff had begun, and `503` in a process with no restart mechanism
wired. The one body it reads is optional: `{ "endSessions": true }` is the
"Restart anyway" that lets sessions which cannot be kept end; anything other
than `{}` or that shape is refused with `400`. A refused restart also leaves
`web/dist-next` removed.

A failed handoff is **not** a rollback: past the fourth step the sessions are
already handed over (or ended, after "Restart anyway") and the listener is
already closed, so the old process exits
either way and the app asks you to start it again from the desktop shortcut.
That window is now as small as "the replacement booted but could not bind".

## Environment variables

Three environment variables belong to this handoff only — the app sets them on
the process it starts, and there is no reason to set them by hand:

- `AI_SM_PORT_HINT` — the port the replacement should try first (1-65535); a
  taken port falls back once to an auto-picked one, and the UI then says the
  window has to be relaunched
- `AI_SM_RESTARTED_FROM` — the pid of the process being replaced, written to
  `server.log` so the two runs read as one story
- `AI_SM_STANDBY` — set to `1` on the standby: it boots but does not listen
  until the old process hands the port over, and until then it does not write
  in the data dir at all. Without a parent it exits by itself (immediately if
  the parent goes away, otherwise 30 seconds after it reported ready)

One more variable belongs to the same machinery: `AI_SM_WEB_DIST_DIR`
(absolute path, default `web/dist` in the repo) moves the built frontend the
server SERVES, and with it the `-next`/`-prev` directories a restart renames.
It exists so the tests can drive a real restart against a copy instead of
rebuilding the repo's own `web/dist`; leave it unset otherwise. A value that is
relative, ends in a separator, holds a `.` or `..` segment, or is the root
makes the server refuse to start, much like `AI_SM_DATA_DIR`. Sessions never
inherit it, or any of the three variables above.

## When the backend crashes

Since the pty-host holds the terminals (Nocturne D9), a crash of the backend
alone does not end the sessions: the pty-host keeps them running for up to 10
minutes, and the next backend that starts — from the desktop shortcut —
adopts them: same ids, same processes, same scrollback. Only a session whose
pty-host is gone is stamped `crash` in `history.json`, and it can be resumed
from the Sessions panel's Earlier list.

## After WSL stops

A stopped WSL virtual machine — out of memory, or `wsl --shutdown` — takes
the backend, the pty-host and every session with it; nothing inside Linux can
survive that. Since v0.4.6 the app says why it happened and brings the
sessions back by resuming them (spec: `.claude/plans/quality/PLAN-Q17.md`).

**Memory pressure hits a session first.** Every process a session starts gets
an `oom_score_adj` of 500 right after spawn, so when WSL runs short of memory
the kernel stops a process inside a session before the backend or the
pty-host, which keep their inherited value.

**The app remembers how it stopped.** Every shutdown path first writes
`last-exit.json` to the data dir (see [app-data.md](app-data.md)): why it
stopped, the open windows, the kernel boot id and the history ids of the
sessions running then — ids only, never commands, folders or names. The next
boot judges that record. An unexpected stop is a `signal` record while a
window was open, or crash stamps with no newer record. The cause is one of:

- `oom` — the virtual machine rebooted and the previous boot's kernel log has
  an `Out of memory: Killed process` line in the run's window; the largest
  kill names the process and its size. Shown as, for example, "WSL ran out of
  memory at 12:53 — python (2.7 GB) was stopped, and WSL shut down.";
- `wsl-stopped` — the virtual machine rebooted, with no such line (or a
  kernel log it could not read): "WSL shut down at 12:53.";
- `stopped` — "The app was stopped at 12:53.";
- `crash` — "The app stopped unexpectedly at 12:53."

The kernel log is read only after a reboot, with one `journalctl` call (argv
only, 5 s, 64 KiB at most); `server.log` gets one `info` line with the verdict.

**One Restart button.** When the background service stays unreachable for
10 seconds — not during the app's own restart or update — the window shows a
panel, "The app stopped responding", with `Restart`. In the app's own window
(the WebView2 host) `Restart` re-runs the launcher that started that window:
it starts WSL and the service again and opens a fresh window, which then
resumes every session that was running at once and says "N sessions resumed".
The same button appears when Restart service ends with "did not come back".
Outside the host window, or when the relaunch fails, the panel says to close
the window and start the app again from the desktop shortcut. The button needs
the window that came with v0.4.6, so it works from the first time the app is
started from the desktop shortcut after that update.

**Resume, or Dismiss.** A start from the desktop shortcut does not resume by
itself: the window shows the cause sentence with `Resume N sessions` and
`Dismiss`. Resumed sessions come back in their old tabs and panes; a session
that cannot be resumed stays in History. An unread notice repeats until it is
resumed, dismissed or superseded by a newer stop; either answer marks the
record `seen`, and it is never deleted.

The routes behind it: `GET /api/previous-exit` (`200 { at, cause, detail,
sessions }`, or `204` when there is nothing to tell), `POST
/api/previous-exit/resume` (the history resume path, one session at a time;
idempotent — a second call gets empty lists; each item carries
`previousSessionId`, the key that puts it back in its old place) and `POST
/api/previous-exit/dismiss` (`204`).

If the app "crashed" for no visible reason, check whether WSL itself ran out
of memory first: the previous boot's kernel log (`journalctl -b -1 -k`) says
so, and other heavy work inside the same WSL counts against the same memory.
