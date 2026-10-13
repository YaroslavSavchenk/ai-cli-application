/**
 * Exit guard for test-file processes — PLAN-QUALITY Q7 (backlog 2026-09-08:
 * "Suite can hang forever"). Loaded by the `test`, `test:ui` and
 * `test:server` scripts with `--import ./tests/helpers/exit-guard.ts`;
 * `tests/repo/test-scripts.test.ts` pins that and proves the behaviour.
 *
 * The problem: `node --test` runs each file in its own process and waits for
 * that process to exit. A test that fails (or times out) before its clean-up
 * leaves a listening server or an attached child behind, the file's event
 * loop never drains, and the runner never returns. `--test-timeout` does not
 * help — it cancels the TEST, not the process (measured on Node 24.14: a file
 * whose test timed out at 5 s still ran until killed at 60 s).
 *
 * Why not `--test-force-exit`: on Node 24.14 it ends the file's process
 * before the file's report has reached the runner. The suite then reports
 * FEWER tests than it ran, silently and differently every run (measured:
 * 4008 → 3959 tests on this suite; 2400 → 1846–2173 on 40 synthetic files,
 * failures among the lost ones).
 *
 * What this does instead: once the file's tests and all its own root-level
 * `after` hooks are done, it arms an unref'd timer. A file that leaks nothing
 * exits by itself and the timer never fires — no delay, no change. A file
 * that still holds something after the grace is ended with exit code 1 and a
 * stderr line naming what it held, so the runner reports that file red
 * instead of hanging.
 *
 * The grace is long on purpose: it bounds a HANG, it does not police slow
 * clean-up. Measured 2026-10-13, five files (discovery, lifecycle,
 * restart-installed, runtime-file, update-install-e2e) stay alive 10–14 s
 * after their last hook on ref'd timers and then exit by themselves; a
 * 5 s grace failed them, 60 s leaves them alone.
 *
 * How it gets behind the file's own hooks: the root `after` hook registered
 * here runs first (it is registered before the file loads) and appends the
 * arming hook to the root through its context; node:test reads the root's
 * hook list live, so the appended hook runs after every hook the file
 * registered. Proven, not documented — the repo test fails if a Node update
 * changes it.
 *
 * In the runner's own process (no NODE_TEST_CONTEXT) this does nothing.
 *
 * NOT claimed: a child process the file spawned and never killed is NOT
 * killed here — the file's process ends, the orphan lives on. Each test still
 * stops what it starts (`tests/README.md` § Isolation and clean-up).
 */
import { after, type TestContext } from 'node:test';

/**
 * How long a file may hold resources after its last hook: 60 s, well past the
 * 14 s the slowest drain measured. TEST_EXIT_GUARD_GRACE_MS overrides it — for
 * tests/repo/test-scripts.test.ts, which proves the guard without waiting a
 * minute.
 */
const GRACE_MS = Number(process.env['TEST_EXIT_GUARD_GRACE_MS'] ?? 60_000);

/**
 * The real timer, taken before any test loads: a test that swaps
 * globalThis.setTimeout (a fake clock) must not take the guard with it —
 * measured: one did, and the guard threw "setTimeout(...).unref is not a
 * function".
 */
const nativeSetTimeout = globalThis.setTimeout;

function armExitTimer(): void {
  nativeSetTimeout(() => {
    // Everything that keeps the loop alive. This timer is unref'd, so it is
    // not among them; two PipeWraps are the file process's own stdout/stderr
    // to the runner; a 'Timeout' is a ref'd timer of the file's.
    const held = process.getActiveResourcesInfo();
    process.stderr.write(
      `exit-guard: ${process.argv[1] ?? 'this test file'} still held ${held.join(', ')} ` +
        `${GRACE_MS} ms after its tests and hooks finished — ended with exit code 1 ` +
        '(a server, socket, child or timer was left open; stop it in finally/after)\n',
    );
    process.exit(1);
  }, GRACE_MS).unref();
}

if (process.env['NODE_TEST_CONTEXT'] !== undefined) {
  after((ctx) => {
    // The root hook's context is the root TEST's (a TestContext); the type
    // also admits a SuiteContext, which has no `after` — then the guard is off
    // and the repo test says so.
    if ('after' in ctx) (ctx as TestContext).after(armExitTimer);
  });
}
