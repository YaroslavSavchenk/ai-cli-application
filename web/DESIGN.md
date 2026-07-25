# AI CLI Session Manager — frontend design (handoff transcription)

Binding reference for every visual decision in `web/src/`. Since 2026-07-20
the **hi-fi handoff in `design/` is the primary design source** (user's call,
reversing the 2026-07-19 "repo tokens win" rule; rationale in
`memory/decisions/handoff-design-primary.md`). This file transcribes the
handoff — `design/README.md` (spec) + `design/session-manager-prototype.html`
(reference behavior) — plus the recorded deviations below. Where this file
and the handoff disagree, the handoff wins; where the handoff is silent, the
anti-slop rules in `.claude/skills/frontend-designer/SKILL.md` still apply.

## UI copy rule — no commands, flags, or code (decided 2026-07-25)

The GUI speaks plain English; CLI syntax belongs in the terminal, not in the
chrome around it (PROJECT-SCOPE "No commands, flags, or code in the UI"). This
is **display-only**: `Perm`/`Mode` values, `shared/protocol.ts`, prefs keys and
the emitted argv are untouched — `claude --permission-mode acceptEdits
--continue` is still exactly what runs. The label sets below are BINDING
reference; the single source is `web/src/ui/launch-args.ts` (`PERMS`,
`PERM_SHORT`, `CHIPS`, `RESUME_OPTIONS`, `launchSummary`), pinned by
`tests/ui-launch-args.test.ts` + `tests/ui-util.test.ts`.

**Permission cards** (launch dialog + settings panel; mono title, sans desc):

| value               | title              | description                            |
|---------------------|--------------------|----------------------------------------|
| `default`           | Always ask         | before tools that need approval        |
| `acceptEdits`       | Auto-approve edits | file changes go through without asking |
| `plan`              | Read-only planning | looks and plans, changes nothing       |
| `bypassPermissions` | Never ask          | no prompts at all · dangerous          |

The bypass description keeps `--danger` red selected or not — the warning never
disappears.

**Short forms** for narrow chips (`PERM_SHORT` — pane-header permission tag via
`permFromArgs`, the per-pane status bar `mode` item, the settings status-bar row
sample): `default` → `always ask` · `acceptEdits` → `auto edits` · `plan` →
`read-only` · `bypassPermissions` → `no prompts` · `--dangerously-skip-permissions`
→ `no prompts`. Danger detection is unchanged (both bypass forms are danger);
`default` still renders NO tag at all, so its short form never appears. A mode
outside the known four (only reachable from a typed custom command) is shown
verbatim rather than mistranslated.

**Resume select**: `Start fresh` / `Continue last conversation` (values
`fresh`/`continue`; `continue` still emits `--continue`).

**Preset chips**: `deep work · opus · auto edits · continue` / `quick fix ·
sonnet · always ask` / `yolo · opus · no prompts` / `custom · any command`
(unchanged).

**Launch summary** (replaces the argv command preview in preset modes) — three
mono lines in the same ink well, composed by `launchSummary()` from
`currentSpawn()`'s own argv array — the one the POST body carries — so summary
and POST body still cannot diverge:

```
Claude Code · opus
auto-approves file edits · continues your last conversation
folder: /home/sava/projects/web-ui
```

Mode clauses: `asks before tools that need approval` / `auto-approves file edits` /
`read-only planning, changes nothing` / `never asks · dangerous`. Resume
clauses: `starts a fresh conversation` / `continues your last conversation`. The
danger clause renders red (`.launch-cmd .is-danger`) — colour carries the
warning the flag name used to.

**Exempt by construction**: the custom-command field (label, placeholder `htop
--tree`, hint `whitespace split — no quoting, no shell`) and its preview line —
its content IS a command the user typed, so custom mode still shows `$ <cmd>
<args>` (blank → `$ —`) plus the `folder:` line. Terminal content is obviously
exempt. Statusline items (`ws <n> ms`, `pty ok`, `up HH:MM:SS`) and model ids
(`opus`/`sonnet`/`haiku`/`fable` — product names) stay as they are.

