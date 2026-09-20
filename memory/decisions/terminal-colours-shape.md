---
type: decision
created: 2026-09-13
updated: 2026-09-13
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

## Rejected alternatives
- Presets only: too rigid for "like Windows Terminal lets me".
- Free picker only / full ANSI: 16 editable colours is a big page with many
  unreadable combinations; the user wanted ground + text.
- App accent following the scheme: breaks the Nocturne look the user just
  chose.
- Top-bar quick switch: extra chrome in a 48 px bar for a rare action.
