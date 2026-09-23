---
type: knowledge
created: 2026-09-17
updated: 2026-09-22
tags: [security, filesystem, node, telemetry, statusline]
---
# A named pipe in a watched directory hangs a synchronous open — O_NOFOLLOW is not enough

Found by the B1 test-engineer's mutation gate (2026-09-17), after the fix
round had already hardened both snapshot readers with `O_NOFOLLOW` +
`fstat().isFile()` + an 8 KiB cap.

**The trap.** `openSync(path, O_RDONLY)` on a FIFO blocks until some process
opens the write end. `O_NOFOLLOW` only refuses symlinks, and the `isFile()`
check runs AFTER the open, so it never gets its turn. In `server/telemetry.ts`
that open ran on the backend's main thread the moment `fs.watch` fired: the
whole server (HTTP, every WebSocket, every session) stopped answering until
SIGKILL. In `server/statusline.mjs` the same open hung Claude Code's status
line child on every 2 s tick. The fix-round note "a planted FIFO symlink hung
the script" had closed only the symlink half of the problem — the test that
proved it used a symlink TO a FIFO, and `O_NOFOLLOW` made that one pass.

**The fix.** Open with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`: a FIFO then
opens immediately (no writer needed), `fstat().isFile()` refuses it, and a
regular file reads exactly as before. Two lines, both sites, pinned by
`tests/server/telemetry.test.ts` ("a FIFO named like a snapshot never blocks the
watcher") and `tests/server/statusline-script.test.ts` ("a FIFO planted at the
snapshot path never hangs the turn").

**The rule.** Any synchronous read of a path another process can create
(the data dir — [[wsl-0600-not-a-boundary]]) needs all three: `O_NOFOLLOW`,
`O_NONBLOCK`, then `fstat().isFile()` before the first `read`. A test that
plants a symlink proves nothing about a FIFO; plant the FIFO itself
(`mkfifo`) and run the reader under a timeout.

**Third time (2026-09-22, B6 phase 3).** A new data-dir reader
(`server/last-port.ts`, the remembered port) shipped with a plain
`readFileSync` and the security review measured the same hang again: a
`mkfifo` at `last-port.json` blocked the boot BEFORE `listen`, so the
launcher saw no `runtime.json` and no `/health`; a symlink to `/dev/zero`
read without end (the byte cap ran only after the read). The rule above
holds for every reader in the data dir, not only the watched ones — a brief
for a new data-dir file must name it. The older readers (`prefs.json`,
`projects.json`, `history.json`, `keys.json`, `update-check.json`) still use
`readFileSync` and sit in the BACKLOG.
