# AI CLI Session Manager — frontend design (handoff transcription)

Binding reference for every visual decision in `web/src/`. Since 2026-07-20
the **hi-fi handoff in `design/` is the primary design source** (user's call,
reversing the 2026-07-19 "repo tokens win" rule; rationale in
`memory/decisions/handoff-design-primary.md`). This file transcribes the
handoff — `design/README.md` (spec) + `design/session-manager-prototype.html`
(reference behavior) — plus the recorded deviations below. Where this file
and the handoff disagree, the handoff wins; where the handoff is silent, the
anti-slop rules in `.claude/skills/frontend-designer/SKILL.md` still apply.

## Direction (one sentence)

**Steam blend, hi-fi**: a Steam-client-lineage shell — gradient topbar,
bottom-aligned tab strip, charcoal-blue surface stack, one light-blue
interactive accent — around floating terminal cards on a radial-lit deep
ground, with a user-themable terminal palette (10 grounds × 10 text ramps)
and mono type carrying every piece of data.

## Precedence and user-sanctioned exceptions

The frontend-designer skill's hard reject list normally bans gradients,
backdrop blur, shadows and glow. The handoff is the **user's own design**;
its specific choices are sanctioned and REQUIRED:

- the topbar gradient `linear-gradient(180deg,#1f2833,#1b222c)` and the
  pane-area radial lift `radial-gradient(1100px 520px at 32% -10%,#1b232f,#12161d)`;
- exactly four shadows — pane `0 12px 32px rgba(0,0,0,.32)`, dialog
  `0 24px 60px rgba(0,0,0,.5)`, popover `0 14px 36px rgba(0,0,0,.45)`,
  drag ghost `0 10px 28px rgba(0,0,0,.55)`;
- glow accents: active-tab bar `box-shadow:0 0 14px 2px rgba(92,184,240,.45)`,
  connected-dot glow, green "go"-button hover glow `0 0 18px rgba(100,194,90,.3)`;
- radii up to 12–13px by role (see tokens);
- the launch-dialog backdrop blur (`backdrop-filter:blur(4px)`) and its
  header gradient `linear-gradient(180deg,#202935,#1b222c)`.

Everything NOT specified by the handoff stays under the reject list: no new
gradients, no additional shadows, no decorative inventions.

## Tokens (single system in `src/styles/tokens.css`)

### Surfaces

- App bg `#171d25`; deep bg `#12161d` (logo tiles, inset inputs, add-form
  floor); terminal ground `#0e1116` (themable, see Theme system).
- `#1b222c` bars/drawers/cards · `#141920` pane header · `#10141a`
  statusline · `#212a35` hover · `#232b36` active/pressed.
- Borders: `#262f3b` (structural), `#2e3846` (controls), `#232b36` (quiet),
  `#1d242e` (pane-header underline), `#3d5a75` (focus/split accent border).

### Text ramp

`#dbe2ea` primary · `#aab7c4` headings/wordmark · `#8e9cab` secondary ·
`#7d8b9c` muted controls · `#5c6b7c` dim/statusline · `#3d4b5d` faint/hints.

### Color roles (exclusive meanings)

- **Interactive accent `#5cb8f0`** (glow `rgba(92,184,240,.45)`, tint
  `rgba(92,184,240,.08)`): active-tab bar, split badge, pop-out/split
  buttons, drop hints, focus rings, selection. Never status.
- **Green `#64c25a`** (text `#7ed673`, tints `.08–.3`): running dots, the
  "go" family (+ New session, Add, relaunch), active-session counts, the
  logo glyph, connected dot.
- **Amber `#e0a53c`**: needs-attention ONLY — pulsing dots, `input` tab
  pill, Sessions-button count badge, `awaiting input` statusline item.
- **Red `#d95c5c`** (muted `#a05252`, border tint `#4a2f33`): danger —
  kill/remove hovers, armed confirms, nonzero exits, permission-bypass tags.
- Exited/idle dot `#3d4b5d`.

### Terminal theming (the ONE palette with the chrome)