Other copy this rule changed: sessions drawer footer note → `relaunch continues
the previous conversation`, relaunch button title → `relaunch as a new tab —
continues where the session stopped`; new-project git toggle sample `git init` →
`starts version history` (title `start tracking changes in the new project
folder`); new-project clone tab `$ git clone <url> <dest>` preview → the
three-line `copies` / url / `into folder: <dest>` summary (exact lines and `—`
empty state in the New Project dialog section below); settings startup-command
placeholder → `a line to run in every new session`, hint → `typed into each new
session once it's ready · empty = off`.

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
   wordmark. Right, in the refreshed prototype's order (2026-07-24): 28px
   icon-only `⚙` Settings button, Theme button (CSS 2×2 swatch icon:
   green/blue/amber/violet), Projects toggle, Sessions toggle (amber count
   badge when any session awaits input), 1px divider, connection indicator
   (green glowing dot + `connected`, derived from real reachability: poll ok /
   presence pong; red `offline` when the backend is unreachable), GitHub chip,
   and the primary green `+ New session`. Toggled buttons: bg `#232b36`, text
   `#dbe2ea`.
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

- **Projects (left, 272px)**: header `PROJECTS` + `+ add`. `+ add` opens the
  New Project dialog (Phase 2a — its own section below); the older inline add
  flow and its directory-browser modal were REPLACED by that dialog, which
  keeps the same rule that made them worth keeping — the path comes from a
  real backend-fs picker, never a free-text-only field (so the handoff's
  `~/projects/<name>` autofill applies to a text path input we still do not
  have; the dialog SUGGESTS that path in its pathrow instead).
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
  exactly; footer note `relaunch continues the previous conversation` (the
  emitted flag is unchanged — see the copy rule). NO per-id `--resume <id>`
  (fiction cut). Slide-in .18s.

## Launch dialog (handoff §8 — R3, replaces launcher-as-tab)

THE way to create a session (`web/src/ui/launch.ts`). Modal over the ONE
sanctioned blurred backdrop (`rgba(8,10,14,.55)` + `blur(4px)`, centered):
560px card, radius 12, dialog shadow, fadeUp. Header on the sanctioned
`#202935→#1b222c` gradient: 30px logo tile (radius 9) · `Launch session`
14px/600/ls .8px · mono subtitle `spawns a real pty on the backend ·
survives hidden panes` · bordered `×` (danger on hover). Body (18px 20px,
16px stack):

- **Preset chips** (pill 13px, mono 10.5): `deep work · opus · auto edits ·
  continue` / `quick fix · sonnet · always ask` / `yolo · opus · no prompts`
  (red-tinted `#a05252`/`#4a2f33`). A chip sets model + permission + resume.
  A fourth chip — `custom · any command` — is a MODE toggle, not a one-shot
  preset (see the custom escape hatch below): neutral steel like its
  siblings (not red = not danger, not green = not go), toggled state
  borrows the topbar toggle pattern (`#232b36` fill + full ink).
- **2×2 fields** (labels 10.5px/600/ls 1.2px uppercase; inputs mono 32px on
  `#12161d`, radius 8): Session name (placeholder `auto from project`, maps
  to `title`) · Project (select, names only) · Model (select: opus, sonnet,
  haiku, fable) · Resume (select: `Start fresh`, `Continue last conversation`
  — EXACTLY two options, per-id `--resume <id>` is fiction).
- **Permission cards** (2×2, radius 9, `#12161d`): mono plain-language title +
  sans description, per the copy rule's label table above ("Always ask" /
  "Auto-approve edits" / "Read-only planning" / "Never ask"). Selected:
  `#5cb8f0` text, `rgba(92,184,240,.08)` bg, `#3d5a75` border. The bypass
  description stays `#d95c5c` even when selected — the warning never
  disappears.
