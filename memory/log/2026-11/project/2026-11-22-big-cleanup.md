---
type: log
created: 2026-11-22
updated: 2026-11-23
tags: [quality, cleanup, restructure, performance]
---
# 2026-11-22 — the big cleanup (Q9–Q15, O9)

The user: "ik wil een grote opruiming doen en code optimalisatie doen binnen
deze repo, jij moet dat uitvoeren". Three read-only audits (server/shared,
web, tests/docs) produced the candidates; the user picked all six batches
(`.claude/plans/PLAN-QUALITY.md` Q9–Q15) plus O9 in
`.claude/plans/PLAN-RESTRUCTURE.md`.

## Housekeeping (no commit)

- The stale isolation worktree of the D9 P3 gate removed after a file-by-file
  compare with `main` (its tests had landed in `0b1eec6`; the one differing
  file had the newer shared fixture on `main`). `.claude/` 16 MB → 836 KB.
- 10 local and 7 remote branches already contained in `main` deleted; the
  two Dependabot branches were already gone on the remote.
- Untracked `*:Zone.Identifier` files under `design/` deleted.

## O9 — design leftovers

`design/archive/handoff-v1/` (3 files) and the design tool's
`_ds_manifest.json` / `_adherence.oxlintrc.json` removed (`git rm`, user
approved the list). The audit had also listed `_ds_bundle.js` as unused —
wrong: `design/session-manager/session-manager-v3.html` loads it, so it
stays. References updated in `README.md`, `design/README.md`,
`.claude/plans/nocturne/PLAN-B8.md` and two decision notes; `memory/log/`
keeps its paths.

## Q10 — the suite's idle tails

`Promise.race([x, delay(N)])` with a ref'd `timers/promises` timer kept 66
test files alive 5–15 s after their last test (40 % of the summed per-file
time). Now `settleWithin` / `withDeadline` in `tests/helpers/helpers.ts`
(timer cleared and unref'd; every call site still fails or kills on a
timeout). Also one `drainMicrotasks`, one `sessionInfo()` factory with a
fixed `createdAt`, the dead `design/` skips are failures, and the
`test-pty-host` CI leg runs `npm run test:server` (no `tests/ui` file starts a
backend). Full suite 72.7 s → 49.2 s wall, 4619 / 0.

## Q9 — real bugs

- A session WS text frame `null` threw in `server/ws.ts` →
  `uncaughtException` → exit: every session gone. Frames go through
  `plainObject()` now. Reachable only with the token, but a client bug was
  enough.
- `maxPayload` 16 MiB (was the `ws` default 100 MiB). The browser now sends a
  paste in ≤ 1 Mi-unit `input` frames (never splitting a surrogate pair) —
  without that, a paste over the cap was lost silently.
- Backpressure: a client with > 16 MiB unsent is closed with 1013
  (`SLOW_CLIENT_CLOSE_CODE`, `shared/protocol.ts`); the security review found
  a live-but-slow tab would loop close→reconnect→replay every ~0.5 s, so the
  client retries a 1013 at the 5 s maximum and the log line is limited to 3
  per minute per session.
