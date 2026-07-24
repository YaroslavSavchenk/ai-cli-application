---
type: knowledge
created: 2026-07-24
updated: 2026-07-24
tags: [pty, sessions, scrollback, race, node-pty]
---
# A session's last output can be lost between `onData` and `onExit`

Found 2026-07-24 by the test gate during unrelated work (GitHub
test-hardening), **not** by the change under review. Pre-existing.

`server/sessions.ts:163-180`: `proc.onData` appends to the scrollback ring
buffer; `proc.onExit` immediately stamps the session `exited` and broadcasts
the `exit` frame. Nothing guarantees the final `onData` chunk is delivered
before `onExit` fires — node-pty closes the master fd when the child exits, so
the last read can be dropped under CPU contention.

Consequence: **the newest output is missing from replay after reattach.** That
is the crown-jewel path of this whole app — a session you reopen is supposed to
look like the terminal you left.

## Why it hid for so long

It is load-dependent. `tests/sessions.test.ts:301` ("scrollback ring buffer:
replay stays <= 1 MiB … keeps the tail") passes **10/10 alone** and failed
**3 of 26** full-suite runs, only when the suite ran alongside other node
processes. It surfaced now because the suite grew 288 → 391, so a single run
carries more concurrent load than it used to.

The failure signature is worth recognising: the size assertions
(`<= 1 MiB`, `>= 900 KiB`) **pass** while `RING_END_MARK` is absent
(`markIdx === -1`). Ring near-full, tail gone. A test that only checked the
buffer size would have called this healthy.

## The trap to avoid

Do **not** relax the assertion to get a green suite. Either drain pending data
before stamping exit, or — if that turns out to be unachievable with node-pty —
change the test to prove the *limit* explicitly, the way
`tests/ui-github-model.test.ts` marks its `KNOWN LIMIT`. A flaky test on this
path is reporting a real defect, not noise.

Tracked as an open item in `.claude/PROJECT-SCOPE.md`. Needs its own
`/dev-flow` pass plus `/verify-terminal`, since it touches PTY lifecycle.

Related: [[pty-requirements]], [[lifecycle-bound-backend]],
[[frontend-terminal-quirks]], [[2026-07-24-github-hardening]]