The xterm `ITheme` is built at runtime from the `--xt-*` custom properties
(`themeFromTokens()` in `ui/terminal.ts`) — the terminal palette and the app
palette remain one system by construction. Defaults: ground `#0e1116`, text
ramp "default" (`cmd #e6edf3 / out #b7c2cd / dim #66788a`) mapped as
out → foreground/white, cmd → brightWhite/cursor, dim → brightBlack. ANSI
status hues are semantic and never themed: red `#d95c5c`, green `#64c25a`,
yellow `#e0a53c`, blue `#5cb8f0`, magenta `#b39df2`, cyan `#66d9e8`.

The **theme popover** (handoff §9) writes user selections onto the same
variables: 10 grounds (charcoal `#0e1116`, void `#07090c`, deep blue
`#0a1220`, navy `#0d1526`, ocean `#081a1f`, forest `#0a1510`, moss `#10160e`,
plum `#150f1c`, graphite `#141414`, espresso `#161010`) × 10 ramps (default,
phosphor, amber, ice, paper, cyan, violet, ember, steel, mint — exact values
in `design/README.md`). Ground drives both the xterm background and the pane
card background. Persisted in localStorage under its own key (`ai-sm:theme:v1`,
independent of the UI-arrangement schema), but the durable copy lives
server-side in `prefs.json` (an opaque `UiPrefs` bag, fetched once at boot and
reconciled server-wins); localStorage is only a same-run cache, since the
backend's per-run port change gives each restart a fresh origin and bucket.
Scanline overlay (1px dark lines
every 3px, `mix-blend-mode:multiply`, terminal bodies only) is a popover
toggle, default OFF.

### Typography

- **Chrome: Barlow** 400/500/600/700 — self-hosted woff2 (latin subset,
  Google Fonts pipeline), OFL at `src/assets/fonts/OFL.txt`.
- **Data + terminal: JetBrains Mono** 400/500/700 — self-hosted woff2
  (official JetBrains release, full glyph set for terminal coverage), OFL at
  `src/assets/fonts/OFL-JetBrainsMono.txt`. First in the mono stack;
  fallbacks Cascadia Mono → IBM Plex Mono → ui-monospace → Menlo/Consolas.
- No runtime network font fetch — offline localhost tool.
- Sizes: wordmark 12px/600/ls 1.6px; UI controls 12px; section headers 11px
  600 ls 1.4px; tab names mono 11.5px; session names mono 12px; row names
  13px; statusline + hints mono 10.5px; tags mono 9.5px; terminal 12.5px.

### Radius by role

Tabs `9px 9px 0 0` · pane cards/dialogs 12px · popover/small cards 10px ·
buttons/inputs/tags 6–8px (7px default) · preset pills 13px · dots 50%.

### Spacing & structure

Dense: topbar 44px (padding 0 14px) · tab strip ~35px (30px tabs,
padding 5px 8px 0, gap 3px) · statusline 23px · pane header 30px · pane grid
gap/padding 10px · projects drawer 272px · sessions drawer 296px · control
gaps 6–10px.

### Motion (handoff set, ≤.2s + sanctioned pulses/spin)

`fadeUp` .2s (dialogs, popover, add-form) · `slideL`/`slideR` .18s (drawers)
· `pulse` 1.6s infinite (attention dots/pills/badges — the sanctioned
attention animation) · `spin` .7s (boot-step spinner, handoff §10 — a
progress indicator, not decoration) · button transitions .15s · cursor
blink is xterm's own. Nothing else animates.

## Shell anatomy (handoff §1–§5)

Vertical flex, 100vh, no page scroll:

1. **Topbar 44px** — gradient band. Left: 18px logo tile (border `#2e3846`,
   radius 7px, bg `#12161d`, green mono `>_` 8px/700) + `AI SESSION MANAGER`
   wordmark. Right: Theme button (CSS 2×2 swatch icon: green/blue/amber/
   violet), Projects toggle, Sessions toggle (amber count badge when any
   session awaits input), 1px divider, connection indicator (green glowing
   dot + `connected`, derived from real reachability: poll ok / presence
   pong; red `offline` when the backend is unreachable), and the primary
   green `+ New session`. Toggled buttons: bg `#232b36`, text `#dbe2ea`.
