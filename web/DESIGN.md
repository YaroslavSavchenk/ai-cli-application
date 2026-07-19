# AI CLI Session Manager — frontend design brief ("steam blend")

Binding reference for every visual decision in `web/src/`. Direction chosen
by the user 2026-07-19 from rendered mockups (`design-mocks/steam-faithful.html`
+ `steam-terminal.html`); blend definition and history in
`memory/decisions/anti-slop-design-direction.md`. This replaces the phosphor
skin wholesale — the anti-slop rule it enforced stands unchanged.

## Direction (one sentence)

**Steam blend**: the modern Steam client's charcoal-blue surface language —
layered flat panels, one light-blue interactive accent, a green "go" button —
tuned into a dense terminal power tool: mono for every piece of data, quiet
1px structure, near-black terminals as the hero surface.

What each mock contributed:

- from **steam-faithful**: warmth — softer surface layering, comfortable
  drawer/list spacing, the green primary new-session action, human status
  language ("needs input", "exited · 1").
- from **steam-terminal**: density — compact rows, flat chrome (radius capped
  at 3px, elevation only on the drag ghost), mono-for-data typography, quiet
  mono statusbar, amber inverse attention badges.

Deliberately NOT taken from the mocks: the File/View menu bar and window
buttons (mock furniture — this runs in a chromeless browser window), the
green gradient on the primary button (gradients are banned; ours is flat),
glow box-shadows on dots.

## Tokens rationale (single system in `src/styles/tokens.css`)

### Surfaces — a cool charcoal-blue ramp, flat

`--well #0e1319 → --term-bg #0b0e13` sit below
`--surface-0 #10151c → --surface-1 #171d25 → --surface-2 #1f2731 →
--surface-3 #28323e`. The shell bands (topbar, tab gutter, statusline) are
the darkest chrome (`surface-0`); the workspace and drawer sit on the Steam
base (`surface-1`); raised chrome (pane headers, active tab, modals, hover
rows) is `surface-2`, pressed/hover one step up. Terminals stay near-black
regardless of chrome — the panes read as openings onto the real surface.
Structure is 1px lines (`--edge` / `--edge-soft`), never shadow: the ONE
box-shadow in the app is `--elev-ghost` on the drag ghost, which is genuinely
floating. Radius caps at 3px (`--radius`), 2px for chips.

### Color — one interactive accent, exclusive status hues

- **Light blue `#66c0f4` / `#1a9fff`** (`--acc`/`--acc-hot`) is the ONLY
  interactive accent: active-tab bar, focused-pane border, selection
  (app + xterm), drop zones and insertion carets, dragged dividers, links,
  focus rings, the split-count chip. Blue never encodes status.
