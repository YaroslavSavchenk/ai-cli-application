---
type: decision
created: 2026-11-20
updated: 2026-11-20
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

Spec `.claude/plans/nocturne/PLAN-D9.md`. Related: [[detached-backend]],
[[in-app-update]].
