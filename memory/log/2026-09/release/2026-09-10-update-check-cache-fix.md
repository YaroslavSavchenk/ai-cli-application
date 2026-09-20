---
type: log
created: 2026-09-10
updated: 2026-09-10
tags: [log, update, cache, testing]
---
# 2026-09-10 (night) — the Update button that never came: cache verdict bug FIXED

User report: "ik zie nog steeds geen update knop" after installing v0.3.0
to test the button against v0.3.1. Diagnosed from `server.log`: v0.3.1
had been installed first (21:44Z, verdict "not newer" cached with the
ETag), then v0.3.0 (21:47Z) adopted that cache → `304` → no offer.
Reproduced the 304 with `curl` and the cached ETag. Lesson note:
[[etag-cache-verdict-not-payload]].

## What landed (`1cdb766`, dev-flow, 2 cycles)

- `server/update-release.ts`: cache holds `latest: UpdateRelease | null`
  (the gated descriptor, field renamed on purpose so old files read as no
  cache), `offer()` derives "newer than me" per call, `gateRelease` deleted
  (`gateLatestRelease` gates payload + assets, version order in ONE place).
- Tests: downgrade regression through a real 304 (three checkers on one
  cache file, served-status recorder, on-disk assertions) + end to end over
  `/api/runtime` with a 304-only stub; old-shape file → no `If-None-Match`;
  no-ETag unlink path; version order is not the gate's business.
- `tests/installer-helpers.test.ts`: `proveNewer()` at all four
  retention-order sites (a backward clock step had pruned the wrong
  fixture once during the gate).
- Scope bullet "In-app update" now says what is cached and why.

## Review

Cycle 1: scope 2 LOW (doc clause, dead `gateRelease`), security CLEAN
(a doctored cache buys nothing the same attacker position — see
[[wsl-0600-not-a-boundary]] — does not already have), test gate 5/5
mutants killed + 1 MED pre-existing flake (ctime order). Cycle 2: scope
CLEAN, test gate 3/3 mutants killed, 1 LOW (three more `settle()` sites)
fixed inline by the orchestrator. Suite 1165/1165 ×4.

## Immediate unblock for the user

Deleted the stale `~/.ai-session-manager/update-check.json` (the live
v0.3.0 backend, pid 598, keeps the ETag in memory until restarted).
After v0.3.2 is released the user restarts the app → v0.3.0 asks in full
→ offers v0.3.2 → the button test runs against a build that carries the
fix.