- **Green** = running / primary "go" action only: status dots, "running"
  text, and the flat `--primary` green on new-session/relaunch/reload
  buttons (the faithful mock's warmth, minus its gradient).
- **Amber `#e6a838`** = attention ONLY: the inverse `!` badge and
  "needs input" text. Nothing else is ever amber.
- **Gray** = exited (hollow dots, muted rows); **red** only on
  kill/nonzero-exit/rejected-drop, with `--danger-hot` as the armed-confirm
  fill.

### Type — bundled sans for chrome, mono for data

- **Barlow** (self-hosted woff2, 400/600, OFL — `src/styles/fonts.css`,
  license at `src/assets/fonts/OFL.txt`) carries chrome: buttons, field
  labels, small-caps micro-headings, copy. No Inter/Roboto/Arial/Space
  Grotesk anywhere; no network font fetch (offline localhost tool).
- **Mono** (`Cascadia Mono → JetBrains Mono → …`, the same stack the
  terminal uses) carries everything that is data: tab labels, session
  names/rows, statuses, paths, directory lists, dimensions, input values,
  `kbd` chips, the entire statusline. Mono is information, not decoration.
- Sizes: 13px chrome / 12px data / 10.5px micro; hierarchy via weight
  (sans 600, mono 700) and letterspaced small caps, never a third family.

### xterm — same token file, near-black floor

The `ITheme` is built at runtime from `--xt-*` (ui/terminal.ts reads
computed styles), so the ANSI 16 and the chrome are one system by
construction. The ramp is tuned to the charcoal-blue chrome: cool
`#c7cfd6` foreground on `#0b0e13`, desaturated primaries in the same value
band, selection = the app's blue selection wash. Cursor is the foreground
color (block cursor, terminal-native); amber stays reserved for attention.

### Spacing, structure, motion

- Strict scale `2/4/6/8/12/16/24` (`--s-1..7`); density reads as order.
- Bars: 36px topbar (29px bottom-aligned tabs), 30px pane headers, 26px
  statusline, 340px drawer. All metrics are tokens — no one-off px.
- The pane grid's 1px gutters are the app structure showing through;
  dividers are invisible 9px grab strips whose 1px core lights up
  (edge-strong on hover, accent blue on focus/drag).
- Motion: color/opacity transitions at 80–120ms; one 120ms badge scale-in;
  one 150ms reject pulse. Nothing else animates, nothing exceeds 150ms.

## Component decisions

- **Tab strip** (sessions-as-tabs): Steam tabs bottom-aligned on the shell
  band — round status dot, faint chord index `n`, mono `project · command`,
  blue `+N` chip when the view holds a split, inverse amber `!`, hover/active
  raise to `surface-2`, active adds the 2px blue top bar. Insertion caret
  during drags is a lit 2px left border; merge targets get a dashed blue
  outline (dashed = prospective, everywhere).
- **Panes**: header = raised strip with status dot, grip, mono name, human
  status ("running" green, "needs input" amber, "exited · code" gray/red).
  Focus is structural: in splits the focused pane gets a 2px (--tick) dimmed-blue outline and
  its header lifts one surface step; unfocused panes dim to 0.88. A lone
  pane gets no frame — the terminal dominates undecorated.
- **Drag ghost**: the one elevated element — raised chip, blue border, real
  shadow, static −2° tilt. Invalid target = red border.
- **Drop zones**: blue wash + dashed blue border over the target half, with
  a mono small-caps label chip ("split here" / "merge here" / "open here").
- **Statusline**: quiet mono readout on the shell band — tab/pane index,
  focused session (project · title · cols×rows · conn), backend health,
  transient inverse-ink flashes, `kbd`-chip help hint.
- **Drawers** (sessions/projects): structural siblings of the grid (panes
  resize, never covered). Dense two-line mono rows, hover raise; the
  previous-run section sits recessed on the well floor above the live list
  with green relaunch chips. Projects show NAME first; the path appears only
  here, as faint mono metadata.
- **Launcher** (new-session tab): top-left config block on the terminal
  floor — sans labels, mono well inputs, green primary launch button. Not a
  centered friendly empty state.
- **Modals** (directory browser, shortcuts): flat raised panel, shell-band
  header, opaque scrim — no blur. `kbd` chips use a 2px bottom border as the
  key face (a border, not a shadow).
- **Destructive actions** stay armed two-step buttons (`kill` → `sure?` for
  3s), now filled `--danger-hot` when armed. No native confirm() anywhere.
- **Boot/restart panels**: raised panel with a 2px danger top edge, green
  primary reload — same language as everything else.
- Every drag has a keyboard/button path; every control is a real
  `<button>/<input>` with a visible blue `:focus-visible` ring. Plain keys
  (Ctrl+C, Esc, arrows) are never intercepted; app chords live exclusively
  on Ctrl+Alt. No literal File/View menu bar.

## Guarantees carried over unchanged

- Resize chain: every geometry change (divider drag, drawer toggle, tab
  switch, split change) flows container-resize → FitAddon → ws `resize` →
  `pty.resize`. Divider clamps 15%–85%; dividers are tabbable
  (`role=separator`, arrows nudge, Enter resets).
- localStorage UI schema v2 with v1 migration (state.ts) — untouched by the
  reskin.

## Slop-filter pass (against the hard reject list)

- Purple/violet gradients, hero gradients: none — flat surfaces only; the
  mock's green button gradient was deliberately flattened.
- Glassmorphism/backdrop-filter: none — opaque scrim, flat panels.
- Default-Tailwind combo: no Inter (bundled Barlow + mono), radius ≤3px,
  the single shadow is functional (drag ghost), no gray-50 anything.
- Generic SaaS shell: no icon sidebar, no card grid — shell band / tabbed
  workspace / statusline, drawers are working panels, terminals dominate.
- Emoji/sparkle iconography: none — text labels, `×`, `!`, `⠿`, dots that
  encode state.
- Centered friendly empty states: none — the empty tab is a launch form.
- Evenly-distributed timid palette: intentionally lopsided — a charcoal-blue
  field with one loud interactive blue and three exclusive status hues.
- Decoration carrying no information: every colored element encodes
  interaction or status; the only "brand" is a 10-character wordmark.
- *"Next to 100 AI dashboards, distinguishable?"* — Steam-library surface
  ramp, mono data voice, hollow exited dots, inverse amber badges, armed
  confirms: yes. *"Would a tmux power user feel at home?"* — keyboard
  chords for everything, dense mono rows, statusline readout, terminals
  that stay near-black: yes.