- **Launch summary** (`#0e1116` ink well, radius 9, mono 11): three plain
  lines (agent · model / mode clause · resume clause / `folder: <project
  path>`), exact copy in the rule above. `currentSpawn()` (over the pure
  composers in `launch-args.ts`) remains the single spawn source for BOTH
  modes, and `launchSummary()` derives every clause from that spawn's ARGV —
  summary and POST body cannot diverge. Custom mode keeps the literal `$ <command> <args>` line
  (blank → `$ —`, the app's empty-value glyph) plus the `folder:` line.
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

## New Project dialog (`web/src/ui/newproject.ts`)

Same modal language as the launch dialog (gradient header, `launch-body`
stack, ink well, `.form-err`), opened from the projects drawer `+ add` and —
straight onto the GitHub tab — from the topbar GitHub chip. Header: `◧`
tile · `New project` · mono subtitle `create locally · clone a repo`. Three
tabs (`np-tabs`, `role=group`, aria-label `project source`): `Blank local` /
`Clone repo` / `GitHub`.

**Blank local**: `Project name` (placeholder `my-project`) · `Local path`
(pathrow + `Browse`; suggests `<home>/projects/<name>` live as the name is
typed) · checkbox row `Initialize git repo` with sample `starts version
history` (title `start tracking changes in the new project folder`) · two
OPTIONAL selects in the settings-panel idiom, `Default model (optional)` and
`Default permission mode (optional)`, both with the lowercase empty option `no
default`; the permission select's only other entry is `never ask · dangerous`
(lowercase to match its sibling — the four permission CARD titles above keep
their sentence case, and `standard` is not offered at all: it is behaviourally
identical to "no default"). Caption: `creates the folder and registers it under
Projects`.

**Clone repo**: `Git URL` (placeholder `https://github.com/owner/repo.git`) ·
`Destination (optional)` (pathrow + `Browse`; suggests
`<home>/projects/<repo>`, or `Browse to choose a location` before home is
known) · and the ink well (`.launch-cmd`, same `launch-sum-line` structure as
the launch summary), which since the copy rule holds THREE plain lines instead
of the old `$ git clone <url> <dest>`:

```
copies
https://github.com/owner/repo.git
into folder: /home/sava/projects/repo
```

Line 1 is fixed. Line 2 is the pasted URL verbatim (the user's own input, not
code) and line 3 the effective destination; each falls back to `—`, the app's
empty-value glyph, so an empty dialog reads `copies` / `—` / `into folder: —`
and never shows a half-real command.

Footer note + primary follow the tab: `registers under Projects` + `Create
project` (blank) · `clones, then registers under Projects` + `Clone ▸` (clone)
· `browse your GitHub repositories` + NO primary (GitHub is view-only here).
Clone is slow and synchronous, so the footer swaps in an honest indeterminate
spinner `cloning… this can take a while` — never a fake percentage.

## GitHub panel — two credential paths (`web/src/ui/github.ts`)

Added 2026-07-25 (user's decision; security design gate ran BEFORE any code —
`memory/decisions/github-token-paste-path.md`). The New Project dialog's GitHub
tab now offers **two ways to connect**: the OAuth device flow and a token the
user pastes. One credential at a time. `GithubStatus.source` (`device` | `pat`)
says which is live and EVERYTHING the user must do differently branches on it —
above all where to revoke, where a wrong instruction leaves a live credential
the user believes is dead.

`configured` was replaced by `deviceFlowAvailable`, which hides the sign-in
BUTTON and nothing else: a pasted token needs no OAuth client id, so the paste
path must stay visible exactly on the servers where sign-in is impossible. The
old dormant "GitHub isn't set up on this server" card is GONE — it took over the
whole panel and would now hide the only path that works.

**No new tokens, colors, gradients, shadows, glows, radii or fonts.** The token
well is the `.gh-newform` inset in the panel's own language (`--bg-deep` on
`--edge-mid`, `--r-card-sm`), the remember control is the settings /
`Initialize git repo` checkbox idiom (`.status-row` + `.status-box`), the field
is `.launch-field`/`.launch-lb`, the busy state is `.np-busy`/`.np-spinner`, and
the colors keep their exclusive meanings: **amber `--attn` = needs attention**
(credential stopped working, expiry inside three days, "check the account"),
**red `--danger` = harm** (the never-paste-someone-else's warning — the same
permanent red as the bypass permission card — and inline failures), **accent
`--acc` = interactive**, **green `--ok` = connected**.

### Binding input rules (design gate; enforced in code and by comment)

- `type=password`, `autocomplete=new-password`, `spellcheck=false`, **NO `name`
  attribute**, and **NOT inside a `<form>`** — submitted from a click handler
  like every other action here, so no browser save-password prompt fires (the
  Edge `--app` fallback window is a full Edge profile with a password manager).
  Enter in the field calls the same handler; it creates no form.
