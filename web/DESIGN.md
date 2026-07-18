# AI CLI Session Manager — frontend design brief

Written before implementation, per `.claude/skills/frontend-designer/SKILL.md`.
This is the binding reference for every visual decision in `web/src/`.

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
