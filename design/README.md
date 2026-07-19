# Handoff: Multi-session AI CLI Manager — Web GUI

## Overview
This is the design reference for the browser GUI of the multi-session AI CLI
manager: a web front-end for running many CLI sessions (Claude Code first,
other CLIs later) side by side. The backend (Node in WSL2) spawns each session
as a real PTY via `node-pty` and streams it over WebSocket; the browser is
only a view — sessions live server-side, survive hidden panes, and reattach
with scrollback. This design covers the whole front-end shell: tab strip,
split panes, drawers, launch dialog, terminal theming, and lifecycle states
(boot, attention, empty/grace).

## About the design files
The file in this bundle — `session-manager-prototype.html` — is a **design
reference created in HTML**, not production code to copy. It is a working
prototype that demonstrates the intended look, layout, and interaction model.
The terminal output, timers, and session data in it are **faked** to make the
prototype self-contained.

Your job is to **recreate this design in the project's real front-end
environment** (`web/`) using its established stack, wiring the real pieces
(WebSocket transport, PTY streams, the presence/lifecycle protocol) in place
of the mocked data. If `web/` has no framework decided yet, pick the most
appropriate one for a small, stateful, keyboard-driven single-page app
(React + a real terminal renderer like **xterm.js** is the natural fit) and
implement there. Do not ship the HTML prototype directly.

## Fidelity
**High-fidelity.** Colors, typography, spacing, radii, and interactions are
final and intentional (the "steam blend" direction from `web/DESIGN.md`).
Recreate the UI faithfully against these values. The one thing to swap is the
terminal body: the prototype renders fake lines with `<div>`s; the real app
must render live PTY output through xterm.js (or equivalent) — apply the
terminal theming described below to that renderer.

---

## Screens / Views

The app is a single full-viewport shell. "Screens" here are regions and
overlay states, not separate pages.

### 1. App shell (persistent chrome)
Vertical flex column, `100vh`, no page scroll. Top to bottom:
1. **Top bar** (44px)
2. **Middle row** (flex:1) — optional left drawer, pane area, optional right drawer
3. **Tab strip** (~35px, bottom-aligned Steam-style)
4. **Statusline** (23px)

Overlays (absolute, above the shell): launch dialog, theme popover, drag ghost,
boot overlay.

### 2. Top bar
- Height 44px, background `linear-gradient(180deg,#1f2833,#1b222c)`, bottom
  border `1px solid #262f3b`, padding `0 14px`, `display:flex; gap:10px`.
- **Left:** 18px square logo tile (border `1px solid #2e3846`, radius 7px,
  bg `#12161d`) with a green `>_` glyph (`JetBrains Mono` 8px 700 `#64c25a`);
  then title `AI SESSION MANAGER` (Barlow 12px 600, letter-spacing 1.6px,
  `#aab7c4`).
- **Spacer**, then right-aligned controls: **Theme** button (with a 2×2 color
  swatch icon), **Projects** toggle, **Sessions** toggle (shows an amber count
  badge when sessions await input), a 1px divider, a **connected** indicator
  (green dot + text), and the primary **+ New session** button.
- Button base: height 26px, radius 7px, border `1px solid #2e3846`,
  transparent bg, `#7d8b9c` text; hover `border-color:#3d4b5d; color:#dbe2ea`.
  Toggled/active drawer button: bg `#232b36`, text `#dbe2ea`.
- **+ New session** (primary "go"): bg `rgba(100,194,90,.08)`, border
  `1px solid #64c25a`, text `#7ed673`, 600; hover adds
  `box-shadow:0 0 18px rgba(100,194,90,.3)`.

### 3. Pane area (the hero surface)
- Fills the middle row. Background is a subtle radial lift:
  `radial-gradient(1100px 520px at 32% -10%,#1b232f,#12161d)`.
