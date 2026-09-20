---
type: log
created: 2026-07-20
updated: 2026-07-20
tags: [milestone, backend, launcher, frontend]
---
# 2026-07-20 — theme persistence (server prefs) + launcher finished

Two phases run in parallel dev-flows after [[2026-07-20-r3-launch-dialog]],
both from direct user reports.

**Theme persistence (generalist-dev).** User: "theme resets every time I
close the app and reopen it." Root cause in
[[localstorage-origin-port-churn]]. Landed: `prefs.json` (opaque `UiPrefs`
bag, `PrefsStore` mirroring `ProjectStore`, atomic 0600) + authed
`GET/PUT /api/prefs` (object-only, 64 KiB cap via parameterized
`readJsonBody`, 200 `OkResponse` per convention); client hydrates at boot
inside the existing hydrate step (local cache first, server wins, applied
before any terminal exists — no flash), `persist()` merges the bag so
unknown keys survive. Pure logic extracted to DOM-free
`web/src/ui/theme-model.ts` (same pattern as launch-args).

**Launcher (wsl-launcher).** User: "make the launcher perfectly working,
desktop shortcut." Diagnosis: app.ico was fine (binary — a `wc -l` of 0
lines misread as 0 bytes); make-shortcut.ps1 had never been run. Fixed for
real: icon copied to `%LOCALAPPDATA%\ai-session-manager\` (UNC-only icon
went blank until WSL booted), silent-mode Edge-missing fallback now shows
an auto-dismissing warning popup, `-ErrorAction Stop` makes the App-Paths
attempt catchable. Desktop + Start Menu shortcuts created and verified by
readback; full flow proven from WSL incl. literal `wscript.exe`
double-click → live Edge app window (presence WS connected).

**Flow stats.** Theme: 1 fix cycle (204→OkResponse convention, null-bag
guard, theme-model extraction); security clean (3 notes — parse-error log
fragments, PUT write amplification, unreachable null-bag). Launcher:
1 fix cycle (2 README prose findings); security clean (zero findings).
Suite 92→120 (8 prefs incl. concurrent-PUT + per-route cap guard, 20
theme-model). Final gate: verify-terminal 9/9 + live persistence proof —
fresh context on a new port/token rendered the saved theme with no
default flash, `futureSetting` key survived a theme change byte-exact.
Session-limit interruptions twice mid-flow; all agents resumed from
transcript with zero lost work.

**Process change ([[model-policy note in auto-memory]]):** user directive —
all subagents run on opus (frontmatter pins updated, dev-flow SKILL.md
Models paragraph rewritten); Fable 5 = orchestrator thinking + final
review only. Orchestrator now personally reviews the final diff before
each commit (did so this phase: approved, with one forward note — once the
settings panel becomes a second prefs writer it must re-GET before PUT or
writers clobber each other's keys).

**Queued next:**
- **Favicon/app icon in the Edge window** (user report: window shows the
  Edge logo): serve favicon.ico + PNGs + manifest from the web app,
  generated from make-icon.mjs art. Taskbar final look = manual check.
- **Settings panel — UN-GATED, shape decided** (user answers 2026-07-20,
  recorded in PROJECT-SCOPE Features): default model, default permission
  mode (incl. plan), auto-run startup command, read-only usage display.
  Persisted in prefs.json.

Related: [[2026-07-20-r3-launch-dialog]], [[localstorage-origin-port-churn]],
[[thin-windows-launcher]], [[wsl-interop]]
