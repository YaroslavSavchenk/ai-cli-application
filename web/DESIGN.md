# AI CLI Session Manager — frontend design (Nocturne)

**Source of truth:** `design/session-manager/README-v3.md` (the spec) plus
`design/session-manager/session-manager-v3.html` and
`design/session-manager/_ds/nocturne-*/styles.css` (the reference, mocked
data). This file describes the app that exists — the Nocturne UI, v0.4.0 —
and the rules it keeps. Where this file and the handoff disagree, the handoff
wins unless a deviation below says why it does not; where the handoff is
silent, the anti-slop rules in `.claude/skills/frontend-designer/SKILL.md`
apply. The handoff is the primary design source by the user's call
(`memory/decisions/handoff-design-primary.md`). The previous look ("steam
blend", the Legacy UI) survives only as the git tag `legacy-ui`.

When in doubt, the code is the witness: `web/src/styles/tokens.css`,
`web/src/styles/app.css` (an index of its `app-<topic>.css` pieces) and the
module named in each section.

## UI copy rule — no commands, flags, or code (decided 2026-07-25)

The GUI speaks plain English; CLI syntax belongs in the terminal, not in the
chrome around it (PROJECT-SCOPE "No commands, flags, or code in the UI"). The
rule is **display-only**: the values in `shared/protocol.ts`, the prefs keys
and the emitted argv are untouched. `tests/ui/ui-copy-rule.test.ts` scans every
string literal in `web/src/**/*.ts` and allows a CLI-shaped one only where a
file is listed for it.

**Sharpened 2026-09-06 (user's call):** short plain words, and no sentence
that explains the app to itself. A control is labelled; it is not described.
The one sanctioned explanation in the New session dialog is the permissions
info popover, shown only when asked for (2026-09-10).

- **One label table per vocabulary**, in `web/src/ui/launch-args.ts`, read by
  every surface that names the thing: `PERM_SHORT` (`Always ask` ·
  `Auto edits` · `Read only` · `No prompts`; the last one red wherever it
  appears), `MODEL_LABEL` / `modelLabel()`, `EFFORT_LABEL` (`Default` · `Low`
  · `Medium` · `High` · `Extra high` · `Max`), `AGENT_LABEL` (`Claude Code` —
  a product name, never the command `claude`). A label change never changes
  an emitted arg; `tests/ui/ui-launch-args.test.ts` pins both layers.
- **No command preview** anywhere (user, 2026-09-10 — v3 draws one; the rule
  stands). The fields are the statement of what will run. Resuming a
  conversation is the server's composition, never the browser's.
- **Exempt by construction:** the `Other` tool's Command field (its content IS
  a command the user types) and terminal content. Product and model names
  and permission names on GitHub's own screens (`Contents`, `Metadata`) are
  words, not code.

## Copy rules (README-v3)

- Plain sentences. **No decorative separators in text** — no `·`, `|`, `⎿`,
  `▸`; a list inside a line uses a comma (`38% of 5h, 12% of 7d`).
- **Pluralise counts**: `1 pane`, `2 panes`, `1 session`.
- **States are words**, never a code or a glyph alone (next section).
- `—` is the empty-value glyph (`Latency —`), never a half-real value.
- Honesty: an item is drawn only when something real backs it. A block with
  nothing true to show is **absent, not blank** — no placeholders, no
  "not available" rows (the A3 rule).

## State vocabulary (B11, `web/src/ui/session-state.ts`)

One readout per session, read by every surface that names a state — the pane
dot and pill, the Sessions panel row, the tab dot — so they cannot disagree.
Strongest first:

| readout | word | dot | when |
|---|---|---|---|
| `attn` | Needs your answer | amber, pulsing | the program rang the bell (BEL) |
| `exited` | Finished | neutral grey, still | the PTY is gone |
| `waiting` | Waiting for you | amber, still | Claude Code's transcript says it ended its turn |
| `working` | Working | green, pulsing | the transcript says Claude generates or runs a tool |
| `running` | Working | green, still | alive, and nothing the app reads says which (every non-Claude session) |

A pulse is a claim of knowledge: green pulses only when the transcript says
Claude works. The pill's `title` carries an exit code (`Finished, code 1`); a
code is never the state word. The tab strip's `Needs you` pill, the
statusline's `N waiting for you` and the top bar's Sessions badge count
**BELs only** — `Waiting for you` shows on the session's own pane, row and
tab dot, and nags nowhere else (user, 2026-09-22). The pulse honours
`prefers-reduced-motion` (the dot keeps its colour, the pill keeps its word).

## Tokens (`web/src/styles/tokens.css`)

The single source of every colour, size and timing; no colour literal lives
in `app.css`. Eight sections:

1. **Nocturne primitives** — verbatim from `_ds/nocturne-*/styles.css`:
   `--color-bg` `#161826`, `--color-surface` `#232532`, `--color-text`
   `#e9e9ed`, `--color-accent` `#9184d9` (blurple) and `--color-accent-2`,
   the OKLCH tonal ramps `--color-neutral-*`, `--color-accent-*`,
   `--color-accent-2-*` (100–900), `--space-1…8`, `--radius-sm/md/lg`
   (4/8/14 px), `--shadow-sm/md/lg`.
2. **Semantics** — three exclusive meanings, the accent never one of them:
   `--color-ok` (running, added, connected), `--color-attn` (attention,
   waiting, unsaved), `--color-danger` (destructive, removed, bypassed
   permissions); plus their tints and the app-only values
   (`--color-term`, `--color-scrim`, `--color-ink-on-danger`, …), each with
   its source noted in the file.
3. **Terminal palette** — `--term-bg` and the `--xt-*` slots the xterm.js
   theme is built from at runtime (`themeFromTokens()` in `ui/terminal.ts`),
   so terminal and chrome are one system. Plain hex / rgba only: xterm's
   parser does not read `oklch()`.
4. **File-type icon colours** — one ink per file family (`--badge-<kind>-fg`),
   a data table for the Files panel's icons; no chip background since B12.
5. **Type** — `--font-sans` (Inter) and `--font-mono` (JetBrains Mono first).
6. **App structure** — chrome heights and widths the handoff has no
   primitive for: top bar 48, tab chip 32, statusline 26, pane header 38,
   panel header 44, Projects drawer 272, Sessions panel 300, `--line` 1 px,
   `--tick` 2 px, `--dot` 7 px, `--fs-term` 12.5 px.
7. **Motion** — `--t-btn` .15 s, `--t-fade` .2 s, `--t-slide` .16 s,
   `--t-pulse` 1.6 s, `--t-pulse-edit` 1.2 s, `--t-spin` .7 s.
8. **z-index** — toast < row menu < modal < a modal over a modal < boot
   overlay < drag ghost.

A tint or a hover is an inline `color-mix()` at the use site, a one-off size
a literal px; neither belongs in the token file. `tests/ui/ui-a8-tokens.test.ts`
pins it: every `var()` declared, every token read (the handoff's unused ramp
steps are the one named exception), retired Legacy names cannot return.

### Type

- **Chrome: Inter** 400–700 — self-hosted variable woff2, OFL at
  `web/src/assets/fonts/OFL-Inter.txt`. A session's name is words, so it is
  Inter too.
- **Terminal, code and every data value: JetBrains Mono** 400/500/700 —
  self-hosted, official release (full glyph set for terminal coverage), OFL
  at `web/src/assets/fonts/OFL-JetBrainsMono.txt`. Fallbacks Cascadia Mono →
  IBM Plex Mono → ui-monospace.
- No runtime font fetch — an offline localhost tool.
- Body 13 px; secondary 12 px; pills and small controls 11–11.5 px;
  terminal 12.5 px with xterm's native cell metrics (line height 1 — real
  TUIs need real cell geometry).

