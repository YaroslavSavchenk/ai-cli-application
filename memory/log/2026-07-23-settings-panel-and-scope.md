---
type: log
created: 2026-07-23
tags: [settings, dev-flow, icon, github, design, milestone]
---
# 2026-07-23 — Settings panel landed; icon reality; GitHub + WebView2 scope

## Shipped

**App settings panel (frontend)** — the last v1 settings feature — landed via
dev-flow and pushed. Commits `af21949` (feature) + `cee094d` (scope/memory).
- Topbar Settings button → modal. Two sections: **Launch defaults** (default
  model + default permission mode pre-select the launch dialog; per-launch
  override preserved; project default beats global; startup command
  auto-typed into every new claude session once, on first live output) and
  **Usage** (read-only aggregates from `GET /api/usage`, fetch-on-open, no
  poll). Prefs persist server-side via `/api/prefs` merge-on-write.
- Backend (`/api/usage` + typed launch defaults) had landed earlier in
  `1425e3d`.

## Dev-flow record

- 3 reviewers parallel, all clean gate: **scope** (matches decided four-option
  shape, no creep, server-side prefs, per-launch override preserved),
  **security** (startup command is PTY-input-only never argv; multi-line
  injection stripped even from a planted prefs.json; auth on every call;
  usage render textContent-only; model/perm allow-listed), **test-engineer**
  (added `ui-launch-preselect.test.ts`, suite 154→**162/162**).
- 2 LOW findings → fixer: **F1** commit() persisted the raw (unclamped)
  defaults bag → drift/write-churn in prefs.json (fix: persist `getDefaults()`);
  **F2** `getDefaults()` returned by reference vs its "by value" doc (fix:
  shallow copy). Both green after.
- Terminal touch (onFirstData + typeStartup) verified **statically** (can't
  run xterm headless): fires once, live-data-only via `onData` not `onReplay`,
  reattach-safe via consume(), reaches PTY via `sendInput(line+'\r')`.
- Janitor: no changes, already clean.
- **Manual gate still owed:** live browser verify-terminal (esp. the
  startup-command auto-type end-to-end).

## Decisions recorded this session (see decision notes)

- [[github-integration]] — project creation + GitHub via OAuth device flow;
  v1 = full create-local / clone / create-repo; token server-side. User's call.
- [[native-webview2-host]] — the Edge-logo taskbar icon: cheap AUMID/shortcut
  fix proven **structurally impossible** here (wsl-launcher agent: Edge is a
  grandchild of the shortcut, and Edge 150 stamps a per-URL window AUMID that
  churns with the auto-picked port; PWA-install stays closed). Fix = bring a
  lightweight **WebView2 host** forward (owns both window + shortcut AUMID),
  not full Tauri. User delegated the pick ("best, secure, not complicated").

## Lesson

Edge `--app` taskbar identity is not a favicon problem — the favicon was
already valid at every size. It is an AppUserModelID problem, and our
own launch chain (shortcut→wscript→powershell→edge grandchild) plus the
churning port make the two AUMIDs that must match unmatchable without a
process we own. Verify structural claims like this at the source before
shipping a "fix" — the agent correctly shipped nothing.

## Queue / sequence

User dropped a refreshed design handoff into `design/` (deleted
GAP-ANALYSIS.md, refreshed the prototype HTML — left UNCOMMITTED for the
design task; note the dangling `PROJECT-SCOPE.md` ref to GAP-ANALYSIS.md to
fix there). Sequence: **settings ✅ → WebView2 host → design reconciliation →
GitHub build.** The new handoff README reads as the same steam-blend
direction already shipped, so the design task is a **delta reconciliation**
(diff prototype vs running app), not a rebuild, and stays vanilla-TS (the
prompt's "use React" default is overridden by its own "existing stack wins").

Related: [[github-integration]], [[native-webview2-host]],
[[2026-07-20-theme-persistence-launcher]], [[handoff-design-primary]]
