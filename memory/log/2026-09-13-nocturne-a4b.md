---
type: log
created: 2026-09-13
updated: 2026-09-13
tags: [log, nocturne, frontend, terminal, fonts]
---
# 2026-09-13 — Nocturne A4b: terminal ground + font load fix LANDED

Context [[nocturne-full-switch]]; follows [[2026-09-10-nocturne-a4]]. Both
defects came from the user's Windows test of A4 (2026-09-10). Lessons in
[[xterm6-ground-and-font-race]].

Built (terminal-ui, opus): (1) the ~17 px black band was xterm 6.0.0's
`.xterm-viewport` — an EMPTY div its stylesheet paints `#000`, absolutely
positioned over `.xterm`'s padding box; the runtime only grounds
`.xterm-scrollable-element`. Fix is CSS only: `.term-host .xterm` and
`.term-host .xterm .xterm-viewport` get `var(--term-bg)`, `.pane-body` too;
padding untouched, cols/rows byte-identical (`217x46`, `103x46`, `103x21`,
`75x15` per layout, PTY-side). (2) JetBrains Mono race: new pure module
`web/src/ui/font-ready.ts` (`ensureFontsLoaded` bounded by
`FONT_WAIT_MS = 1500`, weights 400 + 700 = xterm's bold default,
`watchFontArrival` fires at most once); `main.ts` starts the load before
hydrate, awaits it before `buildShell`, shows it as a fourth boot row
`terminal font`; `TerminalView.reloadFont()` = fontFamily nudge →
`clearTextureAtlas()` → the existing `#fitNow(true)` (one resize path).
Probe: woff2 held 3 s → `217x52` on the fallback, `217x46` after arrival,
exactly one late `resize`; 0 ms → no redraw, boot overlay never mounts.

Review: security skipped (no endpoint/spawn/path). scope-reviewer 4
should-fix: `await fontReady` outside every try (a sync throw = dark window)
→ `.catch` at the source; up to 1.5 s blank page after the boot panel had
removed itself → honest fourth row; a throwing `check()` returned `'already'`
(zero wait, watcher latched off, nothing logged) → own outcome
`'unparseable'`; `.composition-view` (IME pre-edit popup) had ridden along
in the override → dropped, xterm's `#000`/`#FFF` overlay kept. Orchestrator
arbitrated the last one against the test-engineer's tests (scope wins: the
popup is a deliberate high-contrast overlay, outside "the terminal area").
test-engineer: 33 + 36 mutants, 6 + 2 survivors closed (the fontFamily nudge
is now EXECUTED from source; the installed `xterm.css` is scanned for every
`#000` surface with an explicit `EXEMPT` list). Notes applied inline by the
orchestrator: `'unparseable'` as its own log word, "fallback face" → plain
"substitute font", `.boot-lb { white-space: nowrap }` (label wrapped in the
fail state). Suite 1320 → 1358; 1 fix cycle; verify-terminal 1–9 PASS twice
(before and after the fix round) via CDP against a scratch backend.

Owed: Windows/WebView2 look (no black frame in 1/2/4 panes and after a
divider drag; glyphs = JetBrains Mono on the first pane after a cold start
and after Restart backend; no torn TUI rows after a window resize). Janitor
pass skipped (fix-sized, tree verified clean) — still owed with the next
feature land per [[BACKLOG]]. Next: A5 on "begin aan A5".
