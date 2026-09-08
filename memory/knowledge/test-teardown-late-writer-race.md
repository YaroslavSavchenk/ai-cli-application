---
type: knowledge
created: 2026-09-08
updated: 2026-09-08
tags: [tests, flake, ci, sessions, logging, race, teardown]
---
# ENOTEMPTY on temp-dir teardown — the pty exit handler writes after `destroyAll()`

Found 2026-09-08 by GitHub Actions run 34248854109 (ubuntu-latest) on a
memory-only commit: exactly one test red,
`upgrade.closeAll: closes every OPEN socket with 1012 and counts each one exactly once`
with `ENOTEMPTY: directory not empty, rmdir '/tmp/ai-sm-restart-…'`. Never
seen locally on WSL2. Root-caused and fixed the same day (tests only).

## Mechanism

1. `SessionManager.destroyAll()` → `destroy(id, 'shutdown')` →
   `session.pty.kill()` and returns **synchronously**. The pty's `exit` is
   not awaited.
2. Ticks later node-pty emits `exit`; the handler (`server/sessions.ts`,
   `onExit`) writes — all with **sync** fs calls — into the data dir:
   `history.markEnded` (no-op here: `destroy()` already stamped
   `user-kill`), `session … exited with code`, `#flushOutputLog(force)`,
   and last `<id> totals: scrollback N bytes, M client(s) attached at exit`
   — all into `server.log`.
3. The test's `finally` is meanwhile in `rm(dir, { recursive: true })` =
   readdir → unlink → rmdir. A log line landing between
   `unlink(server.log)` and `rmdir(dir)` **recreates `server.log`** →
   `ENOTEMPTY`. Leftover dir held exactly `["server.log"]`.

A second, smaller late writer exists only where a WebSocket upgrade handler
is wired: the server-side close handlers (`presence disconnected code=…`,
`detached session <id> code=…`) can log after the *client* saw its close
frame — which is all the test had waited for.

**Not** `history.json`: the exit-path `markEnded` finds the entry already
stamped, so `#write()` never runs.

## Reproduce

Not by re-running the test file (real vite builds, too slow). Standalone
script: temp-dir `SessionManager` + `SessionHistory` + `createLogger`,
create a session, `destroyAll()`, `rm` — under `taskset -c 0 nice -n 19`
with 6 busy spinners pinned to cpu0. Before: `runs=60 ENOTEMPTY=6`
(10 %). After: `runs=60 ENOTEMPTY=0`. Same recipe as
[[pty-exit-data-race]]: starve the *consumer* side, don't just add CPU load.

## Fix (tests/helpers.ts)

- `waitForLogLines(logFile, { needle: minCount }, what)` — polls the real
  log for real lines (deterministic, not a sleep).
- `destroyAllAndSettle(sessions, logFile)` — snapshots ids, `destroyAll()`,
  waits for `<id> totals:` per id (the exit handler's LAST line; every
  earlier dir-touching effect in that handler is synchronous, so this also
  settles history.json and session-settings). Pty exits only — WS close
  lines need an explicit `waitForLogLines`, as the closeAll test does.
- `removeTempDir(dir)` — `rm` with `maxRetries: 5, retryDelay: 100`
  (ENOTEMPTY is in node's retry set) as a backstop only.
- Applied at every `destroyAll()` → `rm(dir)` site (3 in
  `tests/restart.test.ts`, 1 in `tests/logging.test.ts`). Requires the
  harness logger at `debug`/`info` and pointed at `<dir>/server.log`; a
  future `warn`-level harness times out loudly after 10 s naming the
  missing needle.
- A settle error in `finally` must never replace the test body's error
  (scope review caught the swallow) — the body's exception wins, the settle
  error is printed.

## Lessons

- "Passes locally, flakes on CI" for a teardown = look for a writer that the
  destroy path does not await. A `kill()` is not an exit.
- `void rm(dir, …)` (fire-and-forget) turns the same race into an unhandled
  rejection instead of a red test — worse, not better.
- Server-side option, deliberately NOT taken: `destroyAll(): Promise<void>`
  resolving after the last `onExit`, and a logger `close()`. Would make
  `shutdown()` honest about when the data dir stops being written. Product
  decision; recorded in [[release-build-and-launcher-derivation]] context
  only as a follow-up candidate.
