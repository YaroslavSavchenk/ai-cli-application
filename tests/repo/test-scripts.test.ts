/**
 * The test scripts in `package.json` (`test`, `test:ui`, `test:server`) carry
 * what keeps `npm test` from hanging — PLAN-QUALITY Q7 (backlog 2026-09-08:
 * "Suite can hang forever"): the per-test `--test-timeout=120000` and the
 * exit guard `--import=./tests/helpers/exit-guard.ts` (that file's header
 * has the why, and why not `--test-force-exit`).
 *
 * How: read `package.json` for the flags; then run the `test` script's own
 * flags (from the repo root, as npm does) against throwaway test files
 * written to a temp dir — one that fails with an http server still
 * listening, one that PASSES with it still listening (one of those with
 * setTimeout swapped for a fake), one whose own `after`
 * hook takes longer than the guard's grace and then cleans up, and one that
 * leaks nothing — and assert each file's verdict.
 *
 * Why it matters: without the guard a leaky file never exits and the runner
 * never returns — on CI a stalled job until the workflow's own limit; a
 * guard that fired too early would cut a file's legitimate clean-up.
 *
 * NOT claimed: that no test leaks on its failure path (the guard ends the
 * file's process; a child it orphaned lives on — that is each test's own
 * `finally`/`after`). CI calls `npm test` (`.github/workflows/verify.yml`),
 * so it inherits the flags without a workflow change. `node --test <file>`
 * run by hand has no guard.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir, projectRoot, readSource, removeTempDir, waitUntil } from '../helpers/helpers.ts';

const SCRIPTS = ['test', 'test:ui', 'test:server'] as const;
const REQUIRED_FLAGS = ['--test-timeout=120000', '--import=./tests/helpers/exit-guard.ts'];

/**
 * The guard's grace for the inner run (its default is 60 s — a minute per run
 * of this test would be the suite's slowest file). The slow-hook fixture's own
 * clean-up takes longer than that grace, so a guard armed BEFORE the file's
 * hooks would cut it.
 */
const GRACE_MS = 2_000;
const SLOW_HOOK_MS = 3_000;
/** The inner runner returns after ~grace + slow hook; generous for a slow CI box. */
const RUNNER_RETURN_MS = 60_000;

const scripts = (JSON.parse(readSource('package.json')) as { scripts: Record<string, string> }).scripts;

/** The `--…` options of a script's `node --test` invocation, in order. */
function runnerFlags(script: string): string[] {
  const words = script.split(/\s+/);
  assert.deepEqual(words.slice(0, 2), ['node', '--test'], `script must start with "node --test": ${script}`);
  return words.slice(2).filter((w) => w.startsWith('--'));
}

const LISTEN = [
  "import { test, after } from 'node:test';",
  "import assert from 'node:assert/strict';",
  "import { createServer } from 'node:http';",
  'const server = createServer((_req, res) => res.end());',
  "const listening = () => new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));",
];

const FIXTURES: Record<string, string[]> = {
  'leaky-fail': [
    ...LISTEN,
    "test('leaky-fail: fails while its server still listens', async () => {",
    '  await listening();',
    '  assert.equal(1, 2);',
    '  server.close();',
    '});',
  ],
  'leaky-pass': [
    ...LISTEN,
    "test('leaky-pass: passes and never closes its server', async () => {",
    '  await listening();',
    '});',
  ],
  // A fake clock that is never put back must not disarm the guard.
  'leaky-fake-clock': [
    ...LISTEN,
    "test('leaky-fake-clock: swaps setTimeout for a fake and never closes its server', async () => {",
    '  await listening();',
    '  (globalThis as { setTimeout: unknown }).setTimeout = () => 0;',
    '});',
  ],
  'slow-hook': [
    ...LISTEN,
    "test('slow-hook: passes; its after hook closes the server late', async () => {",
    '  await listening();',
    '});',
    'after(async () => {',
    `  await new Promise((resolve) => setTimeout(resolve, ${SLOW_HOOK_MS}));`,
    '  await new Promise<void>((resolve) => server.close(() => resolve()));',
    '});',
  ],
  clean: [
    ...LISTEN,
    "test('clean: passes and closes its server', async () => {",
    '  await listening();',
    '  await new Promise<void>((resolve) => server.close(() => resolve()));',
    '});',
  ],
};

