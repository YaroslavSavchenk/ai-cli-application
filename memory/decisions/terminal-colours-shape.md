---
type: decision
created: 2026-09-13
updated: 2026-09-22
tags: [nocturne, terminal, colours, settings]
---
# Terminal colours page — shape (open decision 10)

**Status:** decided 2026-09-13 (user, all four points = the orchestrator's advice)

Context: the user amended [[nocturne-full-switch]] on 2026-09-10 so that
terminal colour customisation returns inside Nocturne as a Settings page
(A7 visual, B9 live) instead of the Legacy popover. The exact shape was open
decision 10 in `.claude/plans/PLAN-NOCTURNE.md`, to be asked before A7.

Decided:
- (a) **Presets + custom ground and text.** A handful of named schemes,
  Nocturne first and default, plus free colour inputs for ground and text.
  `Reset to Nocturne` always available.
- (b) **Ground + text only.** Never the full 16-colour ANSI palette in the
  UI; presets may carry a full palette internally.
- (c) **Terminal only.** App chrome and accent stay Nocturne; the status
  colours (green / amber / red) are semantic and never themed.
- (d) **Settings page only.** No quick switch in the 48 px top bar.

B9 wires the page to the kept machinery in `web/src/ui/theme.ts`
(`:root` custom properties → `themeFromTokens()`,
`refreshAllTerminalThemes()`, `prefs.json` via `PUT /api/prefs`).

## Implemented 2026-09-22 (B9, spec `.claude/plans/nocturne/PLAN-B9.md`)

Orchestrator defaults, not asked (each a cheap flip):
- **Persisted shape = a hex pair** `prefs.theme = { ground, text }`; the
  preset is recovered from the pair (`matchPreset`), never stored — a renamed
  preset can never change somebody's colours. The Legacy `{ bg, fg, scan }`
  index shape is still read, never written; `scan` left the protocol.
- **Nocturne = the absence of an override**: the default REMOVES the six
  `:root` slots instead of writing them, so `tokens.css` stays the one source
  of the default (`--xt-bright-white` is `#f3f5fe` there, a step no ramp
  carries — the default card previews `#e9e9ed`, one step quieter; known).
- **Terminal only, enforced at the CSS seam**: the editor pane, the diff and
  the editor's file chip moved from `--term-bg` to its untouched twin
  `--color-term`; the pane status bar's ink takes the theme's quiet/ordinary
  steps. The agents table is a B7 constraint.
- **Live, then persisted**: paint + localStorage at once, the server write
  debounced 300 ms and serialised, flushed on dialog close; the re-read on
  open *adopts* (no write back, skipped while a write is pending) — the fix
  for a reopen race the scope review found. `api.updatePrefs` now refuses to
  PUT when its GET failed (it used to PUT the bare patch and wipe the bag).
- **A present-but-unreadable `theme` member is no opinion** (the local cache
  stands); a valid server pair still beats the cache at boot.

## Rejected alternatives
- Presets only: too rigid for "like Windows Terminal lets me".
- Free picker only / full ANSI: 16 editable colours is a big page with many
  unreadable combinations; the user wanted ground + text.
- App accent following the scheme: breaks the Nocturne look the user just
  chose.
- Top-bar quick switch: extra chrome in a 48 px bar for a rare action.
