# AI CLI Session Manager — frontend design brief

Written before implementation, per `.claude/skills/frontend-designer/SKILL.md`.
This is the binding reference for every visual decision in `web/src/`.

> **Status (2026-07-19):** the phosphor skin documented below is scheduled
> for replacement by the "steam blend" direction (mockups in
> `design-mocks/`, decision in
> `memory/decisions/anti-slop-design-direction.md`), along with a
> sessions-as-tabs interaction model. Until that redesign lands, this file
> remains binding for the shipped UI. The anti-slop rule stands regardless.

## Direction (one sentence)

**Phosphor instrument panel**: a warm-graphite, monospace-only control surface
in the lineage of tmux statuslines and mission-control consoles, where the
terminal palette *is* the app palette and every strip of chrome is a readout,
not decoration.

Committed fully to dense-industrial. No cards, no shadows, no gradients, no
rounded anything. Structure is drawn exclusively with 1px lines, solid inverse
blocks, and two loud accents that each mean exactly one thing.

## Tokens rationale (single system in `src/styles/tokens.css`)

### Palette — designed around the xterm 16-color scheme, not bolted onto it

Base is a warm, slightly green-shifted graphite ramp (CRT-phosphor lineage,
not neutral-gray "dark mode"): `#0b0d0c → #101312 → #161a18 → #1f2521`.
The terminal background (`--bg-term`, `#101312`) is the visual floor of the
whole app; chrome sits one step up (`--bg-raise`) so panes read as openings
cut into the panel.

Two accents, each with a single meaning — an intentionally lopsided palette:

- **Phosphor green `#7edc93`** = focus/alive. Focused-pane edge, active-tab
  tick, running status, primary action. Never decorative.
- **Signal amber `#ffab2e`** = attention. Badges (`!` in an inverse amber
  block, readable across the room) and the terminal cursor — the two places
  your eye must go. Nothing else is ever amber.
- Danger red `#e5654f` only on kill/exit≠0.

The ANSI 16 are tuned to the same warmth and value range (ivory `#d6d3c2`
foreground, desaturated primaries) so TUI output and app chrome are one
picture. The xterm `ITheme` is built at runtime by reading the `--xt-*`
custom properties — one source of truth, enforced by code.

### Type

Monospace everywhere, deliberately — the UI text is aligned columnar data
(statuses, dimensions, indices), which is what mono is *for*. Stack:
`Berkeley Mono → JetBrains Mono → Cascadia Mono → IBM Plex Mono → Fira Code →
ui-monospace…`. No webfont fetch: this app is a localhost tool inside WSL and
must work offline; the stack degrades to Cascadia/Consolas on Windows
browsers, which fits the identity. No Inter/Roboto/Arial/Space Grotesk
anywhere. Hierarchy comes from size (13/12/10px), weight, and letterspaced
SMALL-CAPS micro-labels — never from a second family.

### Spacing, radii, lines, motion

- Strict spacing scale: `2 / 4 / 6 / 8 / 12 / 16 / 24 px` (`--s-1..--s-7`).
  Density reads as order because nothing falls off-scale.
- Radius: **0** globally. Sharp corners are the panel language.
- All structure is `1px solid var(--edge)`; emphasis via `--edge-strong`,
  never via shadow or blur. The pane grid's 1px gutters are the app
  background showing through — dividers carry the layout information.
- Motion: color/opacity/border transitions at 80–120ms; one 120ms scale-in
  when an attention badge arrives. Nothing else animates.

### Focus & attention (structural, never glowy)

- Focused pane: 1px phosphor-green outline (offset −1, layout-stable) plus a
  solid green square "record light" in the pane header. Unfocused panes dim
  to 85% opacity only in multi-pane layouts.
- Attention: inverse amber block containing `!` — on the pane header, on the
  tab, on the drawer row, and a count on the sessions toggle. Visible from
  another monitor, per the skill's requirement.

## Component decisions

- **Shell**: 30px top bar (brand block, tmux-style `n:name` tab strip, layout
  switcher with 1px-line miniature diagrams, drawer toggles, `?`), pane grid
  filling everything, 24px statusline (tab/pane index, focused session
  readout `project · title · cols×rows · conn-state`, flash messages, help
  hint). The terminal dominates; both bars are pure readout.
- **Destructive confirm** is an armed two-step button (`kill` → inverted
  `sure?` for 3s) instead of a modal — keyboard-reachable, in-place, no
  native `confirm()` dialog. Used for session kill, project delete.
- **Empty pane** is a launch form (project by name, preset, model, title),
  top-left anchored over the pane floor — a config block, not a centered
  friendly empty state. Custom command is documented in-field as plain
  whitespace split (no quoting, no shell).