- Panes are laid out in a CSS grid with `gap:10px; padding:10px`. Grid template
  by pane count (1–4):
  - 1: `"a" 1fr / 1fr`
  - 2: `"a b" 1fr / 1fr 1fr`
  - 3: `"a b" 1fr "a c" 1fr / 1fr 1fr`
  - 4: `"a b" 1fr "c d" 1fr / 1fr 1fr`
- **Pane card:** `background:<terminal bg>` (theme, default `#0e1116`), radius
  12px, border `1px solid #262f3b`, `overflow:hidden`, elevation
  `box-shadow:0 12px 32px rgba(0,0,0,.32)`. The focused pane in a split gets an
  inner `outline:1px solid #3d5a75; outline-offset:-1px`.
- **Pane header** (30px): status dot (see status colors), session name
  (`JetBrains Mono` 12px 500 `#dbe2ea`, ellipsis), project name (11px `#5c6b7c`),
  spacer, model tag + permission tag (mono 9.5px, 1px `#2e3846` border, radius
  7px; permission tag turns `#d95c5c` for `bypassPermissions`), and — only when
  the pane is in a split — an **⇱ own tab** button to pop it back into its own
  tab.
- **Terminal body:** monospace 12.5px, line-height 1.6, `padding:10px 14px`.
  In the real app this is the xterm.js viewport. A blinking block cursor
  (7×14px, `blink` 1.1s step-end) sits on the prompt line. Text uses the theme
  text ramp (below).
- Optional **scanline** overlay (toggleable): `repeating-linear-gradient` of
  1px dark lines every 3px at ~0.5 opacity, `mix-blend-mode:multiply`, over the
  body only. Off is fine for production; it's a cosmetic nod.
- **Drop hint:** while a tab/screen is being dragged and the current screen can
  accept it, show a dashed `#5cb8f0` overlay reading **DROP TO MERGE HERE**.

### 4. Tab strip (bottom, Steam-style)
- `display:flex; align-items:flex-end`, bg `#1b222c`, top border `1px solid
  #262f3b`, `padding:5px 8px 0; gap:3px`.
- **Tab** = one *screen* (a group of 1–4 sessions), NOT one session. Height
  30px, radius `9px 9px 0 0`, `max-width:240px`. Active tab: bg `#0e1116`,
  border `1px solid #262f3b`, and a glowing accent bar across the top
  (`height:2px; background:#5cb8f0; box-shadow:0 0 14px 2px rgba(92,184,240,.45)`,
  inset 12px from each side). Inactive: transparent, muted text `#8e9cab`.
- Tab contents: status dot, name (mono 11.5px; for a split, join member names
  with " · "), a **▦ N** split badge when it holds >1 session (mono 9.5px,
  border `1px solid #3d5a75`, `#5cb8f0`), an amber **input** pill when any member
  awaits input, and a per-tab **×** close.
- After the tabs: a ghost **+** button (opens the launch dialog) and, pushed
  right, the hint text `drag a tab onto a tab or pane to merge · ⇱ splits it
  back out`.

### 5. Statusline (bottom)
- Height 23px, bg `#10141a`, top border `1px solid #1d242e`, mono 10.5px
  `#5c6b7c`, `white-space:nowrap; overflow:hidden`, `gap:16px`.
- Left group: `ws <n> ms`, `<n> sessions · <n> panes`, an amber
  `<n> awaiting input` when applicable, and (only in the empty state) an amber
  `grace: exit in <n> s`. Right group: `up HH:MM:SS`, `pty ok`.
- NOTE: there is intentionally **no "healthy" indicator** here (removed by
  request; the green connected dot in the top bar covers connection state).

### 6. Projects drawer (left, toggle)
- 272px, bg `#1b222c`, right border `1px solid #262f3b`, slides in
  (`translateX(-16px)` fade, .18s).
- Header row: `PROJECTS` label + a **+ add** button. **+ add** opens an inline
  form (name input + path input; the path auto-fills to `~/projects/<name>`
  until edited) with Cancel / Add. Add appends to the project list and makes it
  available in the launch dialog.
