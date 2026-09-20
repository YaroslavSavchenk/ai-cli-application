---
type: log
created: 2026-07-26
updated: 2026-07-26
tags: [statusline, settings, shipped]
---
# 2026-07-26 — statusline phase · SHIPPED

Full dev-flow: 2 developers → 3 reviewers → 1 fix cycle (6 findings) →
scoped re-review (all VERIFIED) → inline doc fix (N1) → janitor CLEAN.
Suite 533 → 508 (net: big deletions + 35 new tests), tsc ×2 exit 0, build
clean. Committed and pushed after the janitor pass.

**Built (both halves done, first review round done, fix pass done):**
- Backend: `server/statusline.mjs` (script Claude Code runs; stdin payload +
  fresh prefs.json per invocation), `server/session-settings.ts` (per-session
  `--settings <dataDir>/session-settings/<id>.json`, injected for claude-kind
  spawns unless client passed `--settings`), `SessionInfo.statusline?:
  boolean`, `UiPrefs.statusLine`, DELETED usage/telemetry backends + routes +
  `UiLaunchDefaults`/`UiStatusBar`. `refreshInterval: 2` is SECONDS (verified
  against claude 2.1.220 binary; docs say ms — docs are wrong).
- Frontend: statusbar/startup/defaults modules deleted with wiring; settings
  panel = one plain-language Status line section (new
  `web/src/ui/statusline-model.ts`); restart notice names stale sessions via
  exported `commandLabel` + project-name collision suffix; launch precedence
  per-launch > per-project > hardcoded; dead prefs keys dropped on write.
- Review round 1: scope 2 MED + 2 LOW, security 1 LOW (cache-read sanitize),
  tests GATE PASSED +20 tests. All 6 consolidated findings FIXED (mode-item
  known-limit documented not removed — orchestrator call; notice labels;
  copy; cache clean-on-read; cache file in DataPaths + boot wipe + docs).

**Re-review status:** security VERIFIED-FIXED (11 poison variants replayed,
clean; notes: sanitize-on-HIT needs a pinning test — already in the
test-engineer brief; same-uid FIFO-symlink read hang = accepted low DoS
limit). Scope 4/4 VERIFIED; remaining should-fixes: N1 = web/DESIGN.md
:567-569/:590-594/:607-609 + app.css:2086 comment still quote the PRE-fix
copy strings; N4 = PROJECT-SCOPE.md rewrite — DONE by orchestrator (settings
panel + status line bullets rewritten, reversal recorded). Notes N2/N3
(label-predicate disagreement; orphanable cache .tmp) recorded, no action.
**Still in flight:** test-engineer re-gate (pins: cache-poison HIT case,
boot wipe, path-drift test, notice labels; mutation checks). After it: mini
fixer pass for N1 only, then final gate (janitor + verify-terminal
mechanical), memory write-back, commit+push.

## Final gate results

- Terminal checks ran inside both developer passes (protocol level: colors,
  Ctrl+C reaches PTY, resize 132×44 both directions, BEL attention,
  detach/reattach replay) — the mechanical `/verify-terminal` set. The live
  Windows-eye pass stays on the user checklist (panel look; taller pane —
  strip gone, +22 px — reflowing a live TUI).
- Janitor: CLEAN beyond 5 comment/import-level fixes. Left deliberately:
  `createProject`/`HealthResponse` pre-existing unused exports; the
  `statusline.ts` (app chrome bar) vs `statusline-model.ts` (Claude status
  line config) naming collision — documented in both headers, rename would
  be a refactor; README lacks a prose feature description (writer's call).

## Accepted limits & unpinned gaps (recorded, deliberate)

- Non-repo/detached-HEAD sessions re-probe git every ~2 s tick (negative
  results aren't cached — price of sanitize-on-read; pinned by test).
- Same-uid FIFO-symlink swap of `statusline-cache.json` can hang the script
  read (DoS-only, attacker already runs as the user).
- Notice-label + collision-suffix logic is inline DOM code, untestable
  without a jsdom the repo refuses; extract `noticeLabels()` into
  `statusline-model.ts` if it ever regresses.
- A custom-path `claude` command echoes verbatim in the notice (scope rule's
  own letter sanctions it).
- `writeCache` interrupted between write and rename orphans a `.tmp` beside
  the cache; boot delete doesn't sweep siblings.

## Facts a resumer must not re-derive

- Payload has NO permission mode (2.1.220 verified) → mode item shows LAUNCH
  mode; documented as known limit in panel caption + DESIGN.md + script.
- Old global launch default `bypassPermissions` in the user's real prefs no
  longer pre-selects the dialog (tier deleted by decision) — user informed.
- User-visible behavior change log + full review evidence: this session's
  reports; fixer once booted against the real data dir (verified harmless).
- `/verify-terminal` live Windows pass + GitHub OAuth App registration are
  STILL open user-side items (now five sessions old).

Related: [[2026-07-25-token-path-RESUME-HERE]] (the brief this phase
executed), [[2026-07-24-status-bar]] (the strip this phase removes).
