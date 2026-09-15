# v0.4.0 — Nocturne (DRAFT, finalised in part B8)

Drafted 2026-09-14 at the end of Track A (parts A1–A8 of
`PLAN-NOCTURNE.md`). Track B (live data behind the new screens) is still
to come; anything below marked *mock* ships as a visual with honest
placeholder content until its B-part lands. Rewrite this file when B8
tags the release.

## The whole UI is new

The app now wears the **Nocturne** design: a dark indigo-neutral
instrument panel, Inter for the chrome, JetBrains Mono for the terminal
and every data value, a blurple accent used only as outline and small
marks, 1 px edges instead of shadows, radii 4/8/14. The previous look
("steam blend") is gone; it survives only as the git tag `legacy-ui`.

- Top bar (48 px): Files / Projects / Sessions toggles, connection dot,
  GitHub account chip, Settings, New session.
- Pane cards with a 38 px header (state as words: Working, Needs your
  answer, Finished), the terminal on its own ground, a status bar under
  each terminal, a Background agents strip (*empty until B7*).
- Files panel (*mock until B2*), resizable 200–520 px, with file-type
  chips and an edited-file pulse; Sessions panel with Running now /
  Earlier; Projects drawer in the same row vocabulary.
- Tab strip (32 px) with count pill and "Needs you"; statusline (26 px)
  with sessions / panes / waiting / latency / uptime / Keyboard shortcuts.
- New session dialog: six tool cards (Claude Code live; Codex, Gemini CLI,
  Grok *not available yet until B5*; Terminal; Other), permission cards
  with one info popover, Start from select, shells (Bash and PowerShell
  live).
- Add a project dialog: New folder / Clone a repository / From GitHub,
  and a folder picker in the same idiom.
- Settings with a left nav: Status bar, Preferences (*mock until B6*),
  Keyboard, **Terminal colours** (*mock until B9* — presets plus a custom
  ground and text colour, terminal only), Background service (version,
  uptime, Check for updates, Restart service).
- Commit view over the pane area and editor panes with file tabs in the tab strip (*mock until B3/B4*).
- Shortcuts overlay, update toast, restart confirmation and the boot
  overlay redesigned in the same language.

## Copy

Plain sentences everywhere; no decorative separators; counts are
pluralised; no commands, flags or configuration names in the UI.

## Removed

- The terminal theme popover and its top-bar Theme button (colour
  customisation returns as the Terminal colours Settings page, live in B9).
- The top-bar `?` button (the statusline's Keyboard shortcuts button, the
  `?` key and Ctrl+Alt+/ open the overlay).
- The Legacy stylesheet role tokens and the alias layer that carried them
  through the migration.

## Under the hood

- One token file (`web/src/styles/tokens.css`, 143 tokens in 8 sections)
  transcribes the handoff primitives verbatim; the xterm.js palette is
  built from it at runtime, so the terminal and the chrome are one system.
- Guard tests pin the whole thing: every `var()` is declared, every token
  is read (the handoff's unused ramp steps are the one named exception),
  retired names cannot come back, every class a module assigns has a rule
  outside `@media`, no colour literal in the stylesheet.
- Suite: 1165 tests before Nocturne → 1745 after Track A.

## Known limits (honest)

- Files, Commits, Editor, Preferences, Background agents and Terminal
  colours show mock content until their Track B parts land (each carries
  an "Example" marker line).
- The colour choice on the Terminal colours page is not persisted yet.