- Each project row: name (13px 500 `#dbe2ea`), a **+** (new session in this
  project → opens launch dialog pre-set to it), a **×** (remove project), the
  path (mono 10.5px `#5c6b7c`), and a meta line (`N active sessions` in green,
  or `no active sessions` in `#3d4b5d`).

### 7. Sessions drawer (right, toggle)
- 296px, bg `#1b222c`, left border, slides in from the right.
- **ACTIVE · N** group: each session row has status dot, name, model, a
  **split** button (add this session to the current screen, max 4), and a **×**
  (end session). Clicking the row views that session's screen.
- **PREVIOUS RUN · N** group: sessions from the previous backend run, each with
  a **resume** button (relaunches with `claude --resume <id>`) and a **×**
  (forget). Footer note: `relaunch resumes claude with --continue`.

### 8. Launch dialog (overlay)
- Backdrop `rgba(8,10,14,.55)` with `backdrop-filter:blur(4px)`, centered.
- Card 560px, bg `#1b222c`, border `1px solid #2e3846`, radius 12px, shadow
  `0 24px 60px rgba(0,0,0,.5)`, `overflow:hidden`, `fadeUp` in.
- **Header:** logo tile + "Launch session" (14px 600) + subtitle `spawns a real
  pty on the backend · survives hidden panes` + × close, on a
  `linear-gradient(180deg,#202935,#1b222c)`.
- **Body** (`padding:18px 20px; gap:16px`):
  - **Preset chips** (pill, radius 13px): `deep work · opus · acceptEdits ·
    continue`, `quick fix · sonnet · default`, `yolo · opus · bypass` (this one
    tinted red `#a05252` / border `#4a2f33`). Clicking sets model+perm+resume.
  - **2×2 grid of fields:** Session name (text, placeholder "auto from project"),
    Project (`<select>`), Model (`<select>`: **opus, sonnet, haiku, fable**),
    Resume (`<select>`: `start fresh`, `continue last conversation (--continue)`,
    then one `resume: <name> (<id>)` option per previous-run session →
    `--resume <id>`).
  - **Permission mode:** 2×2 grid of selectable cards, each with the mode name
    (mono) + a plain-language description: `default` "ask before every tool
    call", `acceptEdits` "auto-approve file edits", `plan` "read-only planning
    mode", `bypassPermissions` "never ask · dangerous" (red text). Selected card:
    bg `rgba(92,184,240,.08)`, border `#3d5a75`, text `#5cb8f0`.
  - **Command preview:** a `#0e1116` mono block echoing the exact command,
    e.g. `$ claude --model opus --permission-mode acceptEdits --continue` with a
    second line `  cwd: ~/projects/<project>`.
- **Footer:** `opens in a new tab` note, Cancel (ghost), Launch ▸ (green "go").

### 9. Theme popover (overlay)
- Anchored top-right under the Theme button, 268px card. Two independent 5-col
  swatch grids:
  - **TERMINAL BACKGROUND** — 10 dark grounds: charcoal `#0e1116`, void
    `#07090c`, deep blue `#0a1220`, navy `#0d1526`, ocean `#081a1f`, forest
    `#0a1510`, moss `#10160e`, plum `#150f1c`, graphite `#141414`, espresso
    `#161010`.
  - **TEXT COLOR** — 10 ramps (each defines `cmd`/`out`/`dim` shades), swatch
    shows the `out` shade over `#0e1116` as "Aa": default, phosphor, amber, ice,
    paper, cyan, violet, ember, steel, mint (values in the Design Tokens
    section).
- Background and text are chosen independently and applied to every pane's
  terminal. **Status colors (green/amber/red) never change** — only the neutral
  text ramp (command / output / dim) is themed.

### 10. Boot overlay (cold-start state)
- Full-screen `#12161d`, click to skip. Logo + title, then a `#0e1116` card
  listing lifecycle steps that resolve one per ~700ms with a spinner → green ✓:
  `reading runtime.json` → `runtime.json absent · starting backend (detached)`
  → `waiting for backend health` → `backend healthy` → `opening app window`.
  Footer: `first start can take a moment · click to skip`. Mirrors the real
  launcher's attach-or-start flow.

