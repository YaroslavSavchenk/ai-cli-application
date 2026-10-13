---
type: log
created: 2026-10-13
updated: 2026-10-13
tags: [nocturne, d4, d5, focus, keyboard, launch-dialog, permissions]
---
# 2026-10-13 — D4: the keyboard comes back to a terminal; D5: "Always ask" passes `--permission-mode manual`

## D4

A dialog opened with nothing focused recorded `<body>` as the place to
give focus back to. On close, typed keys then reached no PTY.

Now there is one helper in `web/src/ui/util.ts`.
- `restoreFocus(target, { fallback?, last? })` focuses the target when
  `canTakeFocus` says it can: not `<body>`, connected, not under
  `[hidden]`, `offsetParent !== null`. Note that `offsetParent` is also
  null for an element that is itself `position: fixed`, and none of the
  openers is.
- Otherwise it falls back to the focused pane's terminal. `main-shell.ts`
  injects that fallback at boot with `setFocusFallback(requestTerminalFocus)`,
  and a source pin checks it.

Every restore site uses it: ModalSlot, shortcuts, launch, newproject,
settings (with the gear as `last`), context-menu, drop-dialog, unsaved and
update.

Two older bugs fixed on the way:
- The row menu's focusin closer no longer pulls focus back from the
  control the user just Tabbed to.
- The unsaved-text question now runs its answer first and then gives
  focus back. Before, Discard handed focus to the chip ×, the close then
  removed the ×, and focus ended on `<body>`.

## D5

With no flag, Claude Code 2.1.283 opened in `auto mode`, so "Always ask"
promised something the launch did not do.
- The app keeps storing `default`. `CLAUDE_PERMISSION_FLAG` in
  `shared/protocol.ts` maps it to the CLI value `manual`, which is the
  documented name since 2.1.200 (`default` is accepted but hidden).
  `claudePermissionFromFlag` reads it back for `permFromArgs` and
  `parsePermissionMode`: manual, default and no flag all mean Always ask.
- The user picked `manual` when the hidden-value finding came up
  (decision 17, amended).
- Known limit: history entries from before D5 resume with no flag, byte
  for byte. Backlog: the status line still reads "always ask" for a
  session without a flag.

## Gates

- Scope reviews, one fix round each.
- Test gate: 10 mutants, 10 killed.
- `/verify-terminal` runs with D6 before the branch merges.
