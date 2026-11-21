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
[[backend-restart-same-port]] once D9 P4 lands.

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
- Restart and update still END sessions in P3 (P4 changes that); the
  teardown ends the pty-host's sessions too.

Spec `.claude/plans/nocturne/PLAN-D9.md`. Related: [[detached-backend]],
[[in-app-update]].
