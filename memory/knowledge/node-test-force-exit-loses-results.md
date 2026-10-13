---
type: knowledge
created: 2026-10-13
updated: 2026-10-13
tags: [tests, node, ci]
---
# `node --test`: a leftover handle hangs the run, and `--test-force-exit` drops results

Measured on Node 24.14 (Q7, 2026-10-13).

- A test file that leaves a listening server or a child process behind
  keeps its process, and so the whole `node --test` run, alive forever.
  That holds whether its tests passed or failed.
- `--test-timeout` does not help. It cancels the TEST; the handles stay.
- `--test-force-exit` ends each file's process when its tests finish, but
  before the end of that file's report reaches the runner. The real suite
  reported 3959 of its 4008 tests, and a synthetic run lost failures too.
  The exit code stayed 1 in the runs seen, but the counts lie.

What this repo does instead: `tests/helpers/exit-guard.ts`, loaded with
`--import` by every `npm test*` script. It ends a file 60 s after its
last root hook, by which time its report is out. It names the resources
still held. Pinned by `tests/repo/test-scripts.test.ts`, including the
undocumented Node behaviour it relies on: hooks appended during the root
after phase still run.

A test that starts a server or child stops it in `t.after(...)` right
after the start, not in a `finally` that a throwing setup step skips.