### 11. Empty state (no active sessions)
- Centered: 64px logo tile, "No active sessions", `backend idle · exits in <n> s
  unless a session starts` (live grace countdown), and two buttons: **+ New
  session** and **Relaunch previous run (N)**. The statusline also shows the
  grace countdown. Reflects the lifecycle-bound backend (~30s grace after the
  last window/session before the backend exits).

---

## Interactions & behavior

- **Tab = screen (group of sessions).** A screen holds 1–4 sessions shown as a
  split grid. This is the core model — implement screens as first-class objects
  `{ id, members: sessionId[] }`, with one `active` screen and one `focus`
  session within it.
- **Switching:** clicking a tab activates its screen; clicking a session row in
  the drawer activates the screen containing it and focuses that session.
- **Split / merge (must persist):** dragging one tab onto another tab (or onto
  the active pane area) merges their sessions into the target screen (capped at
  4; overflow stays behind in the source screen). A merged screen is a single
  tab showing joined names + a `▦ N` badge. **Splits are persistent** — leaving
  and returning to a screen must show the same panes; never rebuild a screen to
  a single pane on focus change.
- **Pop out:** the ⇱ button on a pane (only shown when a screen has >1 member)
  moves that session into its own new tab, inserted right after the current one.
- **Drawer split button:** adds a session to the current screen (max 4).
- **Drag ghost:** while dragging, a single shadowed pill follows the cursor
  showing the dragged session name(s) joined by " + ". Drag starts after a
  ~6px move threshold from mousedown on a tab (so a click still selects).
  The drag ghost is the ONLY shadowed floating element.
- **Attention:** a running (non-visible) session that needs input flips to
  `attention` after being hidden a while — dot + tab pill go amber, top-bar
  Sessions badge and statusline count increment. Viewing/merging the session
  clears it (the real trigger is a PTY prompt awaiting input, not a timer).
- **Close:** × on a tab ends all its sessions; × on a drawer row ends that one.
  Ending a non-exited session pushes it to PREVIOUS RUN. If the active screen
  empties, fall back to the first remaining screen (or the empty state).
- **Launch:** the dialog builds the exact `claude` command from the fields and
  spawns a new session in its own new tab; resume=continue → `--continue`,
  resume=specific → `--resume <id>`.
- **Add project:** inline form appends `{name, path}`; path defaults to
  `~/projects/<name>`.
- **Animations:** `fadeUp` (8px rise, .2s) on new terminal lines and dialogs;
  `slideL`/`slideR` (.18s) for drawers; `spin` for boot spinners; `pulse` for
  attention; `blink` for the cursor. Keep durations short and quiet.