2. **Middle row** — optional projects drawer (left) · pane area (radial
   lift) · optional sessions drawer (right). Drawers are structural flex
   siblings: opening one resizes panes through the real fit → ws-resize
   chain, never covers them.
3. **Tab strip ~35px, BOTTOM** (Steam-style; settled user decision
   2026-07-20) — bg `#1b222c`, top border `#262f3b`, tabs bottom-aligned.
   Tab = one view (1–4 sessions): status dot, mono 11.5px name (split views
   join member names with " · "), `▦ N` split badge (mono 9.5px, border
   `#3d5a75`, `#5cb8f0`) when >1 session, pulsing amber `input` pill when a
   member awaits input, per-tab `×` (armed two-step for session views).
   Active tab: bg `#0e1116` (terminal ground), 1px `#262f3b` border, glowing
   2px `#5cb8f0` top bar inset 12px. After the tabs: ghost `+` (opens the
   launch dialog), then right-aligned faint hint
   `drag a tab onto a tab or pane to merge · ⇱ splits it back out`.
4. **Statusline 23px** — bg `#10141a`, mono 10.5px `#5c6b7c`. Left: `ws
   <n> ms` (presence ping round-trip), `<n> sessions · <n> panes`, amber
   `<n> awaiting input` when >0, then the focused-session readout
   (project · title · cols×rows · conn state — carried over, it is
   information). Right: transient flash notices, `up HH:MM:SS` (from
   `GET /api/runtime` startedAt), `pty ok` (health-derived; replaced by red
   `backend unreachable` on repeated poll failure), `?` shortcuts hint
   (a real button). Intentionally NO separate "healthy" item (handoff
   removed it — the topbar dot covers connection) and NO grace countdown
   (fiction cut, see below).

## Pane cards (handoff §3)

- Card: bg = themed terminal ground, radius 12px, border `#262f3b`,
  `overflow:hidden`, pane shadow. Grid templates by count (1/2/3/4) with
  10px gap/padding; split fractions are draggable dividers in the gap
  (invisible ~10px grab strips, keyboard-nudgeable, `role=separator` —
  carried over unchanged).
- Header 30px (`#141920`, underline `#1d242e`): status dot (green running /
  pulsing amber attention / hollow gray exited), mono 12px/500 session name,
  11px `#5c6b7c` project name, spacer, model tag + permission tag (mono
  9.5px chips, border `#2e3846`; permission tag `#d95c5c` when the session's
  args contain `--dangerously-skip-permissions` or `--permission-mode
  bypassPermissions`), connection chip only while degraded (`reconnecting…`
  / red `lost`), and `⇱ own tab` (accent-blue chip) ONLY when the view holds
  more than one pane. Tags derive from `SessionInfo.args` client-side — no
  protocol fields. The whole header is a drag source (swap panes / extract
  to strip); keyboard equivalents: ctrl+alt+shift+arrows, the ⇱ button.
- Focused pane in a split: inner `outline:1px solid #3d5a75;
  outline-offset:-1px`. A lone pane carries no focus frame.
- Exited/dead banners stay structural strips under the header (relaunch /
  delete, armed confirms); the buffer below stays readable.
- Drop overlay during drags: dashed `#5cb8f0` box + accent tint over the
  target half/whole, mono label (`split here` / `merge here`).

## Drawers (handoff §6–§7)