test('every test script passes --test-timeout=120000 and the exit guard to node --test', () => {
  for (const name of SCRIPTS) {
    const script = scripts[name];
    assert.ok(script !== undefined, `package.json has no "${name}" script`);
    const flags = runnerFlags(script);
    for (const flag of REQUIRED_FLAGS) {
      assert.ok(flags.includes(flag), `"${name}" lacks ${flag}: ${script}`);
    }
    // Ends a file's process before its report is in: tests vanish from the count.
    assert.ok(!flags.includes('--test-force-exit'), `"${name}" must not use --test-force-exit: ${script}`);
  }
});

test("the test script's flags end a leaky file red, and leave a slow clean-up and a clean file alone", async () => {
  const dir = await makeTempDir('ai-sm-q7-guard-');
  const files = Object.keys(FIXTURES).map((name) => join(dir, `${name}.test.ts`));
  for (const [name, lines] of Object.entries(FIXTURES)) {
    await writeFile(join(dir, `${name}.test.ts`), lines.join('\n') + '\n');
  }
  // NODE_TEST_CONTEXT is set by the outer runner for its file processes; left
  // in, the inner runner would report to it instead of running as a CLI.
  const env = { ...process.env };
  delete env['NODE_TEST_CONTEXT'];
  env['TEST_EXIT_GUARD_GRACE_MS'] = String(GRACE_MS);
  // Own process group, so a runner that DOES hang (the regression) is killed
  // with its file processes by PID, never left behind.
  const runner = spawn(process.execPath, ['--test', ...runnerFlags(scripts['test'] ?? ''), ...files], {
    cwd: projectRoot,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  runner.stdout.on('data', (c: Buffer) => (output += c.toString()));
  runner.stderr.on('data', (c: Buffer) => (output += c.toString()));
  let exitCode: number | null | undefined;
  runner.on('exit', (code) => (exitCode = code));
  try {
    await waitUntil(
      () => (exitCode === undefined ? undefined : true),
      'node --test to return on the leaky fixture files',
      RUNNER_RETURN_MS,
    );
    assert.equal(exitCode, 1, `a leaky file makes the run red:\n${output}`);
    const guardLines = output.split('\n').filter((l) => l.startsWith('exit-guard: '));
    for (const leaky of ['leaky-fail', 'leaky-pass', 'leaky-fake-clock']) {
      assert.ok(
        guardLines.some((l) => l.includes(`${leaky}.test.ts`) && l.includes('TCPServerWrap')),
        `${leaky} is ended by the guard, which names the listening server:\n${output}`,
      );
    }
    for (const quiet of ['slow-hook', 'clean']) {
      assert.ok(
        !guardLines.some((l) => l.includes(`${quiet}.test.ts`)),
        `${quiet} is never cut by the guard:\n${output}`,
      );
    }
    assert.match(output, /✔ slow-hook: passes; its after hook closes the server late/, `slow-hook passes:\n${output}`);
    assert.match(output, /✔ clean: passes and closes its server/, `clean passes:\n${output}`);
    assert.match(output, /✖ leaky-fail: fails while its server still listens/, `the failing test is reported:\n${output}`);
    assert.match(output, /✔ leaky-pass: passes and never closes its server/, `its test still passes:\n${output}`);
  } finally {
    if (exitCode === undefined && runner.pid !== undefined) process.kill(-runner.pid, 'SIGKILL');
    await removeTempDir(dir);
  }
});
