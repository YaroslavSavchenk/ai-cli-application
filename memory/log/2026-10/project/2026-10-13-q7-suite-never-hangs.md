---
type: log
created: 2026-10-13
updated: 2026-10-13
tags: [quality, q7, tests, ci]
---
# 2026-10-13 — Q7: the suite always returns

**Proof first (Node 24.14):** a test file that leaves a listening server or
a child process behind keeps `node --test` alive forever, whether its test
passed or failed. `--test-timeout` only cancels the test. The process stays.
`--test-force-exit` ends it, but the end of the file's report gets lost
silently: 4008 → 3959 reported tests on the real suite, and failures lost
in a synthetic run. Rejected for that reason
([[node-test-force-exit-loses-results]] class: a green count that lies).

**What landed:**
- `--import=./tests/helpers/exit-guard.ts` in `test`, `test:ui` and
  `test:server`. Inside each test file's process it adds a root `after`
  hook. That hook appends one more root hook, which arms an unref'd 60 s
  timer with the real `setTimeout` (captured at load, immune to fake
  clocks).
- A file still alive 60 s after its last hook prints
  `exit-guard: <file> still held <resources>` and exits 1. The results it
  already reported survive.
- `tests/repo/test-scripts.test.ts` pins the flags and runs five fixtures:
  leaky-fail, leaky-pass, a fake clock, a slow hook that must not be cut,
  and a clean file.
- The GitHub stub leaks are fixed with `t.after(() => ownStub.stop())` at
  8 sites.

**Relies on:** Node running hooks appended during the root after phase.
That is undocumented, and the fixture test fails if a Node update changes
it.

**Seen, not fixed:** five files sit 10–20 s on ref'd timers after their
last hook (discovery, lifecycle, restart-installed, runtime-file,
update-install-e2e). They are slow exits, not hangs. A speed candidate.
