# Design handoff — gap analysis & implementation plan

Status doc for the hi-fi handoff the user dropped in `design/` on 2026-07-19
(`README.md` spec + `session-manager-prototype.html`, instructions in
`CLAUDE_CODE_PROMPT.md`). Read together with `web/DESIGN.md` (steam blend,
binding) and `.claude/PROJECT-SCOPE.md`. Written after a full feature audit
of `web/src` against the handoff spec.

## Precedence rule (from CLAUDE_CODE_PROMPT.md)

Where the handoff and the repo's decided design differ, **the repo wins**:
`web/DESIGN.md` + `web/src/styles/tokens.css` are the real steam-blend
source; the handoff's hex values map onto existing tokens, never hard-coded.
The handoff supplies **features and behavior** the repo doesn't have yet.

Applied consistently: handoff contradicts an explicit DESIGN.md decision or
token → repo wins. Handoff adds something DESIGN.md doesn't decide → build it.

## Backend prerequisites — LANDED 2026-07-19 (R1, reviewed clean)

- Presence WS answers `{"type":"ping","t":<finite n>}` with matching `pong`
  (latency measurement); inbound presence frames capped 1024 B (1009 close).
- Authed `GET /api/runtime` → `{ startedAt }` (uptime display).
- Everything else the UI needs already exists: model/permission tags derive
  from `SessionInfo.args`; attention counts, previous-run list, health are
  already exposed.

## To build — R2: theme system + chrome richness (terminal-ui)

- **Theme system** (the big one; entirely absent today): topbar Theme button
  → anchored popover with two independent 5-col swatch grids — 10 terminal
  backgrounds × 10 text ramps (values in `design/README.md` "Design tokens").
  Implementation constraint: overrides flow through the existing `--xt-*`
  CSS vars so `themeFromTokens()` (web/src/ui/terminal.ts) stays the single
  ITheme source; live terminals refresh in place. Ramp mapping: `out` →
  xterm foreground, `cmd` → bold/bright, `dim` → brightBlack/faint. Status
  colors (green/amber/red) are semantic and NEVER themed. Persist choice in
  localStorage (separate key, no v2 schema bump).
- **Statusline additions** (keep all current items): `ws <n> ms` (presence
  ping), global `<n> sessions · <n> panes`, amber `<n> awaiting input`,
  `up HH:MM:SS` (from /api/runtime), `pty ok` (health-derived).
- **Topbar additions**: connected indicator (green dot, backend
  reachability), green flat `+ new session` primary button (opens launcher
  tab — same action as tabstrip `+`), Theme button.
- **Pane headers**: model tag + permission tag derived from session args;
  permission tag red for `--dangerously-skip-permissions`.
- **Tabs**: split tabs join member names with " · " (ellipsis at max-width);
  existing blue `+N` chip stays (repo token, replaces handoff's `▦ N`).
- **Drawers**: sessions rows gain model tag; projects rows gain a `+`
  (launcher preset to that project) and an active-session count (green when
  >0, faint "no active sessions" otherwise).

## To build — R3: launcher upgrade + honest boot steps (terminal-ui)

- **Launcher form** (stays in-tab per DESIGN.md — see open decisions):
  combo preset chips when command=claude — `deep work · opus · acceptEdits ·
  continue`, `quick fix · sonnet · default`, `yolo · opus · bypass`
  (danger-tinted) — setting model+permission+resume together; named model
  select (opus / sonnet / haiku / fable / custom→text input); permission-mode
  picker with 4 modes + plain-language descriptions (`default`,
  `acceptEdits`, `plan`, `bypassPermissions` — red); live command preview
  (`$ claude --model … --permission-mode … --continue`) + `cwd:` line.
  Client composes argv exactly as today (server spawns argv, never shell).
- **Boot sequence panel**: real in-app steps only (token check → hydrate
  sessions → attach WS), same visual language as the restart panel. No fake
  timers.

## Skipped — repo wins (decided by precedence, not lost)

- React rebuild (vanilla TS + Vite is decided architecture; prompt itself
  defers to existing stack).
- Handoff's visual values: 12px radii, pane/dialog shadows, gradient topbar,
  backdrop blur, `#5cb8f0` accent → steam tokens (≤3px radius, 1px lines,
  one shadow on drag ghost, opaque scrim, `#66c0f4`).
- Scanline/CRT overlay — pure decoration (handoff itself: "off is fine");
  violates "every colored element encodes information".
- Phosphor icon set (new dependency; DESIGN.md decided text glyphs) and
  JetBrains Mono bundling (DESIGN.md decided the system mono stack).
- Centered friendly empty state (DESIGN.md slop filter rejects; launcher tab
  IS the empty state).

## Cut as fiction — prototype features the real system cannot honestly show

- **Grace countdown** ("backend exits in N s"): grace runs only when zero
  windows hold a presence socket — any UI able to display the countdown is
  itself keeping the backend alive. Prototype-only fiction.
- **Boot overlay with launcher lifecycle steps** (runtime.json → start
  backend → wait health): the launcher opens the browser only after health
  passes; the app can never witness those steps. Downscoped to the honest
  in-app steps above.
- **Per-session `--resume <id>`** in the launch form: the journal stores our
  session ids, not Claude Code conversation ids. The existing
  `pick conversation · --resume` (claude's own interactive picker) stays.

## Open decisions — user call, do not settle silently

1. **Tab strip position**: handoff puts a dedicated Steam-style strip at the
   bottom (above the statusline); shipped app has tabs in the topbar
   (DESIGN.md: "36px topbar, 29px bottom-aligned tabs"). Recommendation:
   keep topbar (decided + shipped); cheap to revisit after R2.
2. **Launch UI shape**: handoff uses a modal dialog; DESIGN.md explicitly
   decided launcher-as-tab ("not a centered friendly empty state").
   Recommendation: keep in-tab, adopt all the dialog's field-level features
   (R3 list above).