## State management
Minimum viable state (the prototype's shape is a good guide):
- `sessions: { id, name, project, model, perm, kind, status:'running'|
  'attention'|'exited' }[]` — server-owned; hydrate from the backend.
- `screens: { id, members: sessionId[] }[]`, `active: screenId`,
  `focus: sessionId`.
- `projects: { name, path }[]`, `removedProjects`.
- `prevRun: { id, sid, name, project, model, meta }[]` — from last run's
  discovery/history.
- UI: `drawer:'projects'|'sessions'|null`, `showDialog`, `dlg` form,
  `drag`/`pending` (drag state), `termBg`, `termFg` (theme indices), `themeOpen`,
  boot step, grace countdown.
- **Real data sources to wire:** WebSocket per session for PTY stream +
  scrollback replay on reattach; a presence WebSocket per window for the
  lifecycle-bound backend; the launcher's `runtime.json` (port/pid/health) for
  connection state; previous-run list from the backend's session history.

## Design tokens

**Core palette**
- App bg `#171d25`; deep bg `#12161d`; terminal ground `#0e1116`.
- Surfaces: `#1b222c` (bars/drawers/cards), `#141920` (pane header), `#10141a`
  (statusline), `#212a35` (hover), `#232b36` (active/pressed).
- Borders: `#262f3b`, `#2e3846`, `#232b36`, `#1d242e`; focus/split accent border
  `#3d5a75`.
- Text: `#dbe2ea` (primary), `#aab7c4` (headings), `#8e9cab` (secondary),
  `#7d8b9c` (muted), `#5c6b7c` (dim), `#3d4b5d` (faint).
- **Interactive accent (Steam light-blue):** `#5cb8f0` (glow
  `rgba(92,184,240,.45)`, tint `rgba(92,184,240,.08)`).
- **Green (running / "go"):** `#64c25a`, text `#7ed673`, tints
  `rgba(100,194,90,.08–.3)`, glow `rgba(100,194,90,.3)`.
- **Amber (needs-attention only):** `#e0a53c`.
- **Red / danger (exited/bypass):** `#d95c5c` (muted `#a05252`).
- Exited/idle dot: `#3d4b5d`.

**Status colors:** running `#64c25a`, attention `#e0a53c` (pulsing), exited
`#3d4b5d`.

**Terminal text ramps** (`cmd` = command/prompt, `out` = output, `dim` = muted):
- default `#e6edf3 / #b7c2cd / #66788a`
- phosphor `#d8ffd8 / #7ee787 / #3f7a4a`
- amber `#ffe9c4 / #e8b24a / #8a6a2f`
- ice `#e8f4ff / #8fc7f2 / #4a6f8a`
- paper `#ffffff / #e2e6ea / #8a9099`
- cyan `#dafcff / #66d9e8 / #3a7a83`
- violet `#efe6ff / #b39df2 / #6a5a8f`
- ember `#ffe3d6 / #f0956a / #8f5a44`
- steel `#e6e9ec / #9aa7b4 / #5a6570`
- mint `#e2fff4 / #7fe0bb / #468a72`
- Terminal backgrounds: charcoal `#0e1116`, void `#07090c`, deep blue `#0a1220`,
  navy `#0d1526`, ocean `#081a1f`, forest `#0a1510`, moss `#10160e`, plum
  `#150f1c`, graphite `#141414`, espresso `#161010`.

**Typography**
- Chrome/UI: **Barlow** (400/500/600/700).
- All data / terminal / code / tags: **JetBrains Mono** (400/500/700).
- Sizes: UI labels 10.5–12px, section headers 11px 600 letter-spacing ~1.4px,
  terminal body 12.5px / line-height 1.6, tab names 11.5px, statusline 10.5px.

**Radius** (Steam-blend keeps these tight): tabs `9px 9px 0 0`, cards/dialogs
10–12px, buttons/inputs/tags 6–8px, pills 13px, dots 50%.

**Shadows** (used sparingly — 1px lines do most of the work): panes
`0 12px 32px rgba(0,0,0,.32)`; dialog `0 24px 60px rgba(0,0,0,.5)`; popover
`0 14px 36px rgba(0,0,0,.45)`; drag ghost `0 10px 28px rgba(0,0,0,.55)`.

**Spacing:** dense. Bar/drawer padding 10–14px; grid/pane gap 10px; control
gaps 6–10px.

## Assets
- **Fonts:** Barlow + JetBrains Mono (Google Fonts in the prototype; use your
  bundled/self-hosted copies in production).
- **Icons:** the brief calls for **Phosphor** icons. The prototype uses simple
  glyphs (`>_`, `×`, `+`, `▦`, `⇱`, `▸`) and a CSS-drawn 2×2 swatch for the theme
  button — replace with Phosphor equivalents where appropriate.
- **Logo:** the `>_` mark is drawn in CSS (green mono glyph in a bordered tile);
  no image asset.
- No raster images are used.

## Files
- `session-manager-prototype.html` — the full working design reference (single
  self-contained file; all screens/states/interactions above are implemented
  with mocked data). Open it in a browser to see every interaction live. Note
  the terminal content, timers, latency, and session list are simulated.
