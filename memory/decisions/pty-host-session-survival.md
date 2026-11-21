---
type: decision
created: 2026-11-20
updated: 2026-11-21
tags: [nocturne, d9, sessions, restart, update, pty-host]
---
# Sessions survive an update: the pty-host (part D9, decisions 25–27)

**Status:** decided 2026-11-20 (user: "ik wil dat wnr een update is de
sessies niet afgesloten hoeven te worden … na de update alles gewoon
open"). Reverses "Sessions do NOT survive a restart" of
[[backend-restart-same-port]] (done in P4, 2026-11-21).

- **Approach:** a separate long-lived **pty-host** process per data dir owns
  the PTYs (raw ring with offsets, rescue, kill ladder, exit record, opaque
  metadata); the backend keeps all interpretation and re-attaches over a
  0600 unix socket with a token handshake. Rejected: resume-based restore
  (a running turn is interrupted, shells lose state) and tmux under every
  session (sits between the app and the CLI; extra dependency).
- **25 — window closed:** sessions still end after the grace
  ([[lifecycle-bound-backend]] stands).
- **26 — backend crash:** the pty-host waits 10 minutes for a backend to
  re-attach, then ends the sessions.
- **27 — incompatible pty-host:** sessions end as today, with a warning in
  the dialog first ("Restart anyway"); History → resume.
- The first release carrying D9 cannot keep sessions through its own
  install (the old backend runs the update).

## State after P3 (2026-11-21)

- **Crash survival is live:** the backend starts the pty-host with the
  first session (`server/pty-host-broker.ts`) and adopts what it holds at
  boot, before listen (`server/index-ptyhost.ts`): same ids, same
  processes, scrollback, bells printed while no backend ran; a session that
  exited meanwhile ends as an exit. History stamps `crash` only for entries
  no pty-host holds. A pty-host found running only later (a boot connect
  that timed out) is adopted then, its `crash` stamps undone — the backend
  never owns PTYs it did not adopt.
- **In-process fallback** (one `server.log` line, no survival that run): a
  data dir not ours / not 0700 / socket path > 107 bytes, or a pty-host
  that cannot be started twice. `AI_SM_PTY_HOST=inproc` is the test seam
  (refused in installed mode).
- **An incompatible pty-host** (refuses our hello) is SIGTERMed by the pid
  in its state file once `/proc` proves it is ours; its sessions end
  (decision 27; the dialog warning is P4).
- **`crash` is now also a live end reason:** a pty-host lost under a running
  backend ⇒ each session's group probed and SIGKILLed, exit 137, history
  `crash`.
- **Taken over** (`bye taken-over`: another backend became the owner): the
  sessions are handed over — no history end, no exit frame; their sockets
  close 1012 and they leave this backend's list. P4's restart handoff
  builds on it.
- (P3 only — reversed by P4 below) restart and update still ended the
  sessions; the teardown ended the pty-host's sessions too.

## State after P4 (2026-11-21): restart and update keep the sessions

- **The teardown detaches** (`SessionManager.detachAll`): every session's
  blob is flushed with its current scan offset (so the next backend
  re-scans only the handoff gap and an acknowledged bell stays
  acknowledged), a spawn still in flight is killed and forgotten before the
  goodbye (the next backend must not adopt a session no history entry was
  written for — the P1 review's pending-spawn risk), then `detach`. No
  history stamp, no kill; the WebSockets close 1012 as before. In-process
  PTYs cannot be handed over: the broker ends them at the detach (only
  DELETE ladders can be left by then).
- **The standby probes** the pty-host during its preflight (role `probe`,
  `list-count`, 5 s) and reports `ptyHost: compatible|incompatible|none`
  in `standby-ready`. Any refusal of its hello (another protocol, an
  unknown token) is `incompatible`.
- **The one rule** (`server/restart.ts` `sessionsFate`): running sessions
  in-process, an `incompatible` pty-host, or `none` while sessions run ⇒
  the sessions would end. Unless the caller sent `endSessions: true`, that
  is `409 { error, code: 'sessions-would-end' }` before anything is torn
  down — in-process sessions before the build even starts, the others once
  the standby reported (the standby is stopped, the staged build dropped).
  No running session ⇒ never a 409. `endSessions` is a permission, not an
  order: sessions that can be kept are kept. When they end, they end like a
  shutdown (history `shutdown`, resumable) — decision 27.
- **Orchestrator default (within 27):** the in-process fallback with a
  running session also answers the 409 — those sessions cannot survive
  either, and the user must hear it before, not after.
- **The UI** keeps one dialog: the first question now says the sessions keep
  running ("One session is running. It keeps running, and this window
  reconnects to it."); a `sessions-would-end` answer brings the SAME dialog
  back as a second question — title "Restart and end the sessions?", body
  "This time the running session cannot be kept: restarting ends it. It
  stays in History …", the `--continue` resume note, button
  `Restart anyway` — and only that press re-posts with `endSessions: true`.
  After an update the install is already done; the second question is
  about the restart half only.
- **Route:** POST /api/restart reads one optional body (`{}` or
  `{ endSessions: boolean }`, JSON only, ≤ 1 KiB); anything else is 400 /
  413 / 415 before the mechanism is reached. Until P4 it read no body.
- `SocketPtyHost.pendingSpawns()` was deleted: the manager ends its own
  pending spawns at `detachAll` (its kill follows the spawn on the wire).
- Release note owed by the first release carrying D9: survival starts from
  the NEXT update — the backend that installs this one is the old one.

Spec `.claude/plans/nocturne/PLAN-D9.md`. Related: [[detached-backend]],
[[in-app-update]].