### Edges, radii, elevation

- Radii **4 / 8 / 14**: controls and chips 4, pane cards 8, the large
  surfaces 14 (`--radius-lg`); dots are round.
- **A 1 px edge instead of a shadow.** A pane card's elevation is
  `--shadow-sm`, a 1 px neutral-800 ring. Modals, popovers, the toast and
  the drag ghost take `--shadow-md` / `--shadow-lg`: a 1 px edge plus
  ambient dark, never a soft haze.
- No gradients, no blur, no glow. The modal scrim is flat
  (`--color-scrim`).

### The accent

Blurple is an **outline and small-mark colour, never a fill**; a fill is a
tint of it (`--color-accent-900` hover, 30% selection). Where it appears:

- the one accent in the top bar — `New session`, outlined — and every
  primary button (`btn-accent`: outline, never a fill);
- the 2 px `:focus-visible` ring on every control;
- the focused pane in a split (accent-700 ring; a lone pane keeps the
  neutral edge — no competition, no frame);
- drop targets while dragging (dashed accent box, `accent-900` tint) and
  the insertion caret;
- the active text-tab underline in dialogs, the terminal selection.

Never a state. Green, amber and red keep their meanings above; neutral grey
is finished.

## Shell anatomy

Vertical flex, 100 vh, no page scroll (`web/src/main-shell.ts`, `buildShell`):