- Web: the exited note re-rendered on every 3 s poll, which un-armed "End
  session → Sure?" and dropped focus — `noteSig` guard. The Files panel's git
  poll pauses while the window is hidden (user's pick); the session poll stays
  (health probe).
- `isValidDim` has one home in `server/config.ts`.

## Q14 — documents

- `.claude/PROJECT-SCOPE.md` § Open decisions held nothing open: its settled
  records moved verbatim to `memory/decisions/scope-history.md` (55 → 48 KB);
  the installer line said "IN PROGRESS" though it shipped in v0.2.0.
- `memory/BACKLOG.md`: done items into the archive, the active list
  open-only; new open item: the agents stale-row CI flake (run 45064858642).
- `.claude/plans/RELEASE-NOTES-v0.4.0`…`v0.4.4-draft.md` removed (published
  GitHub releases); citations reworded.
- `memory/INDEX.md` entries trimmed to ≤ 200 chars (61 → 29 KB), every link kept.
- Agent definitions: the D9 pty-host facts; `model: opus` on all of them.
- `tests/release/ptyhost-windows-scripts.test.ts`: the 10 s stop-script wait
  is measured with `performance.now()` — WSL steps the wall clock back ~1 s
  ("Time jumped backwards" in dmesg), which failed it 2 of 4 runs.

## Q11 — dead code, duplicates, two more crashes

- Unused exports dropped (~85 server, 61 web); test-only helpers
  (`isKeyShaped`, `RingBuffer.toString`, `followerCount`, `isRowMenuOpen`)
  deleted, their tests moved to public behaviour. One assertion in
  `ui-context-menu-close` was dropped, not moved — the card-gone and
  listener-baseline checks next to it already prove the same.
- One home: `readSmallRegularFile` for the agents/telemetry readers,
  `closeQuietly`, `plainObject` (github-parse `asRecord` keeps accepting
  arrays: an array body ends the device flow), `isStringArray`, `FULL_HASH`,
  `sessionName()` (web), and `runChild` in the new `server/config-spawn.ts`
  under `runCapture` / git / scaffold / clone (each caller keeps its own
  `spawn` call — argv, `shell: false`, env, timeouts unchanged).
- Found on the way, both crash the backend and every session:
  - an upgrade to an unparseable target (`//[`) — WITHOUT a token — threw
    in a second, unguarded `new URL()` in `server/ws.ts` → now 400 (after
    the Host/Origin checks);
  - `/ws/sessions/%E0?token=…` threw in `decodeURIComponent` → now 404 like
    an unknown session.
  - scaffold `runGit` read its timer before it existed when spawn threw
    (ReferenceError) → now `git is not available`.
- Spawn-seam mutation gate: 55 mutants, 52 killed, 3 equivalent; 14 tests
  written for the first-pass survivors (e.g. a flooding git was never proven
  killed at the 2 MiB cap). Suite 4644 / 0, 47.4 s.
- Kept for the user: `resetProtectedSetCache` (a non-clock test seam
  CONTRIBUTING disallows; used by two fs tests).

## Q13 — files cut at their seams

| File | Before | After | New |
| --- | --- | --- | --- |
| `server/sessions.ts` | 992 | 837 | `sessions-adopt.ts` (detach/adopt over an `AdoptContext`) |
| `server/config.ts` | 923 | 612 | `config-log.ts` (the whole logger) |
| `server/update-install.ts` | 960 | 694 | `update-interop.ts` |
| `server/github.ts` | 966 | 875 | `github-store.ts` (`GithubTokenStore`) |
| `server/agents.ts` | 949 | 716 | `agents-main.ts` |
| `web/src/ui/launch.ts` | 978 | 866 | `launch-tools.ts` |
| `web/src/ui/panes.ts` | 977 | 871 | `panes-split.ts` |
| `web/src/ui/github.ts` | 962 | 623 | `github-token.ts`, `github-newrepo.ts` |
| `web/src/styles/app-panels.css` | 967 | 431 | `app-files.css` (built CSS byte-identical) |

Moves only; scope and security reviews compared every moved hunk. The
logger's ~60 importers import from `config-log.ts` directly instead of a
re-export from `config.ts` — at odds with `CONTRIBUTING.md` "re-export what
moved"; the amendment is put to the user. Suite 4644 / 0.

## Q12 — the app's speed (landed 2026-11-23)

Built 2026-11-22, landed the next day after the session ran out mid-review.

- Output path: a PTY chunk is UTF-8 encoded once (in `server/pty-table.ts`)
  and that buffer travels on to the wire / the backend mirror; the ring
  trims by a head index instead of `shift()` (70 µs per append at the cap)
  and blanks each trimmed slot (review: dead slots held up to ~4 MiB per
  ring until compaction); `replayTail` walks the chunks newest-first and
  copies only what it replays; one stringify per broadcast.
- Logger (`server/config-log.ts`): the file stays open (O_APPEND, 0600,
  close-on-exec), reopened after a rotation, a failed write, or when a
  once-a-second stat finds the path names another file.
- Web: `web/src/ui/chrome-dispatch-model.ts` says which change kinds reach
  which chrome renderer (the 5 s pong no longer redraws tabs, drawers,
  Files); the status line redraws only when its signature changes; a poll
  with an unchanged list notifies nothing — so a project rename now reaches
  pane headers, the settings notice and the update confirm through
  `projects` (review finding, pinned).
- `vite.config.ts`: xterm + addons in their own `assets/xterm-*.js` chunk
  (446 kB of the 788 kB entry); `server/buildinfo.ts` still finds
  `index-*.js`.
- Found on the way: negative `over -844ms` durations (wall clock steps back
  in WSL → `performance.now()`), a stack overflow from `unshift(...held)` in
  the pty-host client.
- User's call: `sessions-replay` lost its "fallback is the ring itself, not a
  copy" identity check (no single ring Buffer any more); byte equality plus a
  seeded random-ring oracle test against the old cut replace it.
- Reviews: security clean; scope 2 should-fix, fixed with a failing-first
  test each. Suite 4676 / 0.

## Q15 — dependencies (landed 2026-11-23)

- The first try (worktree in a session scratchpad, 2026-11-22) was lost with
  the scratchpad: no commits; worktree pruned.
- vite 8.3.8 and source-map-js 1.2.4 were already current (Dependabot
  bump of 2026-11-20). Bumped: `@types/node` 26.1.1 → 26.6.6, `@types/ws`
  8.18.1 → 8.18.2 (floors in `package.json` raised too). Typecheck clean.
- `.github/dependabot.yml`: weekly npm and github-actions version PRs,
  `@types/*` grouped, actions grouped (they stay SHA-pinned; Dependabot
  updates SHA + version comment).
- Suite 4676 / 0. PLAN-QUALITY has no `todo` row left.