- **Projects (left, 272px)**: header `PROJECTS` + `+ add`. `+ add` reveals
  the existing inline add flow (name, directory via the server-side browser
  modal, optional default model/mode) on a `#12161d` card with `#3d5a75`
  border — the directory browser is kept deliberately (real backend fs, no
  free-text path field, no add-project regression; the handoff's
  `~/projects/<name>` autofill applies to a text path input we don't have).
  Rows: name 13px/500, spacer, `+` (opens the launch dialog pre-set to the
  project), `×` (armed remove), faint mono path (the ONE place a path is
  shown as project metadata), meta line `N active sessions` in green when
  >0 else `no active sessions` in `#3d4b5d`.
- **Sessions (right, 296px)**: `ACTIVE · N` rows — dot, mono name, model
  tag, `split` (append into the current view, max 4 — the button twin of
  drag-to-merge), `×` (armed kill); the row body is a real button: click
  activates that session's view and focuses it. Meta: project · status
  (· tab place when assigned). `PREVIOUS RUN · N` rows keep the existing
  crash/shutdown relaunch (`--continue` for claude) + forget + dismiss-all
  exactly; footer note `relaunch resumes claude with --continue`. NO per-id
  `--resume <id>` (fiction cut). Slide-in .18s.

## Launch dialog (handoff §8 — R3, replaces launcher-as-tab)

THE way to create a session (`web/src/ui/launch.ts`). Modal over the ONE
sanctioned blurred backdrop (`rgba(8,10,14,.55)` + `blur(4px)`, centered):
560px card, radius 12, dialog shadow, fadeUp. Header on the sanctioned
`#202935→#1b222c` gradient: 30px logo tile (radius 9) · `Launch session`
14px/600/ls .8px · mono subtitle `spawns a real pty on the backend ·
survives hidden panes` · bordered `×` (danger on hover). Body (18px 20px,
16px stack):

- **Preset chips** (pill 13px, mono 10.5): `deep work · opus · acceptEdits ·
  continue` / `quick fix · sonnet · default` / `yolo · opus · bypass`
  (red-tinted `#a05252`/`#4a2f33`). A chip sets model + permission + resume.
  A fourth chip — `custom · any command` — is a MODE toggle, not a one-shot
  preset (see the custom escape hatch below): neutral steel like its
  siblings (not red = not danger, not green = not go), toggled state
  borrows the topbar toggle pattern (`#232b36` fill + full ink).
- **2×2 fields** (labels 10.5px/600/ls 1.2px uppercase; inputs mono 32px on
  `#12161d`, radius 8): Session name (placeholder `auto from project`, maps
  to `title`) · Project (select, names only) · Model (select: opus, sonnet,
  haiku, fable) · Resume (select: `start fresh`, `continue last conversation
  (--continue)` — EXACTLY two options, per-id `--resume <id>` is fiction).
- **Permission cards** (2×2, radius 9, `#12161d`): mono mode name + plain
  description — `default` "ask before every tool call", `acceptEdits`
  "auto-approve file edits", `plan` "read-only planning mode",
  `bypassPermissions` "never ask · dangerous". Selected: `#5cb8f0` text,
  `rgba(92,184,240,.08)` bg, `#3d5a75` border. The bypass description stays
  `#d95c5c` even when selected — the warning never disappears.
- **Command preview** (`#0e1116` ink well, radius 9, mono 11):
  `$ <command> <args>` + `  cwd: <project path>`. `currentSpawn()` (over
  the pure composers in `launch-args.ts`) is the single spawn source for
  BOTH modes — the preview and the POST body cannot diverge. A blank
  custom command previews as `$ —` (the app's empty-value glyph).
- **Custom escape hatch** (user decision 2026-07-20, restoring the
  launcher tab's configurable command + args): toggling the `custom` chip
  reveals a full-width mono Command field (placeholder `htop --tree`, hint
  `whitespace split — no quoting, no shell`) and dims Model, Resume and
  the permission cards to the old launcher's is-disabled pattern (opacity
  .45 + real `disabled` attrs — visible, not hidden). First token =
  command, rest = args; the server spawns argv, never a shell. Exits: any
  preset chip, or toggling the chip off. Project-preset opens
  (projects-drawer row `+`) also exit custom mode; other opens remember
  it (the command text is kept either way). Session name and project still
  apply (title / cwd). Blank command on Launch → the `.form-err` inline
  error `command is required for the custom preset`.

Footer (`#171d25`, top seam): faint mono `opens in a new tab` · Cancel
(ghost, 30px) · `Launch ▸` (green go, 30px). Launch POSTs
`{ projectId, command, args, title?, cols, rows }` (`command` is `'claude'`
in preset modes, the user's argv[0] in custom mode; argv only — never a
shell string), the new session gets its own tab and becomes active,
keyboard lands in its terminal.

Behavior: Escape and backdrop-click close; Tab is trapped inside; focus
enters the name field on open and returns to the invoking control on close
(when the invoker was the terminal — ctrl+alt+t — that IS the terminal).
Entry points: topbar `+ New session`, tab-strip ghost `+`, projects-drawer
row `+` (project pre-set, defaults applied), empty-state button, Ctrl+Alt+T.

**Pre-selection precedence** (model + permission, `resolveModel`/`resolvePerm`
in `launch-args.ts`, unit-tested): **explicit project default > global
settings default > hardcoded fallback**. On every open the dialog resolves
model + permission ONCE against the selected project through those two
`resolve*` functions (`applyDefaults`): a project-intent open force-selects
its project first (`defaultModel` when in the model list; `defaultMode:
skip-permissions` → bypassPermissions card), a plain open uses the
auto-selected first project — either way the same precedence runs, so a
project default is layered on every open, not only project-intent opens. A
per-launch edit always wins (the dialog stays fully editable) and is not
persisted, and a mid-dialog project switch does NOT re-resolve — per-launch
control stays with the user once the dialog is open. The global defaults are
read live via `getDefaults()`, so a change in the settings panel pre-selects
the NEXT open with no reload.

## App settings panel (`web/src/ui/settings.ts`) — the decided four

A modal card opened by the topbar **Settings** button (text-only `tb-btn`,
sibling of Projects/Sessions), in the established modal language: the plain
label header of the shortcuts/dir-browser modals (NOT the launch gradient),
Escape / backdrop / × / Close all dismiss, Tab-trapped, focus restores to the
invoker. It holds exactly the user-decided four (PROJECT-SCOPE) and nothing
more — no usage-limit enforcement, no plan display:

- **LAUNCH DEFAULTS** — reuses the dialog's own idioms: a **model** `<select>`
  (the four models + an explicit `no default` that falls back to the dialog's
  hardcoded first), the dialog's **2×2 permission cards** (`perm-grid`/
  `perm-card`, all four modes incl. `plan`; danger card keeps its red desc),
  and a full-width mono **auto-run startup command** input (`/caveman`
  placeholder, `empty = off`). Each control commits on change; `close()`
  flushes an un-blurred edit. Persisted as the prefs bag's `defaults`
  (`UiLaunchDefaults`) via `api.updatePrefs({defaults})` — omitting off/none
  values (no `model` when "none", no `permissionMode` when `default`, no
  `startupCommand` when blank) so the bag stays minimal and `resolve*` treats
  absent === fallback.
- **USAGE** (read-only, from `GET /api/usage`) — a dense JetBrains-Mono ledger
  in the statusline voice, NOT KPI stat-cards: a totals block (headline total
  + `in/out/cache+/read` breakdown + `N-day window · S sessions · E entries
  [· M malformed skipped]`), then `BY DAY` (most-recent-first, `date →
  grouped-total`) and `BY MODEL` (`model → total · N×`). Fetched on open and
  on an explicit `refresh` only — never polled (the 30s server cache makes
  opens cheap); an in-flight fetch is superseded/cancelled by token. Numbers
  are grouped via `fmtCount` with `tabular-nums`. Model strings are Claude-
  Code-log-derived → rendered via `textContent` (untrusted display text; the
  repo's zero-`innerHTML` rule holds). A plain caveat states it is
  approximate, local, and cannot change account-side limits.

**Auto-run startup command mechanics** (`ui/startup.ts` + `terminal.ts`
`onFirstData`/`typeStartup`): claude-mode launches ONLY (never a custom-command
session). The launching window `armStartupCommand(sessionId, line)` at spawn;
the session's TerminalView fires `onFirstData` on its FIRST live output frame
after attach (replay frames never trigger it) and `consumeStartupCommand`
returns the line ONCE, then the pane types `line + CR` over the socket.
"Ready" is defined honestly and simply as that first output — no prompt-
detection heuristics. The guard is client-side once-per-spawn: a reattach's
first-output finds the entry already consumed, and only the arming window
ever held it, so a session adopted from elsewhere never retro-runs it.

**Prefs write discipline** — two writers now share the bag (`theme` from the
popover, `defaults` from the panel). `PUT /api/prefs` replaces the WHOLE
object, so both go through `api.updatePrefs(patch)` = GET current bag →
shallow-merge patch at the top level → PUT. Last-write-wins per top-level key
across concurrent windows (documented, not solved); fire-and-forget failure
tolerance stays (localStorage/in-memory hold the value for the run).

## Boot panel (handoff §10 visual language, minus fiction — R3)

Honest in-app steps ONLY (`createBootPanel` in `web/src/main.ts`): `token
check` (GET /api/runtime — authed, doubles as the uptime fetch), `hydrate
sessions` (projects + sessions), `attach ws` (first presence pong; a close
before any pong fails the step while reconnect continues). Steps run
concurrently and each row's mark is real state: spinner (`spin` .7s) while
its promise pends → green `✓` → red `×` + message on failure. Full-screen
`#12161d` overlay (`--z-overlay`), brand row (26px logo tile + wordmark),
`#0e1116` card radius 10, mono 11.5. The overlay mounts only if boot
outlives ~150ms (a warm localhost boot shows nothing) and removes itself
when every step settles. NO launcher-lifecycle steps (`reading
runtime.json` / `starting backend` / `waiting for health` — the app can
never witness them), NO fake timers, NO click-to-skip. Fatal failures
(hydrate error / rotated token) pin the overlay with the failed step, a
guidance line and a reload button; the post-boot 401 takeover panel
(`renderRestartPanel`) is unchanged.

## Empty state (handoff §11 minus fiction)

Zero views (⇔ zero sessions): centered 64px logo tile, `No active
sessions`, buttons `+ New session` (opens the launch dialog) and `Relaunch
previous run (N)` (opens the sessions drawer's previous-run section; shown
only when offers exist). NO grace countdown line. Closing the last tab
leaves the empty state — nothing auto-spawns.

## Cut as fiction (unchanged by the precedence flip)

- **Grace countdown** (empty state + statusline): any UI able to show it is
  itself keeping the backend alive.
- **Boot overlay with launcher lifecycle steps**: the browser opens after
  health passes; the app can never witness those steps (honest in-app boot
  panel lands with R3).
- **Per-session `--resume <id>`**: the journal stores our ids, not Claude
  conversation ids; `--continue` relaunch stays.

## Recorded deviations from the handoff (with reasons)

- **The app settings panel + topbar `Settings` button** exist in no handoff
  screen — the handoff is silent on settings. Built by user decision
  2026-07-20 (PROJECT-SCOPE "App settings panel"), designed entirely inside
  the established modal/dialog language (see "App settings panel" above), no
  new colors/tokens. The frontend-designer anti-slop rules governed what was
  added: a mono usage ledger (not KPI stat-cards), the dialog's own select +
  permission-card idioms for the defaults, plain label header.
- **The `custom · any command` chip + command field** exist in no handoff
  screen — added by user decision 2026-07-20 (the claude-only dialog
  contradicted the decided "configurable command + args" feature; the
  first R3 cut dropped the capability). Designed inside the dialog's own
  language: fourth pill in the chip row, mode-toggle state, old launcher's
  field copy and disabled-field pattern. See "Custom escape hatch" above.
- **Bypass emits `--permission-mode bypassPermissions`** (the handoff's
  preview form) instead of the old preset's
  `--dangerously-skip-permissions`; tags recognize both forms as danger.
- **Preview `cwd:` shows the project's real absolute path** — the
  prototype's `~/projects/<name>` was mock data; the real cwd is honest.
  This is the second sanctioned place a path appears (with the projects
  drawer), both inside launch/manage contexts.
- **Focus restore on close goes to the invoking control**, not always the
  terminal: yanking a keyboard user from the `+` button to a terminal would
  strand them. Opened via ctrl+alt+t from a terminal, the invoker IS the
  terminal; after a launch, focus goes to the new session's terminal.
- **No Phosphor icons** (no new dependencies): the prototype's text glyphs
  are the icon set — `>_ × + ▦ ⇱ ▸ ⠿`.
- **Terminal line-height**: xterm keeps its native cell metrics (lineHeight
  1) instead of the prototype's 1.6 — the prototype faked terminal lines
  with divs; real TUIs need real cell geometry. Font size 12.5px per spec.
- **Armed two-step confirms** (kill → `sure?`) are kept on every destructive
  control — repo interaction contract, no native confirm(); the prototype
  killed without asking.
- **Tab strip hint** doubles as drag documentation; every drag interaction
  keeps a keyboard/button path (shortcuts overlay lists them all).
- **Connection indicator** shows red `offline` when unreachable — the
  prototype only ever showed `connected` (mock had no failure mode).
- **Shortcuts entry point moved to the statusline**: the handoff has no `?`
  control anywhere; the topbar `?` button was dropped in the restructure, so
  the statusline's kbd help hint became a real `?` button (the shortcuts
  overlay needs one non-drag, non-chord entry point).
- **Drawer row meta** trimmed to the handoff's project · status shape; age
  and cols×rows moved out of the drawer (dims live in the statusline
  readout).
- **JetBrains Mono** bundled from the official JetBrains release (full
  glyph coverage for terminal content) instead of the latin-subset Google
  pipeline used for Barlow chrome.

## Guarantees carried over unchanged

- Resize chain: every geometry change (divider drag, drawer toggle, tab
  switch, split change) flows container-resize → FitAddon → ws `resize` →
  `pty.resize`. Divider clamps 15%–85%, tabbable, arrows nudge, Enter/dblclick
  resets. The theme popover changes no geometry.
- Plain keys (Ctrl+C, Esc, arrows) never intercepted; app chords exclusively
  Ctrl+Alt with the `getModifierState('AltGraph')` guard in BOTH the window
  handler and xterm's custom key handler (European layouts). Ctrl+Alt+Enter
  was retired with the launcher tab (no longer intercepted anywhere).
- localStorage UI schema stays **v2** (with the v1 migration). R3 removed
  the launcher view kind WITHOUT a schema bump: views are stored without
  `kind`, and the loader drops zero-session views — which is exactly how
  pre-R3 blobs containing launcher views migrate (active remaps, zero
  views stays legal). Theme state lives under a separate key.
- Sessions are server-side; the UI attaches views. xterm opens only on
  attached, measurable nodes; `.term-host` keeps `z-index:0` isolation (the
  scanline overlay sits OUTSIDE the host, `pointer-events:none`).
- Every control is a real `<button>/<input>` with a visible blue
  `:focus-visible` ring; hover-only affordances forbidden.
- Projects display their NAME everywhere; the path appears only as drawer
  row metadata.

## Slop-filter pass (against the frontend-designer reject list)

- Gradients / blur / shadows / glow: present ONLY where the handoff specs
  them (topbar + pane-area + dialog-header gradients; four shadows; tab/
  dot/go-button glows; the launch-dialog backdrop blur) — **user-sanctioned
  by decision 2026-07-20**, not template residue. Nothing beyond that list.
- Default-Tailwind look: no Inter/system font (bundled Barlow + JetBrains
  Mono), no rounded-2xl-card-grid shell, no gray-50.
- Generic SaaS dashboard: the shell is topbar / terminal cards / Steam tab
  strip / statusline — no icon sidebar, no card grid, no KPI tiles.
- Emoji/sparkle iconography: none — text glyphs and state-encoding dots.
- Centered friendly empty state: the handoff's empty state is a logo tile +
  two working actions, no illustration, no copywriting fluff.
- Decoration vs information: every colored element encodes interaction
  (blue), go/running (green), attention (amber), danger (red) or death
  (gray); the glows mark the active tab, the live connection, the go action.
- *"Next to 100 AI dashboards, distinguishable?"* — bottom Steam tab strip
  with glow bar, terminal cards floating on a radial-lit ground, themable
  terminal palettes, mono data voice, armed confirms: yes. *"Would a tmux
  power user feel at home?"* — chords for everything, dense mono rows,
  statusline readout, 10 terminal color ramps: yes.