- The value is set/read **only through the `.value` property**, never a `value`
  attribute, so the credential never appears in `outerHTML`.
- The credential's whole client-side lifetime is `submitToken()`: read once,
  handed to the request, field cleared in the same frame, local reference
  dropped. NO module variable, timer closure, error object or retry buffer keeps
  it; a failed add means the user pastes again. Leaving the tab clears the field.
- No `localStorage` / `sessionStorage` / IndexedDB / cookie / prefs write, and
  no `history.pushState`, hash or URL involvement — ever.
- Untrusted strings (login, scopes) render via `textContent`; the repo's
  zero-`innerHTML` rule is load-bearing here (the page holds the app token).

### Copy — BINDING (pure choosers in `ui/github-model.ts`, pinned by `tests/ui-github-model.test.ts`)

**Storage honesty ceiling.** There is no OS keyring in this environment
(verified absent) and 0600 does not hold against the Windows side of WSL
(`memory/knowledge/wsl-0600-not-a-boundary.md`). Nothing may say keychain,
keyring, encrypted, secure, vault or protected. The strongest permitted
sentence is `storageNote(true)`, and a test asserts the forbidden words never
appear in any credential string this module produces.

Disconnected card (`deviceCardCopy`), title `Connect your GitHub account`:

| deviceFlowAvailable | rendering |
|---|---|
| `true`  | GH avatar · body `List your repositories from inside the manager, clone them, and create new ones. Connect by signing in with GitHub, or by pasting a token you create yourself.` · button `Connect with GitHub` · fine `sign in once through GitHub · the token is kept server-side, never in the browser · it can read and write every repository on the account, and usually does not expire` |
| `false` | NO avatar (it belongs to the sign-in action, and 44px would push the working control below the fold) · body `List your repositories from inside the manager, clone them, and create new ones.` · NO button · note `Signing in with GitHub is not set up on this server — see the project README. Pasting a token works without it.` |

A 409 from the device endpoint renders inline: `Signing in with GitHub is not set
up on this server — see the project README. You can still paste a token below.`

Token well — heading `Or paste a GitHub token` when sign-in also works,
`Paste a GitHub token` when it is the only path. Order top to bottom:

1. Recommendation (sans body) — **the highest-value security advice in the app**,
   placed where it is read BEFORE pasting. `Contents`/`Metadata` are permission
   names on GitHub's own screens, so naming them is allowed under the copy rule,
   the same way the device-flow URL is:
   `Recommended: create a fine-grained token on GitHub, limit it to the
   repositories you want this app to touch, and give it an expiry date. Grant it
   Contents (read and write); Metadata (read) comes with it.`
2. Field: label `GITHUB TOKEN`, placeholder `paste your token here`.
3. `Remember this token` checkbox row (default **ON**, the user's decided
   default), mono sample `kept on this machine` / `until the app closes`.
4. Toggle note (`rememberNote`) — the one control that removes the on-disk copy,
   said plainly:
   ON `Stored on this machine in the app’s data folder, readable by your own
   user account.` ·
   OFF `Kept in this app’s memory only. It disappears when the app closes —
   about half a minute after the last window — and you paste it again next time.`
5. `checking with GitHub…` (indeterminate, never a percentage) + primary
   `Add token`. Empty submit → inline `paste a token first`, no request.
   Failures show the server's own sentence; `tokenErrText` only covers a
   bodyless 400 (`GitHub did not accept that token`) / 502 (`could not reach
   GitHub`) and never describes the token's length, prefix or shape.
6. Red permanent warning: `Never paste a token someone else gave you. A token
   you did not create yourself connects this app to their account.`
7. Fine-print footnote (below the action on purpose): `narrower than signing in,
   which takes read and write on every repository of the account and usually
   does not expire · a token limited to selected repositories can list and clone them,
   but creating a brand-new repository from here needs a broader one`

Connected view — `@login` (large mono) + sub `connected · pasted token` /
`connected · signed in with GitHub` (`sourceLabel`), then:

- **Account check, pasted token ONLY** (amber): `Check this is the account you
  meant — clones and new repositories land in it.` A token can silently be for
  the wrong account; with the device flow the user signed in themselves.
