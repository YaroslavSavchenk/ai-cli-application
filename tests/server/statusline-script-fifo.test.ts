/**
 * `server/statusline.mjs` reads two more data-dir files every turn —
 * prefs.json (the toggles) and statusline-cache.json (the branch cache,
 * beside it) — and both go through the script's judged open
 * (`readRegularText`, Quality Q8, `.claude/plans/PLAN-QUALITY.md` § Q8; the
 * house rule in memory/knowledge/fifo-open-blocks-main-thread.md): a FIFO
 * there never hangs the turn, a symlink is never followed, an over-cap file is
 * never read.
 *
 * How: spawn the script the way Claude Code does, with a hard deadline
 * (`runWithDeadline`, tests/helpers/statusline-script-fixture.ts): a run that
 * has to be killed is a hang. Each refusal must look exactly like "no such
 * file": prefs → factory defaults (the line is OFF, so nothing is printed),
 * cache → a fresh git probe (`git:main`, never the planted branch).
 *
 * Why it matters: the script runs on every turn AND every 2 s; a FIFO at
 * either path hangs Claude Code's status line for the whole session.
 *
 * NOT claimed: the snapshot path (tests/server/statusline-script-snapshot.test.ts);
 * the server's own readers (tests/server/data-dir-readers.test.ts). The
 * script logs nothing by design (stderr reaches the status line), so no warn
 * line is asserted here — only that stderr stays empty.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runWithDeadline, fixture, makeWorkspace } from '../helpers/statusline-script-fixture.ts';

/** A turn that has not printed in this long hung; a normal one takes ~100 ms. */
const TURN_DEADLINE_MS = 6_000;

/** The line the workspace's prefs draw for `fixture(...)` in mode `default`. */
const LINE = 'Opus 5 | always ask | git:main | $0.42 | ctx 32%';

/** MAX_PREFS_FILE_BYTES / MAX_CACHE_FILE_BYTES in server/statusline.mjs. */
const PREFS_CAP = 4 * 1024 * 1024;
const CACHE_CAP = 1024 * 1024;

/** The prefs that switch Claude's own line on — what makeWorkspace writes. */
const LINE_ON = { statusLine: { enabled: true } };

test('prefs.json as a FIFO, a symlink or over the cap: the turn returns with factory defaults', async () => {
  const ws = await makeWorkspace();
  try {
    const real = join(ws.root, 'real-prefs.json');
    await writeFile(real, JSON.stringify(LINE_ON));
    const cases: Array<[string, () => Promise<void>]> = [
      ['a FIFO', async () => void execFileSync('mkfifo', [ws.prefs])],
      // A link to prefs that WOULD switch the line on: an empty line proves
      // the link was refused, not read.
      ['a symlink', () => symlink(real, ws.prefs)],
      // Valid JSON that switches the line on, one pad past the cap.
      ['over the cap', () => writeFile(ws.prefs, JSON.stringify({ ...LINE_ON, pad: 'x'.repeat(PREFS_CAP) }))],
    ];
    for (const [what, plant] of cases) {
      await rm(ws.prefs, { force: true });
      await plant();
      const res = await runWithDeadline(['default', ws.prefs], fixture(ws.repo, 'sess-prefs'), TURN_DEADLINE_MS);
      assert.equal(res.timedOut, false, `prefs.json ${what}: the script had to be killed`);
      assert.equal(res.code, 0, `prefs.json ${what}: exit 0`);
      assert.equal(res.err, '', `prefs.json ${what}: nothing on stderr`);
      assert.equal(res.out, '', `prefs.json ${what}: factory defaults (the line is off)`);
    }
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('statusline-cache.json as a FIFO, a symlink or over the cap: the branch comes from git, never the file', async () => {
  const ws = await makeWorkspace();
  try {
    const cache = join(ws.root, 'statusline-cache.json');
    // A FRESH entry for this very session and cwd naming a branch git never
    // would: if any of these files were read, the line would say git:planted.
    const entry = { at: Date.now(), branch: 'planted', cwd: ws.repo };
    const real = join(ws.root, 'real-cache.json');
    await writeFile(real, JSON.stringify({ 'sess-cache': entry }));
    const cases: Array<[string, () => Promise<void>]> = [
      ['a FIFO', async () => void execFileSync('mkfifo', [cache])],
      ['a symlink', () => symlink(real, cache)],
      ['over the cap', () => writeFile(cache, JSON.stringify({ 'sess-cache': entry, pad: 'x'.repeat(CACHE_CAP) }))],
    ];
    for (const [what, plant] of cases) {
      await rm(cache, { force: true });
      await plant();
      const res = await runWithDeadline(['default', ws.prefs], fixture(ws.repo, 'sess-cache'), TURN_DEADLINE_MS);
      assert.equal(res.timedOut, false, `cache ${what}: the script had to be killed`);
      assert.equal(res.code, 0, `cache ${what}: exit 0`);
      assert.equal(res.err, '', `cache ${what}: nothing on stderr`);
      assert.equal(res.out, LINE, `cache ${what}: the branch is git's own`);
    }
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});
