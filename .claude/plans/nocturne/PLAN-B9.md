# Plan B9 — Terminal colours live: the Settings page paints every terminal (Nocturne Track B)

Status: LANDED 2026-09-22 (`6b1afc1` the landing, CI green; user-verified on Windows 2026-09-22 from the dev window: "alles werkt"; suite 3223 → 3258; one fix round; 18 mutants; verify-terminal B9-1…7 PASS on the reused B6 CDP harness, the status bar's themed ink owed to a Claude session on Windows; log `memory/log/2026-09/nocturne/2026-09-22-nocturne-b9.md`); earlier: STARTED 2026-09-22 (user: "continue met bouwen van de app"; next row in the status table; shape = open decision 10, DECIDED 2026-09-13; the persisted shape and the surface split below are orchestrator defaults, recorded before the developer started).
Parent: `.claude/plans/PLAN-NOCTURNE.md` part B9. A7 (2026-09-13) drew the
Settings page `Terminal colours` (`web/src/ui/term-colours.ts` +
`term-colours-model.ts`): six preset cards, a preview, two custom fields
(ground, text), `Reset to Nocturne` — and one honesty line, because the page
reaches nothing: no `:root`, no terminal, no prefs. The machinery that paints
a terminal from `:root` custom properties has waited unwired in
`web/src/ui/theme.ts` since A2 (`--term-bg` + the `--xt-*` slots →
`themeFromTokens()` in `ui/terminal.ts`; `refreshAllTerminalThemes()`
repaints every live terminal; localStorage cache + the `theme` key of
`prefs.json` through `api.updatePrefs`). B9 connects the two and deletes the
honesty line. Runs through `/dev-flow` (lean rules 1–11); NO
`security-auditor` (no new route, no path, no spawn — the client writes the
existing opaque prefs bag); `/verify-terminal` once at the end, scoped.
Line numbers drift — verify by reading.

## Decided shape (user, 2026-09-13, open decision 10 — unchanged)

- (a) presets + a custom ground and text; (b) ground + text ONLY, never the
  ANSI palette; (c) the TERMINAL only — app chrome, the accent and the three
  status colours (running / attention / danger) are never themed; (d) a
  Settings page only, no top-bar switch. Nocturne is the default and
  `Reset to Nocturne` is always there.

## Orchestrator defaults (recorded 2026-09-22, not asked; each a cheap flip ⟲)

- ⟲ **D1 persisted shape = the hex pair.** `UiPrefs.theme` becomes
  `{ ground: '#rrggbb', text: '#rrggbb' }` (both lower-case six-digit hex).
  The preset is NOT stored: `matchPreset(ground, text)` recovers it on read
  (the preset table is fixed; a pair that matches no card is `custom`). The
  Legacy shape `{ bg, fg, scan }` (indexes into `GROUNDS` / `RAMPS`) is
  still READ — `bg → GROUNDS[bg].hex`, `fg → RAMPS[fg].cmd` — so an old
  prefs.json keeps its meaning; it is never written again, and `scan` (the
  Legacy scanline flag that nothing has rendered since A8) leaves the
  protocol. An absent, invalid or non-object member = Nocturne. The
  localStorage cache keeps its key (`ai-sm:theme:v1`) and accepts both
  shapes through the same clamp. Rejected: storing the preset id (a renamed
  preset would silently change a user's colours); a new localStorage key
  (nothing to migrate that the clamp does not already handle).
- ⟲ **D2 what a pair paints.** One function turns the pair into the four
  colours the A7 preview already derives (`coloursOf`: a preset's own ramp
  `cmd / out / dim`; a custom pair = `text / text / text pulled 55 % towards
  the ground`). `ui/theme.ts` writes them inline on `:root`:
  `--term-bg ← ground`, `--xt-fg` and `--xt-white ← out`,
  `--xt-bright-white` and `--xt-cursor ← cmd`, `--xt-bright-black ← dim`
  (the A1/A3 mapping in the theme.ts header); then
  `refreshAllTerminalThemes()`. The DEFAULT (the Nocturne pair) REMOVES the
  six inline properties instead of writing them, so Nocturne is exactly the
  stylesheet's own tokens (`--xt-bright-white` is `#f3f5fe` there, not the
  ramp's `cmd`) and the tokens file stays the single source for the default.
  `--xt-cursor-accent` already follows `--term-bg`. The ANSI colours, the
  selection and the status colours stay as the tokens say.
- ⟲ **D3 the surfaces that follow — the terminal only.** `--term-bg` is
  the terminal ground and the only themed ground. Today three non-terminal
  surfaces also read `var(--term-bg)`: the editor's active file chip
  (`.pane-tab.is-on`, app.css ≈ 934), the commit view / diff pane
  (`.diff-body` ≈ 6789 and whatever else in the A6 block reads it) and
  possibly the editor body. Those MOVE to `var(--color-term)` — the oklch
  twin the tokens already define with the same value — so a light custom
  ground never lands under `--color-text` diff or editor ink. The terminal
  card (`.pane-body`: mount, pane status bar, agents table — "one box on the
  ground", A3) follows the ground as a whole; the status bar's label and
  value ink switch from `--color-neutral-600` / `--color-neutral-300` to the
  theme's own quiet and ordinary steps (`var(--xt-bright-black)` /
  `var(--xt-fg)` — the same hexes on the default) so the bar stays readable
  on any ground; its danger / attention colours stay (decision 10c). xterm's
  own `.xterm` + `.xterm-viewport` ground (A4b) already reads `--term-bg`.
  Rejected: a second token for "the themed ground" (two names for one
  ground); letting the diff and editor follow (decision 10c says terminal
  only, and their ink is app ink).
- ⟲ **D4 live, then persisted.** Every change on the page (a card, a valid
  hex, the native swatch while dragging, Reset) paints every open terminal
  at once through the control and updates the localStorage cache at once.
  The server write (`api.updatePrefs({ theme })`, a GET-merge-PUT) is
  trailing-debounced ≈ 300 ms and SERIALISED (one in flight; a change during
  the flight queues exactly one more write with the latest pair) so a
  swatch drag does not fire fifty read-modify-writes that can interleave.
  Closing the dialog flushes a pending write. Boot order stays the theme.ts
  contract: the local cache paints first, the boot bag (`GET /api/prefs`,
  already awaited in main.ts's hydrate) wins if different — both before the
  first terminal exists (`initTheme` runs in `buildShell` before
  `initSettings` and long before `initPanes`). The Settings dialog's re-read
  on open (settings.ts, the `writes > 0` guard) also re-applies `bag.theme`
  and re-syncs the page, so another window's choice shows up.
- ⟲ **D5 the page gets the control injected.** `buildTermColours(titleId,
  ctl: ThemeControl)`; `ThemeControl = { apply(pair), current(): pair }`
  stays theme.ts's export, handed through `SettingsDeps` (`theme:
  ThemeControl`) from main.ts. `term-colours.ts` keeps importing nothing
  from `theme.ts` / `terminal.ts` (the A7 test's reach rule survives as a
  wiring rule: the page drives a control, it does not own terminals). The
  page's opening state = `ctl.current()` mapped through `matchPreset`, and a
  `sync()` the panel calls after its re-read. The placeholder note and its
  function go (the A7 marker says so).
- ⟲ **D6 presets and copy unchanged.** The six A7 presets, the three sample
  lines, the lead line and `Reset to Nocturne` stay as drawn; no new copy
  except none (the honesty line is deleted, not replaced).

## Frozen protocol (`shared/protocol.ts`; the developer writes it, text frozen here)

```ts
/**
 * Nocturne B9 (.claude/plans/nocturne/PLAN-B9.md) — the terminal colours the
 * user chose on Settings → Terminal colours: the ground and the bright text
 * step, both `#rrggbb` lower-case. The preset is not stored (the page recovers
 * it from the pair); an absent or invalid member means Nocturne, which is the
 * stylesheet's own tokens. Persisted under `theme`; the server never reads it.
 * The Legacy shape `{ bg, fg, scan }` (table indexes, until 2026-09-22) is
 * still accepted on read by web/src/ui/theme-model.ts and never written again.
 */
export interface UiTheme {
  ground?: string;
  text?: string;
}
```

Model (`web/src/ui/theme-model.ts`, pure): `ThemeState = { ground: string;
text: string }`; `NOCTURNE: ThemeState` (= `GROUNDS[0].hex`, `RAMPS[0].cmd`);
`clampTheme(raw: unknown): ThemeState` (v2 hex pair → normalised; Legacy
indexes → hexes; anything else → `NOCTURNE`; each member independently);
`themeEquals(a, b)`; `isNocturne(s)`. `GROUNDS` / `RAMPS` stay (the presets
index them). `isUiTheme` goes or becomes the v2 check — the developer's call,
covered by tests either way.

Control (`web/src/ui/theme.ts`): `initTheme(serverPrefs?: UiPrefs):
ThemeControl` (as today, on the new state), `ThemeControl.apply(next:
ThemeState)` / `.current()`, plus `flush(): Promise<void>` for the dialog's
close. The four colours come from `coloursOf` in `term-colours-model.ts`
(theme.ts → term-colours-model.ts → theme-model.ts; no cycle).

## Files

`shared/protocol.ts` (UiTheme) · `web/src/ui/theme-model.ts` (state, clamp)
· `web/src/ui/theme.ts` (apply on `:root`, persist, debounce, flush; header
rewritten to the wired truth) · `web/src/ui/term-colours-model.ts`
(`stateOf(pair): TcState` helper if useful; otherwise untouched) ·
`web/src/ui/term-colours.ts` (control injected, `sync`, note deleted, header
rewritten) · `web/src/ui/settings.ts` (`SettingsDeps.theme`, pass-through,
re-read + sync on open, flush on close) · `web/src/main.ts` (`initTheme(prefs)`
in `buildShell` before `initSettings`; the "no theme rides along until B9"
comment goes) · `web/src/styles/app.css` (D3 surfaces) ·
`web/src/styles/tokens.css` (header comment on `--term-bg` only if it lies).
Tests (test-engineer): `tests/ui-theme-model.test.ts` rewritten to the pair
(both shapes, per-member clamp, Nocturne fallback), `tests/ui-term-colours-a7.test.ts`
+ `tests/ui-settings-a7.test.ts` + `tests/ui-a8-chrome.test.ts` +
`tests/ui-copy-separators.test.ts` — the four "B9 will wire it" pins flip to
positive pins (main.ts calls `initTheme` before `initPanes`; the page still
imports nothing from theme.ts / terminal.ts; theme.ts still builds no DOM), a
new `tests/ui-b9-theme.test.ts` under the fake DOM: apply writes the six
properties, Nocturne removes them, a Legacy bag maps to the same hexes, the
debounce collapses a burst into one PUT that carries the last pair and keeps
the other bag keys, the page's card click reaches the control, the re-read
path re-syncs.

## Amendments after the reviews (2026-09-22; they win over the items above)

- **A1 (D1 refined) a present-but-unreadable `theme` is no opinion.** The
  developer's `isUiTheme` = "carries at least one readable member of either
  shape"; `themeFromBag` returns `null` otherwise, and the local cache then
  STANDS (boot and the dialog's re-read alike). D1's "invalid = Nocturne"
  holds for the clamp of a value that IS read; a garbage member never resets
  a user's terminals. A valid Nocturne pair on the server still beats an
  amber cache (checked by the scope reviewer and pinned by
  `tests/ui-b9-theme.test.ts`).
- **A2 (scope finding) the re-read on open adopts, never applies.**
  Reopening the dialog before the previous close's flush landed re-read a
  stale bag, repainted the old pair AND scheduled a PUT of it (the
  durable copy would have been the old pair). `ThemeControl.adopt(pair)`:
  paint + cache, no server write, and a no-op while a write is pending or in
  flight; the re-read calls it instead of `apply`.
- **A3 (scope finding, pre-existing) `api.updatePrefs` no longer PUTs a bare
  patch when its GET failed** — it throws, so a backend hiccup during a
  swatch drag can no longer reset `statusLine`, `behaviour` and `tools` to
  factory. Every caller already catches (the rows revert, theme.ts keeps
  the cache). The theme write also passes `DEAD_PREFS_KEYS` like every other
  writer.
- **A4 (D3 completed) an editor pane with no drawable tab** left a bare
  `.pane-body` on the themed ground; the pane root now carries `is-editor`
  and that body reads `--color-term`.
- **A5 (known limit, recorded) the default card is one step quieter than the
  default terminal.** Nocturne is painted by REMOVING the overrides (D2), so
  its bright step is the token `--xt-bright-white: #f3f5fe`, while the card,
  the preview and the `Text` field show `RAMPS[0].cmd = #e9e9ed` (the A1
  parity test pins that value to `--xt-cursor`). Typing `#f3f5fe` into
  `Text` therefore yields a custom pair, not the Nocturne card. Accepted; the
  model's header says so.
- **A6 (for B7, not B9)** the background-agents table and the two hairlines
  under the terminal (`.pane-status`, `.pane-agents`) still use neutral app
  ink and `--color-neutral-900` on the themed ground — invisible today (the
  table is empty until B7), a B7 constraint: its ink follows the theme's
  steps like the status bar's.

## Gates

- ONE phase, one developer (`terminal-ui`, `/frontend-designer` applies to
  the CSS ink change — no new looks). Readers: `scope-reviewer` +
  `test-engineer` (suite + the test work above) in parallel → ONE fix round
  → the test-engineer's mutation probe (≤ ~10 mutants: the clamp, the
  Nocturne-removes branch, the debounce, the D3 selectors).
- Final: full suite once by the orchestrator; `/verify-terminal` scoped to
  "two live panes beside Settings → Terminal colours: a card click repaints
  both at once with zero resize / attach lines; a session started AFTER the
  change is born in the new colours; reload keeps them; `Reset to Nocturne`
  returns the exact token hexes; check 1 (echo & colours) on the new ground:
  red / green / bold still render"; janitor (small); the Windows checklist
  for the user (pick `Amber on espresso` → every terminal changes, open a new
  session → same colours, close and start the app → still amber; a custom
  light ground → the pane status bar under it is readable, the editor and a
  commit diff are NOT recoloured; Reset).
- Landing: this Status line, the table row, the README index line, the
  scope-doc bullet at ≈ 1058 ("mock until B9" → live, the prefs shape), the
  `theme.ts`-stays sentence in B8's bullet if it now reads wrong, the vault
  log entry + a note on the decision note (`terminal-colours-shape.md`:
  implemented, the pair), commit + push, CI watched to green.