- **Facts ledger** (`.gh-fact`, mono, one line each, rendered ONLY when the
  server reported them): `storageNote(persisted)` · `fmtTokenExpiry(expiresAt)`
  (`expires in N days/hours/minutes` · `expires in under a minute` · `this token
  has expired`; amber inside 3 days or past) · `scopesNote(scopes)`
  (`this token can: repo, read:org`). **Absent `scopes` renders NOTHING** — that
  is what a fine-grained token looks like, and "no permissions" would be exactly
  backwards; an EMPTY array is a different, real answer and reads `GitHub
  reports no scopes on this token`.
- **Revocation, keyed on source** (`revokeNote`) — the instruction that is wrong
  for the other credential: `pat` → `Disconnect removes the token from this app.
  To revoke it everywhere, delete it on GitHub under Settings → Developer
  settings → Personal access tokens.` · `device` → `Disconnect removes the token
  from this app. To revoke access everywhere, remove the app on GitHub under
  Settings → Applications.` · unknown source names both screens.

Credential lost (amber strip above the disconnected card, `role=status`) — shown
when a LIVE connection drops without the user pressing disconnect, which an
expiring pasted token makes routine: `GitHub stopped accepting the stored
credential. It may have expired, been revoked, or lost access to your
repositories. Connect again below.` A user-pressed disconnect never shows it,
and after a reload no reason is invented.

Top-bar chip (`chipView`) — `disconnected` now reads `Connect GitHub` whatever
`deviceFlowAvailable` says. Connected shows `@login` plus a mono micro-tag
naming the credential (`token` / `sign-in`, `.tb-gh-tag`, aria-hidden because
the accessible name already says it in words: `GitHub — connected as sava with a
pasted token` / `… by signing in with GitHub`). An unknown source is left
unlabelled rather than guessed.

## App settings panel (`web/src/ui/settings.ts`) — the decided four

A modal card opened by the topbar **Settings** button — an icon-only 28px `⚙`
(`tb-btn is-icon`), FIRST of the right-hand controls (see the topbar order in
Shell anatomy) — in the established modal language: the **shared gradient
dialog header** (`launch-hd` + 30px `launch-tile` holding the `⚙` glyph +
`Settings` + mono subtitle `launch defaults · usage · terminal status bar`),
Escape / backdrop / × / **Done** all dismiss, Tab-trapped, focus restores to the
invoker. Footer: `Reset to defaults` left, accent-blue primary `Done`
(`btn is-acc`) right. It holds exactly the user-decided four (PROJECT-SCOPE) and
nothing more — no usage-limit enforcement, no plan display:

- **LAUNCH DEFAULTS** — reuses the dialog's own idioms: a **model** `<select>`
  (the four models + an explicit `no default` that falls back to the dialog's
  hardcoded first), the dialog's **2×2 permission cards** (`perm-grid`/
  `perm-card`, all four modes incl. `plan`; danger card keeps its red desc),
  and a full-width mono **auto-run startup command** input (placeholder `a line
  to run in every new session`, hint `typed into each new session once it's
  ready · empty = off`). Each control commits on change; `close()`
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

## Terminal status bar (per-pane telemetry strip)

Added 2026-07-24. A thin vim-statusline descendant under each terminal (the
hero recedes; the strip is chrome). One new token: `--surface-panestatus:
#0b0e13` (darker than `--term-bg #0e1116`; sits below the terminal); border-top
reuses `--edge-soft`. Everything else reuses existing tokens.

**Strip** (`.pane-status`, LAST child of the pane, after `term-host`):
`flex:none; height:22px; padding:0 12px; gap:12px;
background:var(--surface-panestatus); border-top:1px solid var(--edge-soft);
font-family:var(--font-mono); font-size:var(--fs-micro) (10px); overflow:hidden;
white-space:nowrap`. Items are `<span class="pane-status-item">` colored by
SEMANTIC role: neutral → `var(--xt-bright-black)` (the terminal's themable dim,
so the strip harmonizes with the active xterm theme), `skill` → `var(--acc)`,
`bypassPermissions` mode → `var(--danger)`. The strip is HIDDEN (no empty 22px
bar) until ≥1 enabled item has a real value; its show/hide changes pane
geometry → the existing ResizeObserver→FitAddon→ws-resize chain re-sizes the
PTY.