- **Exited/dead sessions** get a full-width structural banner strip under the
  pane header (`exited · code 1` / `session gone`), buffer stays readable.
- Every shortcut has a visible control; every control is a real
  `<button>/<input>` (tab-reachable, `:focus-visible` ring in focus green).
  Plain keys (Ctrl+C, Esc, arrows) are never intercepted; app chords live
  exclusively on Ctrl+Alt.

## Phase-2 additions (2026-07-19) — extending the direction, not replacing it

### Split dividers (layouts 2/3/4)

- The 1px gutter stays the ONLY visible line at rest. Each divider is an
  invisible `--divider-hit` (9px) strip centered on the gutter; its 1px core
  surfaces only on interaction: `--edge-strong` on hover, `--focus` on
  keyboard focus and while dragging (green = alive/being manipulated).
- Pointer-drag adjusts the fraction; min pane 15% (`SPLIT_MIN/MAX` in
  state.ts). Double-click resets to equal. Keyboard: dividers are tabbable
  (`role=separator`), arrows nudge 2%, Enter resets. No focus ring box — the
  lit 1px core IS the focus indicator.
- Ratios persist per tab (`split: {col,row}`) in the existing localStorage
  blob, validated/clamped on rehydrate like every other UI field.
- Layout 3's row divider spans only the right column; at crossings the
  column divider wins the 9px overlap square (deterministic, z-index 6 vs 5).
- Every ratio change flows through grid CSS vars -> pane resize ->
  ResizeObserver -> debounced fit -> ws resize. Nothing bypasses the chain.

### Move / swap sessions between panes

- `ctrl+alt+shift+←↑↓→` moves the focused pane's session to the neighbor
  (swap when occupied); focus follows the moved session.
- Pointer twin: a braille grip `⠿` at the left of every occupied pane header
  (`--ink-faint`, ink on hover, cursor grab) — drag it onto another pane.
  The drop candidate shows a 1px DASHED `--focus` outline: dashed =
  prospective, solid = focused. Source pane dims to 0.6 while dragging.

### Relaunch (exited banner)

- First action in the exited strip: `relaunch` in `--focus` (green = primary
  action, per the accent contract). POSTs a new session with the same
  project/cwd/command/args/title/cols/rows, attaches it to the pane, then
  DELETEs the exited one. Detach and armed delete stay as quiet actions.

### Reliability readouts

- Statusline right gains `backend: unreachable` in `--danger` after two
  consecutive session-poll network failures; the first success clears it.
- Any REST 401/403 after boot = the backend restarted (token rotated): the
  page is replaced by the boot-err panel pattern — danger-bordered box,
  small-caps `backend restarted — reload` heading, phosphor reload button.
  Full takeover on purpose: everything behind it holds a dead token.

### Attach polish

- Double-click a sessions-drawer row = the attach button (which remains the
  keyboard path); rows get a `--bg-hover` hover as the interactivity cue.
  Attaching and launching both put the keyboard straight into the terminal.

### Debt paid

- The active-tab/toggled-button tick is now a `--tick` (2px) top border
  (transparent in every other state to keep labels optically centered) —
  the inset box-shadow is gone; "no shadows" now holds everywhere.
- One-off px values moved to tokens: `--badge-block`, `--mark-size`,
  `--mini-w/h`, `--form-w`, `--modal-w`, `--modal-w-wide`, `--panel-w`,
  `--dirlist-min-h`, `--sc-keys-w`, `--divider-hit`, `--tick`.

## Slop-filter pass (against the hard reject list)

- Gradients/glassmorphism/backdrop-filter: none — flat panels, opaque scrim.
- Default-Tailwind combo: no Inter, radius 0, no soft shadows, no gray-50.
- SaaS shell: no icon sidebar, no card grid; the shell is bar/grid/bar.
- Emoji or sparkle iconography: none — text labels, `!`, `×`, line diagrams.
- Centered friendly empty states: none — empty pane is a launch form.
- Timid even palette: intentionally lopsided (graphite field, two loud
  single-meaning accents).
- Decoration with no information: every colored element encodes state
  (focus, attention, run/exit, connection); the only "brand" is a 5-char
  text block in the top bar.
- *"Next to 100 AI dashboards, distinguishable?"* — mono-only type, 0 radius,
  tmux-style `n:name` tabs, inverse-block badges, amber cursor: yes.
  *"Would a tmux power user feel at home?"* — the tab strip, statusline and
  armed-confirm patterns are lifted from that lineage: yes.
