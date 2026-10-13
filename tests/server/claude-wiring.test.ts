/**
 * server/index-claude.ts `createClaudeWiring` — the production wiring of the
 * Claude Code version watch (Nocturne D6, `.claude/plans/nocturne/PLAN-D6.md`
 * § Test gate "Probe"): the probe runs in the SESSIONS' environment
 * (server/sessions-env.ts `ptyEnv`), and GET /api/tools' probe tells the
 * watch to check the binary again.
 *
 * How: in-process. This file's own process gets a PATH with a `claude` double
 * in a temp dir, plus `CLAUDECODE=1` — a variable `ptyEnv` strips (a parent
 * Claude Code's marker) and the double answers garbage to — then calls the
 * real `createClaudeWiring`. `node --test` runs each file in its own process,
 * so the env change touches no other file; it is restored in `after`.
 *
 * Why it matters: a probe in a different environment from the sessions' can
 * name a `claude` the sessions never launch; a `tools` that never pokes the
 * watch leaves an upgrade unseen until the app restarts.
 *
 * NOT claimed: the scheduled re-probe itself at the end of the one-minute
 * window (tests/server/claude-version.test.ts on a stepped clock); the boot
 * order (tests/server/claude-version-route.test.ts against a real child).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createClaudeWiring } from '../../server/index-claude.ts';
import { makeTempDir, removeTempDir, waitUntil } from '../helpers/helpers.ts';

/** Answers a version only when the parent Claude Code's marker was stripped. */
const DOUBLE = `#!/bin/sh
if [ -n "$CLAUDECODE" ]; then printf 'nested session refused\\n'; exit 0; fi
printf '2.1.280 (Claude Code)\\n'
`;

const saved = { PATH: process.env['PATH'], CLAUDECODE: process.env['CLAUDECODE'] };
let root: string;
let binDir: string;

/** Put back what this file changed in its own process.env. */
function restoreEnv(): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

before(async () => {
  root = await makeTempDir('ai-sm-claude-wiring-');
  binDir = join(root, 'bin');
  await mkdir(binDir);
  await writeFile(join(binDir, 'claude'), DOUBLE, { mode: 0o755 });
  process.env['PATH'] = `${binDir}:/usr/bin:/bin`;
  process.env['CLAUDECODE'] = '1';
});

after(async () => {
  restoreEnv();
  if (root !== undefined) await removeTempDir(root);
});

test('the watch probes in the sessions’ environment, and GET /api/tools pokes it when claude changed', async () => {
  const lines: string[] = [];
  const { claude, tools } = createClaudeWiring({
    log: (level, msg) => void lines.push(`${level} ${msg}`),
    installed: false,
  });
  try {
    await claude.start();
    assert.deepEqual(
      claude.status(),
      { version: '2.1.280', compat: 'ok', min: '2.1.263', testedUpTo: '2.1.287' },
      'CLAUDECODE is stripped from the probe, as from a session',
    );

    // An upgrade: new content, a new mtime (set, not left to the clock — see
    // `upgrade` in tests/server/claude-version.test.ts).
    const file = join(binDir, 'claude');
    await writeFile(file, DOUBLE.replace('2.1.280', '2.1.300'), { mode: 0o755 });
    await utimes(file, 1_700_000_000, 1_700_000_000);
    assert.equal((await tools()).claude, true);
    // Inside the one-minute window since start(): the watch schedules the
    // re-probe and says so; that line is the proof tools() reached it.
    await waitUntil(
      () => (lines.some((l) => l.includes('the claude on PATH changed; probing its version again in ')) ? true : undefined),
      'the tools probe to tell the watch',
    );
  } finally {
    claude.stop();
  }
});
