# Design handoff — gap analysis & implementation plan

Status doc for the hi-fi handoff the user dropped in `design/` on 2026-07-19
(`README.md` spec + `session-manager-prototype.html`, instructions in
`CLAUDE_CODE_PROMPT.md`). Read together with `web/DESIGN.md` and
`.claude/PROJECT-SCOPE.md`. Written after a full feature audit of `web/src`
against the handoff spec; revised 2026-07-20 after the user settled the open
decisions and flipped precedence.

## Precedence rule (REVERSED 2026-07-20, user's call)

**The handoff is the primary design source.** `design/README.md` (spec,
tokens, screens) and `session-manager-prototype.html` (reference behavior)
define the look and layout; `web/DESIGN.md` is rewritten to transcribe the
handoff (plus the recorded deviations below) and `web/src/styles/tokens.css`
is remapped to the handoff's values. The original 2026-07-19 rule
("repo wins on look") is dead — kept in git history only.

What survives the flip (not looks, and therefore not overridden):

- **Architecture**: vanilla TS + Vite, xterm.js, sessions server-side. The
  handoff prompt itself defers to the established stack; no React rebuild.
- **No new npm dependencies** (handoff prompt: ask before adding any beyond
  the terminal renderer). Fonts are self-hosted assets (Barlow already
  bundled; JetBrains Mono to be bundled the same way, OFL). Phosphor icons
  NOT adopted for now — the prototype's text glyphs (`>_ × + ▦ ⇱ ▸`) are
  what we implement; revisit only if the user asks.
- **The three fiction cuts** (below) — lifecycle impossibilities.
- **Real-terminal guarantees**: resize chain, keyboard non-interception,
  AltGr guard, localStorage schema v2 (a v3 migration is fine if the screen
  model needs it, with v2→v3 migration).

## Backend prerequisites — LANDED 2026-07-19 (R1, reviewed clean)

- Presence WS answers `{"type":"ping","t":<finite n>}` with matching `pong`
  (latency measurement); inbound presence frames capped 1024 B (1009 close).
- Authed `GET /api/runtime` → `{ startedAt }` (uptime display).
- Everything else the UI needs already exists: model/permission tags derive
  from `SessionInfo.args`; attention counts, previous-run list, health are
  already exposed.

## LANDED 2026-07-20 — R2: handoff reskin + shell restructure + theme system (terminal-ui)

Scope grew 2026-07-20: the reskin is no longer "map handoff onto steam
tokens" but "retoken the app to the handoff".

- **Tokens + type**: remap `tokens.css` to the handoff palette (README
  "Design tokens" — surfaces, borders, text ramp, `#5cb8f0` accent, status
  hues, radii 6–13px by role, the four sanctioned shadows, gradient topbar,
  radial pane-area lift). Bundle JetBrains Mono (woff2 + OFL beside Barlow);
  mono stack leads with it.
- **Shell restructure**: 44px topbar (logo tile + wordmark; Theme / Projects
  / Sessions toggles with amber attention badge; divider; green connected
  dot; green `+ New session`) · middle row (drawers + pane grid) · **bottom
  tab strip** (~35px, Steam-style, radius 9 9 0 0, active glow bar, `▦ N`
  split badge, amber input pill, ghost `+`, right-aligned drag hint) · 23px
  statusline. Tab strip position = settled user decision.
- **Theme system**: Theme button → anchored popover, two independent 5-col
  swatch grids — 10 terminal backgrounds × 10 text ramps (exact values in
  README). Overrides flow through the existing `--xt-*` vars so
  `themeFromTokens()` (web/src/ui/terminal.ts) stays the single ITheme
  source; live terminals refresh in place. Ramp mapping: `out` → xterm
  foreground, `cmd` → bold/bright, `dim` → brightBlack/faint. Status colors
  (green/amber/red) are semantic and NEVER themed. Persist in localStorage
  (separate key, no UI-schema bump). Scanline overlay: toggleable in the
  popover, default OFF (README: "off is fine").
- **Statusline** (per handoff — 23px, mono 10.5px): left `ws <n> ms`
  (presence ping) · `<n> sessions · <n> panes` · amber `<n> awaiting input`;
  right `up HH:MM:SS` (from /api/runtime) · `pty ok` (health-derived). No
  separate "healthy" text item (README removed it; topbar dot covers it).
  No grace countdown (fiction cut).