**Honesty rule** (as everywhere): an item renders only when its toggle is ON
*and* a real value exists — never fabricated. Item table:

| item    | source (client-side vs poll)                        | format          |
|---------|-----------------------------------------------------|-----------------|
| model   | launch argv (`modelFromArgs`) — client, no poll     | `opus`          |
| mode    | launch argv (`permFromArgs`) — client, no poll      | `auto edits`    |
| skill   | telemetry `skill` — poll                            | `skill: edit`   |
| cost    | telemetry `costUsd` — poll                          | `$0.42`         |
| context | telemetry `contextTokens`/`contextMax` — poll       | `ctx 62k/1000k` |
| time    | `SessionInfo.createdAt`, ticked 1s — client         | `08:42` (mm:ss) |
| branch  | telemetry `branch` — poll                           | `⎇ feat/auth`   |
| diff    | telemetry `add`/`del` — poll (omit if both 0)       | `+128 −41`      |

`model`/`mode`/`time` are derived CLIENT-SIDE (always available, no poll);
`branch`/`cost`/`context`/`diff`/`skill` come from `GET /api/telemetry`, polled
~3s while ≥1 pane is visible (paused when hidden / no panes; refreshed once on
focus/visibility change). Last-known telemetry is cached per session id so an
EXITED pane keeps its final values (the endpoint omits exited sessions);
`time` drops off at exit (session no longer running). Untrusted strings
(branch, skill, model — git/Claude-log derived) render via `textContent`.

Defaults ON: model, mode, branch, cost, context. OFF: time, diff, skill.
Persisted in the prefs bag under `statusBar` (server-side, NOT localStorage —
the port-churn lesson), via the same `api.updatePrefs` merge as `defaults`.
`usage %` is deliberately absent — an account rate-limit percent lives in live
API headers, not the local logs, so there is no honest source (shown only as a
DISABLED settings row labeled "not available from local logs").

