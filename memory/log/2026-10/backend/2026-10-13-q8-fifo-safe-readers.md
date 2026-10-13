---
type: log
created: 2026-10-13
updated: 2026-10-13
tags: [quality, q8, backend, security, filesystem]
---
# 2026-10-13 — Q8: every data-dir reader opens its file the FIFO-safe way

The rule is [[fifo-open-blocks-main-thread]]. Seven readers were still on
a plain `readFileSync`, where a planted FIFO hangs the main thread and a
planted symlink is followed.

**What landed:**
- `readSmallRegularFile` in `server/config.ts`: `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`,
  fstat `isFile`, a size cap on fstat, a chunked read with a running cap
  (a file that grows is refused, never cut short). A refusal carries a
  fixed `reason`.
- Readers converted, with their caps:

  | File | Cap |
  |---|---|
  | prefs.json | 4 MiB |
  | projects.json | 16 MiB |
  | history.json | 32 MiB |
  | keys.json | 64 KiB |
  | github.json | 64 KiB |
  | update-check.json | 8 KiB |
  | runtime.json restart poll (`runtimeInfoReader` in `server/runtime-file.ts`, warns once per reason) | 16 KiB, shared with D2 and raised from 4096 for a deep `appDir` |

  `server/statusline.mjs` got its own silent `readRegularText` for
  prefs.json and statusline-cache.json, and a pin checks that its copied
  constants equal the server's.
- A refused file (not missing, not corrupt JSON) is never destroyed. The
  store moves it to `<file>.refused-<stamp>` (`setAsideRefused`) right
  before its first write, never at load, so a waiting standby moves
  nothing. A rename moves a link or FIFO itself, never its target.

**Gates:**
- Scope: 4 notes, all fixed. The main one was that history's
  rewrite-on-refusal would have lost entries over the cap.
- Security: clean, plus one note on the standby, fixed by moving the
  set-aside to the first write.
- Full mutation probe: 68 mutants, 52 killed at first. The 9 tests the
  test engineer added kill the 13 testable survivors; 3 survivors are
  equivalent. A `/proc` file (fstat size 0) now proves the running cap by
  behaviour, not only through the shape pin.

**Open:** no test of a FIFO with a writer attached, and none of a real
restart with a refused runtime.json. `.refused-*` files are never cleaned
up (at most one per store per boot).