1. **Top bar, 48 px** — `>_` logo tile + `Session Manager`; the `Files`,
   `Projects`, `Sessions` toggles (the active one is the only filled
   control; Sessions carries an amber count badge of sessions that rang the
   bell); spacer; the connection dot + `Connected` / `Offline` (real
   reachability); the GitHub account chip (opens Add a project on its
   GitHub tab); the Settings gear — icon-only, Phosphor, `aria-label`
   `Settings`; `New session`.
2. **Middle row** — Files panel or Projects drawer (left, one at a time:
   opening Projects hides Files without forgetting it), the pane area, the
   Sessions panel (right). All are flex siblings: opening one resizes the
   panes through the real fit → `resize` → PTY chain, never covers them.
3. **Tab strip, bottom** (settled 2026-07-20) — one tab per screen; see
   below.
4. **Statusline, 26 px** — `N sessions` (still running), `N panes` (of the
   active tab, terminals and editors alike), amber `N waiting for you` (BELs
   only), spacer, a transient flash notice when there is one, `Latency N ms`
   (presence ping), `Up 2h 15m` (backend uptime), and the
   `Keyboard shortcuts` button. No separate health item, no grace countdown.

## Tab strip (`web/src/ui/tabs.ts`)

32 px chips on the app ground above one hairline; **the active tab is the
only filled one** (`--color-surface`, neutral-800 edge). A tab: a 7 px state
dot (the strongest readout of its sessions; no dot when it holds none), the
name, an amber dot while a file in it is unsaved, a count pill when it holds
more than one **pane**, `Needs you` (amber) when a session in it rang the
bell, and `×`. `Home` is the fixed first tab: no `×`, never dragged. After
the tabs: `+` (New session) and the right-aligned hint `Drag a tab onto
another to show them side by side`.

A `×` on a tab holding sessions **ends** them: the armed two-step — red fill,
the word `sure?` — unless Settings → Preferences → `Confirm before ending a
session` is off, which makes the first click the act. A tab holding only
files kills nothing, so it asks only the unsaved-text question.

## Panes (`web/src/ui/panes.ts`)

Up to four panes per tab, fixed split shapes, draggable dividers between
them (keyboard-nudgeable, `role=separator`). A pane is a neutral-900 card,
radius 8, `--shadow-sm` edge. Unfocused panes are **not dimmed** — a terminal
you can read is the point; focus is the accent ring.

### Session pane

