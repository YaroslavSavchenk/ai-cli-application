---
type: log
created: 2026-07-24
tags: [status-bar, telemetry, dev-flow, design-reconciliation, honesty, milestone]
---
# 2026-07-24 (pt.1) — Design reconciliation + per-pane status bar shipped

Started from [[2026-07-23-webview2-host-shipped]]'s queue. Committed the
uncommitted `design/` intake, then found the refreshed prototype's delta was
mostly the **Phase 2 GitHub/project-creation UI** plus one genuinely-new
feature: a **per-pane terminal status bar**. Reconciliation ≈ Phase-2 UI, so
the two queued tasks collapsed. User chose **status bar first**.

## Decisions taken to the user (3 forks the intake surfaced)
- **Sequencing:** status bar first, then the GitHub build.
- **Blank "create local project":** an **"Initialize git repo" toggle, default
  on** — reconciles the prototype's "no git init" caption vs the earlier
  always-init. (Phase 2.)
- **OAuth scope:** request the **`repo` (write) scope up front** — one grant
  covers list + clone + create-repo + push. Prototype's "read-only" caption
  superseded. (Phase 2.)
All recorded in `.claude/PROJECT-SCOPE.md`; see [[github-integration]].

## Shipped — status bar (`7efbcd6`)
- **Backend** `server/telemetry.ts` + `GET /api/telemetry` (same token +
  Origin/Host gate). Git branch + `--numstat` diff via argv spawn (no shell);
  claude sessions get cost/context/model/skill from their OWN Claude Code
  JSONL log, mapped by **cwd-slug (`/`→`-`) + newest-`*.jsonl`-after-createdAt
  + cwd-match on records**. Reuses `usage.ts` streaming/dedupe/foreign-read-
  only discipline. 2s cache. Pricing/context table for opus-4-8/sonnet-5/
  haiku-4-5/fable-5 (from the claude-api skill, 2026-07-24); unknown model →
  omit cost, never guess.
- **Frontend** `web/src/ui/statusbar.ts` — DOM-free `buildItems()` honesty core
  + ~3s poll (paused when no pane visible; last-known kept for exited
  sessions). Settings gains a third section: live preview + 8 toggles + an
  honest **disabled "Usage limit" row** ("not available from local logs").
  One new token `--surface-panestatus:#0b0e13`; server-side prefs (never
  localStorage — [[localstorage-origin-port-churn]]).

## The honesty rule (load-bearing this session)
The prototype fakes ALL telemetry; we show a **real value or render nothing**.
Split: model/mode from launch args, time from `createdAt`, branch/diff/cost/
context/skill real-or-omit. **`usage %` DEFERRED, not faked** — it's an
account rate-limit % that lives in live API response headers, not the local
logs; shipped as a disabled settings row. Cost is an estimate → rendered `~$`
and captioned "approximate". This is what the scope reviewer's one should-fix
enforced.

## Dev-flow record
backend-pty → terminal-ui (sequential; both touch protocol.ts) → parallel
review (scope + security + test) → fixer → re-review (test-engineer added
`buildItems` tests once it was exported) → janitor. **Security CLEAN.** Scope:
1 should-fix (cost "approximate" label) fixed, 2 notes dropped. Suite
**162 → 222** (+60), typecheck clean, vite build OK. One fix cycle. All agents
on opus, orchestrator arbitrated.

## Lessons
- **Reconnaissance changed the plan.** Reading the prototype delta + the real
  Claude logs (records carry `cwd`, `gitBranch`, `model`, `usage`, `sessionId`
  = filename) turned "faked status bar" into a genuinely real feature and
  proved per-session log correlation is clean. Evidence before speculation.
- **Real-or-omit beats faithful-to-mockup.** The mockup's 9th item (`usage %`)
  had no honest source; shipping it disabled is more honest than a fake number.
- **Export the DOM-free seam.** `buildItems` was untestable until exported;
  that one-line change unlocked 29 honesty/format assertions. Design pure
  cores to be reachable by `node --test` without a DOM.

## Loose ends
- **verify-terminal live pass PENDING** (Windows WebView2 UI; not drivable from
  WSL). Mechanical resize chain verified (strip = `flex:none` sibling →
  ResizeObserver → FitAddon → `pty.resize`); the live #4-resize check + strip
  render/toggle are a manual checklist handed to the user. build-verified ≠
  runs — same lesson as the WebView2 launch regression.
- Untested (low-risk, DOM/timer): `makeItemEl` class map, strip-hide-on-empty,
  `inputsFromSession`, poll machinery — verify-terminal territory.

## Next: Phase 2 — GitHub / project-creation build (STARTED THIS SESSION)
Full `/dev-flow`, multi-phase. OAuth **device flow**, token **server-side only**
(never to the page), every GitHub endpoint behind the token + Origin/Host gate,
git ops via **argv** (no shell). v1 = create-local (git-init toggle) / clone /
create-repo. Backend already has `/api/fs/list` (folder browse, read-only) —
picker's "new folder" needs a mkdir endpoint. Threat model + sub-questions in
[[github-integration]].

Related: [[2026-07-23-webview2-host-shipped]], [[github-integration]],
[[handoff-design-primary]], [[localstorage-origin-port-churn]], [[pty-requirements]]
