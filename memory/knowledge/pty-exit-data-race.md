---
type: knowledge
created: 2026-07-24
updated: 2026-07-25
tags: [pty, sessions, scrollback, race, node-pty, libuv]
---
# A session's last output was lost at exit — libuv's synthetic EOF

Found 2026-07-24 by the test gate during unrelated work; root-caused and fixed
2026-07-25. **Symptom:** reattaching to an exited session showed scrollback
missing its newest output — the end, which is the part that matters (a CLI's
final answer before it exits).

## The real cause (my first guess here was wrong — keep the correction)

The original note in this file blamed node-pty's `onData`/`onExit` ordering.
**That was wrong.** node-pty already defers correctly: its native `onexit` does
not emit `'exit'`, it waits for the socket `'close'`
(`node_modules/node-pty/src/unixTerminal.ts:78-103`). The 200 ms
`DESTROY_SOCKET_TIMEOUT_MS` is only a macOS fallback and was instrumented as
never firing in the failing runs.

The bytes are dropped **below node-pty, in libuv**. When the child exits, the
pty master gets POLLHUP. `uv__stream_io` (libuv `src/unix/stream.c`)
short-circuits to a **synthetic EOF** whenever `UV_STREAM_READ_PARTIAL` is set
and `UV_STREAM_READ_EOF` is not — *without reading again*. A short read always
sets READ_PARTIAL, so if the reader is behind, whatever the kernel still holds
is discarded and never reaches `onData`.

The tell, and the fastest way to recognise this class of bug:

- stream emits **`'end'`** → fabricated EOF, bytes lost;
- stream emits **`'error' EIO`** → the real end of a pty, nothing lost.

And the data is provably still in the kernel at that instant: a plain `read(2)`
inside the `'end'` listener recovers the missing bytes exactly, then reports
EIO.

## Why it hid, and why the test that caught it was well built

Load-dependent: `tests/sessions.test.ts:301` passed 10/10 alone and failed
3-in-26 full-suite runs under contention. It surfaced when the suite grew
288 → 391, because a single run then loads the machine enough by itself.

Two things worth copying:

- The **size assertions passed** (`<= 1 MiB`, `>= 900 KiB`) while the tail
  marker was absent. The ring was full; only the end was gone. A test checking
  buffer size alone would have called this healthy — it caught the bug only
  because it asserted a marker at the tail.
- Crude CPU load is a **weak trigger**: bash spinners slow the writer as much
  as the reader (measured 0/8 loss with 8 spinners and no stall). What
  reproduces it deterministically is **stalling the reader** inside the data
  handler — 6/6 loss at 64 KiB with a 20 ms block, at zero system load.

## The fix

`server/sessions.ts`: wrap `destroy` on node-pty's internal master read stream
and synchronously `readSync` the fd there, feeding bytes into the *same*
handler `onData` uses (one ingress — same ring buffer, same broadcast, same
BEL/attention scan). No clock: the loop ends on the kernel (EIO/EAGAIN/0).
Ordering is free — `destroy` runs before the socket `'close'`, and node-pty
emits `'exit'` from that `'close'`, so rescued data always precedes the exit
frame.

## What this costs us, and what to re-check on a node-pty upgrade

We depend on **two undeclared node-pty internals** (`fd`, `_socket`; neither is
in the public `IPty` typing — there is genuinely no public route to the pty
master, since `UnixTerminal.master` is `undefined` for anything `spawn()`ed).

The safety of a *synchronous* read on the event loop rests on the fd being
non-blocking. **libuv does not do that for pty masters** — `uv_tty_init` skips
`uv__nonblock` on the non-slave branch. The guarantee comes from node-pty's own
native code, `src/unix/pty.cc` `pty_nonblock(master)`. If that ever went away,
a `readSync` against a pty whose slave is still held open by a surviving
grandchild would block in the kernel with no timeout — freezing the single
process that serves every session, the HTTP API and every WebSocket.

Hence: `node-pty` is pinned **exactly** to 1.1.0 (user's decision 2026-07-25),
and a version bump means re-running `tests/sessions-tail.test.ts` and
re-checking `pty_nonblock`.

Known, accepted limit: a multi-byte character split exactly across the
fabricated-EOF boundary can render as a replacement character — real but rare
(one reviewer measured 0 in 48 runs; another measured exactly 2 in 19 of 20
runs under an all-multibyte tail), bounded to one glyph, and pinned by a test.
Accepted over the ~4 KiB it replaces.

Related: [[pty-requirements]], [[lifecycle-bound-backend]],
[[frontend-terminal-quirks]], [[2026-07-25-pty-tail-rescue]]