- **Header, 38 px**: state dot (8 px), session name (Inter 13/500), project
  **name** (12 px, never a path), spacer, the state pill (the word; amber
  tint for `Needs your answer`, amber word for `Waiting for you`, grey for
  `Finished`), the connection chip only while degraded (`Reconnecting` /
  red `Lost`), `Own tab` only when the tab holds more than one pane, and —
  top right, on **every** session pane, a one-pane tab included — the
  **End session** button (B8, user's decision 2026-09-22): a quiet Phosphor
  `X`, neutral ink, danger ink on hover and while armed; `aria-label` and
  `title` `End session`. It ends the session exactly like the tab `×` and
  the Sessions panel's end control (`killSession`) and follows `Confirm
  before ending a session`: on, the first click arms (`Sure?`) and the
  second ends; off, one click ends.
- The whole header is a drag source (onto a pane = swap, onto the tab strip
  = own tab); a press on any button in it never starts a drag. Keyboard
  twins: Ctrl+Alt+Shift+arrows and `Own tab`.
- **Banner** under the header when the session finished (`Finished, code
  N`, `Start it again`, `End session` armed the same way) or is gone from
  the server (`Close pane`). The buffer below stays readable.
- **Terminal** on the terminal ground (`--term-bg`, themed — see Terminal
  colours).
- **Status bar** under the terminal (B1): label + mono value pairs that
  wrap, in the v3 order `Model`, `Mode`, `Branch`, `Cost`, `Context`,
  `Usage`, `Time`, `Changed`, fed by the session's argv and what Claude Code
  itself reported. Items follow the Settings → Status bar checklist; `Usage`
  turns amber at 80% or more; a bypassed permission mode reads red. No item
  without a real value; for a non-Claude session the bar is absent. Known
  limit: `Mode` is the mode the session was started with — Claude Code's
  payload carries no live mode, so a change inside the session (shift+tab)
  is not shown; the Settings row's caption says so, and so does Claude
  Code's own line (`server/statusline.mjs`).
- **Background agents** table under it (B7): name, task, time, tokens, from
  Claude Code's own subagent transcripts. Behind the switch Settings →
  Status bar → `Background agents under the terminal`, **default off** (B11:
  Claude Code draws its own task list in the terminal). At most **four
  running** rows (oldest first), then — only when fewer than four run — the
  one most recently finished; the rest are counted, `+N working` /
  `+N finished`, never silently hidden. Never rendered empty, never for a
  non-Claude session.

### Editor pane (A10b, live since B4)

Same card, same 38 px header, a quiet ground (`--color-term`, never the
themed terminal ground). The header is a strip of file tabs — name, an amber
dot while unsaved, its own `×` — at most **four** per pane, then the pane's
`×` (closing files kills nothing, so no armed confirm; unsaved text asks
`Discard unsaved changes …?`). The body is the active tab: line-number gutter,
the editable mono text, `Save` / `Saving…` / `Saved`; a diff tab from a
commit is read-only. A file tab is its own drag source inside the header.

## Files panel (`web/src/ui/files.ts`)

Left, resizable **200–520 px** by its right edge (pointer or arrow keys).
Opens without a session: its header then reads `Home` (deviation from v3,
user 2026-09-15); otherwise it names the folder of the focused pane (a
session's project, or its working folder; a file pane's tab folder). Three
tabs:

- **Files** — the real tree of that folder, lazy per folder; Phosphor folder
  icons and a real 16 px icon per file type (B12: a language's own logo, else
  a category glyph, in its family's ink from the token table); a file the session
  is editing, and its ancestors, pulse amber (1.2 s). Click opens it in an
  editor pane. Many rows can be selected (click, ctrl-, shift-click, the
  keyboard); the row menu (right-click, ContextMenu key, Shift+F10) offers
  `Open`, `Open beside`, `Copy` (to the Windows clipboard, native window
  only), `Paste`, `New file`, `New folder`, `Refresh`, `Delete` (red, after
  a separator; permanent, asked once; never on the root or a project root).
  Files dragged or pasted in from Windows are copied into the folder, one
  question per drop when names clash.
- **Changes** — what the repository changed since its last commit, `+a -d`
  per file.
- **Commits** — the history, ten a page; a commit opens the **commit view**
  over the pane area: title, author initial, `committed <when>`, branch and
  hash chips, `Open on GitHub` only when `origin` is on github.com (absent
  otherwise, never disabled), `N files changed +A -D` with a five-block bar,
  one collapsible unified diff per file. `Back to sessions` returns.

Changes and Commits exist only where a repository can be (A11).

## Sessions panel and Projects drawer

- **Sessions** (right, 300 px, `ui/sessions.ts`): `Running now` — dot, name,
  `Side by side`, and an end control that arms into the word `End`; the meta
  line names the project and what runs in it, or the state word.
  `Earlier` — every ended session the app launched, in a **folder per
  project** (a decided feature; v3 draws a flat list), each with resume or
  start-again and an armed forget.
- **Projects** (left, 272 px): names, never paths as the label; `+` opens New
  session preset to the project; removal is armed.

## Dialogs

Modals are top-anchored where their height changes (New session, Settings),
over the flat scrim, `fadeUp` .2 s, Tab trapped, Escape and backdrop close,
focus returns to the control that opened them. Every destructive answer is
the outlined danger button; the primary is the accent outline.

- **New session** (`ui/launch.ts`): a tool grid, two per row — `Claude
  Code`, `Codex`, `Gemini CLI`, `Grok`, `Terminal`, `Other`; a tool the
  backend cannot find is an inert card reading `Not installed`; hidden cards
  come from Settings → Preferences. `Name` (placeholder = the project's
  name) and `Project`. An agent adds `Model`, `Effort` (absent where the tool
  has none), `Permissions` cards with the one info popover, and `Start from`
  (fresh, continue, or a listed earlier conversation). A tool that needs an
  API key and has none shows one quiet notice with a way into Settings.
  `Terminal` adds Shell cards: Bash, Zsh, PowerShell, Command Prompt.
  `Other` adds the Command field. Entry points: top bar, tab-strip `+`,
  project row `+`, the empty state, Ctrl+Alt+T.
- **Add a project** (`ui/newproject.ts`): `New folder` / `Clone a
  repository` / `From GitHub`, and the folder picker in the same idiom.
- **Shortcuts overlay**, **delete** and **drop** dialogs, the unsaved-text
  question, the restart confirmation, the update toast and the boot overlay
  all wear the same language.

### GitHub credential input — binding (design gate, `ui/github.ts`)

- The token field is `type=password`, `autocomplete=new-password`,
  `spellcheck=false`, has **no `name` attribute**, and is **not inside a
  `<form>`** — no browser save-password prompt.
- Its value is read and written only through the `.value` property, never an
  attribute; the credential's whole client lifetime is one submit — read
  once, sent, cleared. No web storage, no URL, no prefs write, ever.
- Untrusted strings render through `textContent` (the repo's zero-`innerHTML`
  rule).
- **Storage honesty ceiling:** nothing may say keychain, keyring, encrypted,
  secure, vault or protected (`memory/knowledge/wsl-0600-not-a-boundary.md`);
  the strongest sentence is `storageNote(true)`. The copy lives in
  `ui/github-model.ts`, pinned by `tests/ui/ui-github-model.test.ts`.

## Settings (`web/src/ui/settings.ts`)

A modal with a left nav of five pages, all live:

- **Status bar** — two switches, `Inside the terminal` (Claude Code's own
  line, default off) and `Under the terminal` (the pane status bar, default
  on), the third switch `Background agents under the terminal` (default
  off), then the item checklist both bars read, each row showing the literal
  text it draws. A notice names running Claude sessions started without a
  status line, and exists only when there are some.
- **Preferences** — API keys (saved / not saved, a key never comes back),
  which tools the New session dialog shows (at least one stays), and the
  defaults `Reopen tabs on start`, `Confirm before ending a session`,
  `Follow output`.
- **Keyboard** — the whole shortcuts table, drawn from the same rows as the
  overlay (`ui/shortcuts-rows.ts`).
- **Terminal colours** — see below.
- **Background service** — version, uptime, `Check for updates`, `Restart
  service`.

## Terminal colours (B9)

Presets plus a custom ground and text colour; **ground and text only**, the
**terminal only** (`memory/decisions/terminal-colours-shape.md`). The page
overrides six `:root` slots (`--term-bg`, `--xt-fg`, `--xt-white`,
`--xt-bright-white`, `--xt-cursor`, `--xt-bright-black`) through
`ui/theme.ts`; Nocturne is the absence of those overrides. The app chrome,
the accent and the status colours are **never themed**, and the ANSI hues
stay semantic. Surfaces that merely look terminal-ish — editor, diff, input
wells, boot overlay — sit on `--color-term`, so a light ground never lands
under app ink; the pane status bar and agents table take the theme's quiet
steps so they stay readable on any ground.

## Motion

`fadeUp` .2 s (dialogs, popovers, new content) · `slideL` / `slideR` .16 s
(panels) · `pulse` 1.6 s (state dots, attention) · the edited-file pulse
1.2 s · `spin` .7 s (boot-step spinner) · control transitions .15 s. Nothing
else animates. The state-dot pulses (`Working`, `Needs your answer`) stop
under `prefers-reduced-motion`; the word says it without them.

## Recorded deviations from the handoff (still true)

- **No command preview** in New session (copy rule, user 2026-09-10).
- **Files panel opens without a session**, header `Home` (user 2026-09-15).
- **Earlier keeps folders per project** (user 2026-09-06).
- **Status bar:** no `Active skill` (nothing reports it, user 2026-09-16);
  `Usage` joins its two windows with a comma (copy rule).
- **Preferences has no notifications row** until it can do something (part
  C1, user 2026-09-22).
- **Armed two-step confirms** on every control that ends a session or
  forgets one (the pane's and the tab's `×`, the Sessions panel's `End`);
  Files Delete asks in its dialog instead — no native `confirm()`; the
  prototype killed without asking.
- **Icons are inline SVG** transcribed as path data — no icon package (open
  decision 5, settled at B12): the chrome's Phosphor glyphs (`ui/icons.ts`),
  file types (`ui/icons-files.ts`: Simple Icons logos, CC0, and Phosphor
  category glyphs) and tool marks (`ui/icons-tools.ts`: the four agents' real
  logos from LobeHub's mono set, MIT, all as one single-colour silhouette;
  Phosphor terminal and command). Licences in `web/src/assets/icons/`. The
  tool mark sits in the New session and Settings tiles, on a tab (its first
  pane's), in the pane header, on the Sessions rows and once in the
  Background agents header.
- **Terminal line height** is xterm's native 1, not the mock's 1.6.
- **Connection** reads `Offline` when the backend is unreachable; the mock
  had no failure mode.

## Guarantees

- Resize chain: every geometry change (divider, panel toggle, tab switch,
  split change) flows container resize → FitAddon → ws `resize` →
  `pty.resize`.
- Plain keys (Ctrl+C, Esc, arrows) are never intercepted; app chords are the
  Ctrl+Alt family with the AltGraph guard (PROJECT-SCOPE, Hard technical
  constraints).
- Sessions are server-side; the UI attaches views, xterm opens only on
  attached, measurable nodes.
- Every control is a real `<button>` / `<input>` with the visible accent
  focus ring; no hover-only affordance; an icon-only control carries its
  name in `aria-label`. Every drag has a keyboard or button twin.
- Projects show their name everywhere.
- Fiction stays cut: no grace countdown (any UI able to show it keeps the
  backend alive), no launcher-lifecycle steps in the boot overlay (the page
  can never witness them).

## Slop filter (frontend-designer reject list)

- No gradients, no blur, no glow; elevation is a hairline edge plus ambient
  dark.
- Inter is the handoff's deliberate choice; the "default Tailwind" look is
  the combination — Inter + rounded card grid + soft shadows + gray-50 —
  and the rest of the system has none of it.
- No icon sidebar, no KPI tiles; the shell is top bar, terminal cards,
  bottom tab strip, statusline.
- No emoji; icons are Phosphor glyphs plus file-type and tool logos drawn
  as single-colour silhouettes (never brand colours), state is a dot plus a
  word.
- Every coloured element encodes something: accent = interactive, green =
  running, amber = attention or waiting, red = danger, grey = finished.
