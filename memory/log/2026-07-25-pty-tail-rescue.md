---
type: log
created: 2026-07-25
updated: 2026-07-25
tags: [pty, sessions, libuv, node-pty, dev-flow, security]
---
# 2026-07-25 — the lost PTY tail, fixed

Full `/dev-flow` on the bug the previous phase's test gate surfaced: a
session's **final output was missing from the scrollback replay** after exit.
Developer → three reviewers → fixer, one fix cycle. **Suite 391 → 396**,
typecheck clean. Landed and pushed.

Root cause, symptom, the recognition tells and the accepted limits live in
[[pty-exit-data-race]] — this note is what the *process* produced.

## What each stage actually added

- **Developer** found the real cause (libuv's synthetic EOF, not node-pty
  ordering) by instrumenting node-pty rather than reasoning about it, and built
  a **zero-load** reproduction — stalling the reader inside the data handler —
  after establishing that crude CPU load is a weak trigger.
- **`scope-reviewer`** confirmed there is no public route to the pty master
  (checked `IPty`; `UnixTerminal.master` is `undefined` for `spawn()`ed
  terminals), so internals were the smaller of two bad options. Caught that
  `emit()` sat outside the try/catch, and that the O_NONBLOCK justification
  named the wrong source.
- **`security-auditor`** independently caught the same two, and added the fd-
  identity gap: the guards close the double-call window but never check the fd
  is still *this* pty. It could not construct a reachable path with node-pty
  1.1.0 — and said so — but simulated the precondition and showed an unrelated
  file's contents reaching the scrollback and every attached client.
- **`test-engineer`** mutation-tested with 40 runs per test and sha256-verified
  every revert, which produced two **downward** corrections to earlier claims
  (below).

## Claims that did not survive scrutiny

Both were corrections *against* the change, from the people verifying it:

- "2 of 3 new tests fail without the fix" — true for a typical run, but the
  third caught the bug **1 time in 40**; it gates detached buffering, not this
  race. Real regression gate is 4 of 5 after the gate added two more tests.
- The doc comment asserted a UTF-8 seam that **did not reproduce** in 48 probe
  runs (0 replacement characters); a different reviewer measured exactly 2
  under an all-multibyte tail. Comment now matches the evidence instead of
  overstating a defect.

## Lessons

**A comment that documents an invariant the code does not implement is worse
than no comment.** `drainPtyMaster`'s doc said "a failed rescue must never take
a session down" while `emit()` sat outside the try/catch — a throw there would
skip the real `destroy`, pin the session at `running` forever, and reach
`uncaughtException`, which unlinks `runtime.json` and exits the process that
hosts *every* session.

**Prefer a local guarantee over an inherited one.** Twice in two phases the
right call was one cheap syscall or option that moves a guarantee into our code
(`redirect: 'error'` for the OAuth token; `fstat` identity before the drain)
rather than depending on a third party's ordering. Both were reviewer
suggestions, neither was a live vulnerability.

**Honesty about what a check cannot do.** The fd-identity check separates "a
pty master" from "not a pty master" — but every pty master in the process
clones `/dev/ptmx` and shares one `rdev`/`ino` (measured: three sessions, all
`rdev=1282 ino=86`), so it cannot separate two pty masters. Distinguishing them
needs native `ptsname(3)`. That limit is written into the code comment, not
left implied.

## Decisions taken (user, 2026-07-25)

- **`node-pty` pinned exactly to 1.1.0.** The safety of a synchronous read on
  the event loop rests on node-pty's native `pty_nonblock(master)`; a silent
  version bump is how this fix would break unnoticed.
- **UTF-8 seam accepted, not closed.** Closable via public API
  (`encoding: null` + one SessionManager-owned decoder) but that reshapes the
  decode path for *all* session output, for one glyph.

## Still open

- **`/verify-terminal` live pass** — needs the Windows WebView2 UI, not
  drivable from WSL. Also untested: the rescue under a real Claude Code TUI,
  whose alt-screen teardown sequence at exit *is* the rescued tail.
- **No WS-layer proof of the race.** All five tail tests drive `SessionManager`
  in-process; the promise lives at `/ws/session/:id`. Stalling a real `ws`
  client deterministically needs sleeps (ws buffers in memory, no backpressure
  to the pty reader), so the gate left it uncovered rather than faking it.

## Process note

I broke the user's own constraint: they asked for load tests capped at 4 CPU
spinners, and I put that cap only in the test engineer's brief, not in the two
reviewers already in flight — which then ran 8 and 12 spinners on their daily
driver. The test engineer caught it, refused to stack load on top, and re-ran
its contaminated pass clean. **A constraint the user gives mid-flight has to be
propagated to every running agent, not just the next one.**

Related: [[pty-exit-data-race]], [[2026-07-24-github-hardening]],
[[pty-requirements]], [[lifecycle-bound-backend]], [[agent-team-and-dev-flow]]