- **Pane cards**: terminal-bg card, radius 12px, pane shadow, 30px header —
  status dot, mono session name, faint project name, model tag + permission
  tag (red for `bypassPermissions`), `⇱ own tab` only when in a split.
  Focused-in-split inner outline `#3d5a75`. Grid gap/padding 10px.
- **Drawers**: projects 272px (header `+ add` inline form with `~/projects/
  <name>` path autofill; rows: name, `+` launch-into-project, `×`, faint
  path, green active-session count) · sessions 296px (ACTIVE rows: dot,
  name, model tag, split button max-4, `×`; PREVIOUS RUN rows keep the
  existing `--continue` relaunch + forget).
- **Empty state**: centered logo tile + "No active sessions" + `+ New
  session` + `Relaunch previous run (N)` — WITHOUT the grace countdown line
  (fiction cut). Replaced launcher-tab-as-empty-state once R3 landed the
  dialog (below); the buttons now open the launch dialog.

## LANDED 2026-07-20 — R3: modal launch dialog + honest boot steps (terminal-ui)

- **Launch dialog** (modal — settled user decision 2026-07-20, replaces
  launcher-as-tab): 560px card per handoff §8 — preset chips (`deep work ·
  opus · acceptEdits · continue`, `quick fix · sonnet · default`, `yolo ·
  opus · bypass` red-tinted); 2×2 fields (name, project, model select
  opus/sonnet/haiku/fable, resume select `start fresh` / `--continue`);
  4-mode permission cards with plain-language descriptions
  (`bypassPermissions` red); live command preview + `cwd:` line. Client
  composes argv exactly as today (server spawns argv, never shell). Entry
  points: topbar `+ New session`, tabstrip ghost `+`, projects-drawer `+`
  (pre-set project), empty state, Ctrl+Alt+T.
- **The per-id-resume fiction cut held**: resume is exactly `start fresh` /
  `--continue` — NO per-id `--resume <id>` option (the journal stores our
  session ids, not Claude conversation ids; see "Cut as fiction" below).
- **Custom-command chip extension** (user decision 2026-07-20, added mid-R3,
  not in the original handoff mock): a fourth chip, `custom · any command`,
  is a MODE toggle rather than a one-shot preset — it restores the retired
  launcher tab's configurable command + args as a full-width mono Command
  field (whitespace-split argv, no shell), disabling the claude-specific
  fields while active. `currentSpawn()` in `web/src/ui/launch.ts` (over the
  pure composers in `web/src/ui/launch-args.ts`) is the one composition path
  for both modes, so the preview can never diverge from the POST body.
  Recorded in `web/DESIGN.md` ("Custom escape hatch").
- **Boot sequence panel**: real in-app steps only (token check → hydrate
  sessions → attach WS), styled per the handoff boot card's visual language.
  No fake timers, no launcher-lifecycle steps (fiction cut).

## Cut as fiction — prototype features the real system cannot honestly show

Unchanged by the precedence flip — these are lifecycle facts:

- **Grace countdown** ("backend exits in N s", empty state + statusline):
  grace runs only when zero windows hold a presence socket — any UI able to
  display the countdown is itself keeping the backend alive.
- **Boot overlay with launcher lifecycle steps** (runtime.json → start
  backend → wait health): the launcher opens the browser only after health
  passes; the app can never witness those steps. Downscoped to the honest
  in-app steps (R3).
- **Per-session `--resume <id>`**: the journal stores our session ids, not
  Claude Code conversation ids. `--continue` relaunch and claude's own
  interactive picker stay.

## Superseded 2026-07-20 — the old "Skipped — repo wins" list

The precedence flip un-skips the handoff's visual values (12px radii, pane/
dialog/popover shadows, gradient topbar, backdrop blur, `#5cb8f0` accent,
JetBrains Mono bundling, centered empty state, scanline toggle). Still
skipped: React rebuild (architecture), Phosphor icon dependency (text
glyphs per prototype; no new deps without asking).

## Open decisions

None. Settled 2026-07-20 (user): bottom tab strip; modal launch dialog;
handoff = primary design source. Recorded in `.claude/PROJECT-SCOPE.md` and
`memory/decisions/handoff-design-primary.md`.
