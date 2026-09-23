---
type: decision
created: 2026-09-13
updated: 2026-09-23
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

## From the scope doc (moved 2026-09-23)

Verbatim wording of the `.claude/PROJECT-SCOPE.md` bullet before part O1 condensed it; the scope doc holds the current rule.

### Features (decided) — App settings panel

- **App settings panel — GO given 2026-07-20; contents REVERSED 2026-07-25
  (user decision).** A checklist-style settings surface persisted
  server-side in `prefs.json` via `/api/prefs`. The 2026-07-20 "decided
  four" (default model, default permission mode, auto-run startup command,
  read-only usage display) are DELETED — their backends too (`/api/usage`,
  `/api/telemetry`, the auto-run registry, the global launch-defaults
  store). Since Nocturne A7 (2026-09-13) the panel is a v3 left-nav modal
  with five pages: Status bar (the status-line checklist, next bullet),
  Preferences (API keys LIVE since B5, 2026-09-18 — plan decision 4: one
  password field with Show / Save / Remove per keyed tool, Claude Code
  `ANTHROPIC_API_KEY` ("Uses your Claude login. A saved key is used
  instead."), Gemini CLI `GEMINI_API_KEY`, Grok `XAI_API_KEY`; Codex has no
  field ("Signs in inside the terminal"); the page only ever learns saved /
  not saved / `Set outside the app` from `GET /api/keys`, a key never comes
  back, the field is cleared on save and on close, under an `API keys`
  heading since B6; **Tools** (Nocturne B6, 2026-09-22, decision 1: one
  toggle per card of the New session dialog, a hidden card is absent from
  the grid and a hidden pre-selection falls back to the first visible card,
  the last visible card refuses with `Keep at least one tool visible.`,
  the key rows stay for hidden tools; `prefs.tools.hidden`, clamped on read
  so at least one card always stays); **Defaults** (B6: `Reopen tabs on
  start` — see Tabs and layouts, `Confirm before ending a session` — the
  armed two-step on every door that ends a session — the tab `×`, the
  Sessions panel's end control, the exited banner's `End session` and, since
  B8, the pane header's End session button — off = one click, the
  B4 unsaved-text question never switched off, `Follow output` — every
  write ends at the bottom even after scrolling up, off = xterm's rule;
  `prefs.behaviour`, factory on / on / off; the notifications row was
  dropped until C1, decision 2); the page lead reads `Your tools and how
  the app behaves.`), Keyboard (B6: the WHOLE shortcuts table, drawn from
  `web/src/ui/shortcuts-rows.ts`, the one source the overlay reads too),
  Terminal colours (LIVE since B9, 2026-09-22; shape decided 2026-09-13, plan
  decision 10: presets + custom ground and text, ground + text only, terminal
  only, status colours never themed, no top-bar switch — see
  `memory/decisions/terminal-colours-shape.md`; the six preset cards and the
  two custom fields paint every open terminal at once through
  `web/src/ui/theme.ts` — the six `:root` slots `--term-bg`, `--xt-fg`,
  `--xt-white`, `--xt-bright-white`, `--xt-cursor`, `--xt-bright-black` →
  `themeFromTokens()` — and Nocturne is the ABSENCE of those overrides, so
  the default is exactly `tokens.css`; the choice persists as
  `prefs.theme = { ground, text }`, a lower-case hex pair (the Legacy
  `{ bg, fg, scan }` index shape is still read, never written), localStorage
  is only the cache; the server write is debounced 300 ms and serialised,
  flushed when the dialog closes; the dialog's re-read on open ADOPTS the
  server pair (paint + cache, never a write back, skipped while a write of
  this window is pending); only terminal surfaces follow the ground — the
  editor, the diff and the file chip sit on `--color-term`, and the pane
  status bar's ink takes the theme's quiet and ordinary steps so it stays
  readable on any ground; spec `.claude/plans/nocturne/PLAN-B9.md`), Background service
  (version, uptime, `Restart service`; since B6, decision 4, `Check for
  updates` asks `POST /api/update/check` and answers on the page —
  `You have the newest version.` / `Version <tag> is available.` with an
  `Update` button that opens the update confirm through its own source
  `settings-update` / `A new version is installed. Restart the service to
  use it.` / `Could not check for updates.` — then re-fetches the runtime so
  the pill and the toast agree; hidden when the app is not installed).
  The same part restyled the `Add a project` dialog (header, tabs
  `New folder` / `Clone a repository` / `From GitHub`, checklist rows,
  footer) and the folder picker (`pk-` block) onto the Nocturne primitives,
  behaviour and request bodies unchanged.
  Launch-dialog pre-selection comes from per-project defaults in
  `projects.json` (which stay — a separate feature) with a hardcoded
  fallback, and since B6 falls back to the first visible card when the
  chosen one is hidden; a per-launch choice always wins.