**Settings section** — a third `settings-sect` "TERMINAL STATUS BAR" after
USAGE: a live preview (the `.pane-status` strip, boxed:
`height:24px; border:1px solid var(--edge-soft); border-radius:var(--r-field)`)
of the focused/first running session's live telemetry (representative samples
when none runs; "status bar hidden" when nothing enabled); eight keyboard-
reachable `<button class="status-row">` toggles (16px checkbox square, `✓` in
`--term-bg` on `--acc` when on; `aria-pressed` reflects state) matching
`UiStatusBar`; a ninth DISABLED "Usage limit" row (honest deferral). A footer
"Reset to defaults" button (left of `Done`) restores the ON/OFF defaults. Each
toggle persists immediately and re-renders open panes live (no reload).

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
  screen — the ORIGINAL handoff was silent on settings. Built by user decision
  2026-07-20 (PROJECT-SCOPE "App settings panel"), designed entirely inside
  the established modal/dialog language (see "App settings panel" above), no
  new colors/tokens. The frontend-designer anti-slop rules governed what was
  added: a mono usage ledger (not KPI stat-cards), the dialog's own select +
  permission-card idioms for the defaults. **Superseded 2026-07-25** — the
  user's refreshed `design/session-manager-prototype.html` (2026-07-24) DOES
  contain a settings dialog and an icon-only gear, so the two 2026-07-20 guesses
  below were replaced by the primary source (primary-source rule:
  `memory/decisions/handoff-design-primary.md`):
  - the panel's **plain label header → the shared gradient dialog header**
    (prototype lines 435–472: `launch-hd` + 30px `launch-tile` + `⚙` +
    `Settings` + mono subtitle). Our subtitle reads `launch defaults · usage ·
    terminal status bar` rather than the prototype's `terminal status bar ·
    saved on this machine`, because the prototype's caption predates
    launch-defaults + usage and "saved on this machine" is wrong for us (prefs
    live server-side in `prefs.json`) — honesty beats transcription.
  - the footer's neutral **`Close` → the prototype's accent-blue primary
    `Done`** (`btn is-acc`: `--acc-tint` fill, `--acc` border/ink, hover
    `--acc-sel`; the same recipe as `.gh-repo-act.is-clone`, so no new token).
    Blue = confirm/interactive; green stays the "go" family that spends
    something (spawn, clone, add).
  - the topbar's **text `Settings` button → an icon-only 28px `⚙`**
    (prototype line 44), moved to be FIRST of the right-hand controls. It keeps
    an accessible name (`aria-label="Settings"`), its `title`,
    `aria-haspopup="dialog"`, keyboard reachability and the standard 2px
    `--acc` focus ring; the glyph span is `aria-hidden`. It is the ONLY
    icon-only control — Theme, Projects and Sessions keep their labels.
- **The `custom · any command` chip + command field** exist in no handoff
  screen — added by user decision 2026-07-20 (the claude-only dialog
  contradicted the decided "configurable command + args" feature; the
  first R3 cut dropped the capability). Designed inside the dialog's own
  language: fourth pill in the chip row, mode-toggle state, old launcher's
  field copy and disabled-field pattern. See "Custom escape hatch" above.
- **Bypass emits `--permission-mode bypassPermissions`** (the handoff's
  preview form) instead of the old preset's
  `--dangerously-skip-permissions`; tags recognize both forms as danger.
- **The summary's `folder:` line shows the project's real absolute path** — the
  prototype's `~/projects/<name>` was mock data; the real cwd is honest. This is
  the second sanctioned place a path appears (with the projects drawer), both
  inside launch/manage contexts. (Was `  cwd: <path>` under the argv preview
  until the 2026-07-25 copy rule replaced the preview with the summary.)
- **Focus restore on close goes to the invoking control**, not always the
  terminal: yanking a keyboard user from the `+` button to a terminal would
  strand them. Opened via ctrl+alt+t from a terminal, the invoker IS the
  terminal; after a launch, focus goes to the new session's terminal.
- **No Phosphor icons** (no new dependencies): the prototype's text glyphs
  are the icon set — `>_ × + ▦ ⇱ ▸ ⠿ ◧ ▤ ⌕ ⚙`.
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
  `:focus-visible` ring; hover-only affordances forbidden. An icon-only control
  (the topbar `⚙`) carries its name in `aria-label`, never in the glyph alone.
- Projects display their NAME everywhere; the path appears only as drawer
  row metadata.
- The 2026-07-25 copy rule is DISPLAY-ONLY: labels changed, emitted argv did
  not (`composeArgs` tests are the guard).

## Slop-filter pass (against the frontend-designer reject list)

- Gradients / blur / shadows / glow: present ONLY where the handoff specs
  them (topbar + pane-area + dialog-header gradients; four shadows; tab/
  dot/go-button glows; the launch-dialog backdrop blur) — **user-sanctioned
  by decision 2026-07-20**, not template residue. Nothing beyond that list.
- Default-Tailwind look: no Inter/system font (bundled Barlow + JetBrains
  Mono), no rounded-2xl-card-grid shell, no gray-50.
- Generic SaaS dashboard: the shell is topbar / terminal cards / Steam tab
  strip / statusline — no icon sidebar, no card grid, no KPI tiles.
- Emoji/sparkle iconography: none — text glyphs and state-encoding dots. The
  `⚙` Settings button is the prototype's own text glyph in text presentation
  (no variation selector, no emoji font), inked with the button's own color.
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
- 2026-07-25 GitHub token-path re-check: no gradient, shadow, glow, blur, token,
  color or font was added — the token well reuses the `.gh-newform` inset, the
  checkbox row reuses the settings idiom, and the only new visual element is a
  mono micro-tag on the chip that carries real information (which credential).
  Every control is a real `<button>`/`<input>` with the standard focus ring; the
  panel has no hover-only affordance. Placed next to 100 AI dashboards it still
  reads as a credential status block in a terminal tool, not a signup wizard:
  dense mono facts, an armed disconnect, plain sentences instead of reassuring
  badges, and no lock icon anywhere — the copy says what the storage actually
  is rather than drawing a padlock over it.
- 2026-07-25 delta re-check: the plain-language copy is carried by the SAME mono
  voice (values stay mono, chrome stays Barlow), so the terminal lineage is
  intact — it reads like a tmux status readout in words, not like a friendly
  SaaS wizard. No new gradient/shadow/glow/blur, no new token, no new color; the
  one added button variant reuses the accent tints already in the file, and the
  one added glyph is the prototype's own.
