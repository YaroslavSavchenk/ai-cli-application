---
type: log
created: 2026-07-20
updated: 2026-07-20
tags: [milestone, design, frontend]
---
# 2026-07-20 — R3: modal launch dialog + honest boot panel

Second milestone of the day, straight after [[2026-07-20-r2-handoff-reskin]].
Launcher-as-tab is gone; the handoff's launch dialog and an honest boot
sequence replace it.

**Landed (dev-flow, terminal-ui developer, one session-limit interruption
resumed cleanly):**

- `web/src/ui/launch.ts` — 560px modal per handoff §8: preset chips
  (deep work / quick fix / yolo), 2×2 fields, 4 permission cards
  (bypass red), live command preview + `cwd:` line. All five entry points
  (topbar, ghost `+`, projects-drawer `+` with project pre-set, empty
  state, Ctrl+Alt+T). Resume select is exactly 2 options — the per-id
  `--resume` fiction cut held.
- **Custom escape hatch** (mid-flow user decision, see
  [[launch-dialog-custom-escape-hatch]]): fourth chip
  `custom · any command`, free-text whitespace-split argv, claude fields
  disabled while active. `currentSpawn()` = single composition path for
  preview and POST.
- `web/src/ui/launch-args.ts` — pure DOM-free module (composeArgs, CHIPS,
  PERMS, MODELS, parseCustomCommand, previewLine) born from a
  test-engineer finding (private + xterm-tainted = untestable).
- Launcher-as-tab fully retired: `ViewState.kind` deleted; localStorage
  **stayed v2** (views serialize without kind; loader drops zero-session
  views — old launcher blobs migrate by omission). Boot panel: 3 real
  steps (token check / hydrate / attach WS), mounts only past 150ms, real
  failure states; the launcher-lifecycle boot fiction stayed cut.

**Flow stats:** 2 fix cycles. Round 1: scope blocker (claude-only dialog
vs configurable-command Feature) → user decided custom chip;
test-engineer extraction finding + dropZonesFor guard → fixer. Round 2 on
the delta: security clean (4 notes, 0 should-fix), test gate 92/92
(+19 launch-args tests total), scope found doc rot + stale-custom-mode
footgun + sans command field → fixer → confirmed resolved. Suite
68→92. verify-terminal **9/9 full run** (disconnect/hidden/stress
included this time; real claude TUI via dialog, arrow-key prompt nav,
zero tokens). Janitor: one literal→token swap, doc drift fixes, zero
dead code found.

**Security notes carried to backlog (auditor, all "note" severity):** no
length cap on custom command (1 MiB body cap upstream); server accepts
control chars/NUL in argv (hygiene: reject `\x00-\x1f`); zero-width chars
pass preview invisibly; previous-run relaunch rows show no danger marker
(pane tag self-corrects post-launch).

**Next phase queued: theme persistence.** User bug report diagnosed —
theme resets on app close/reopen because auto-picked port = new origin =
empty localStorage ([[localstorage-origin-port-churn]]). Fix shape:
`prefs.json` + authed `GET/PUT /api/prefs`, theme.ts hydrates from server
(localStorage as same-run cache). Substrate doubles for the still
user-gated settings panel.

**Manual pass still owed (user, real Windows/Edge):** dialog + custom chip
visual once-over, real claude permission-prompt interaction, boot panel on
a cold start.

Related: [[launch-dialog-custom-escape-hatch]], [[handoff-design-primary]],
[[2026-07-20-r2-handoff-reskin]], [[localstorage-origin-port-churn]]
