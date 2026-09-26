/**
 * server/agents-workflows.ts — Nocturne C2 (.claude/plans/nocturne/PLAN-C2.md
 * § The rule 3 and § Amendments): the boundary of the workflow liveness scan,
 * checkWorkflows. A run id is joined into a path only when it has the
 * measured shape (checked HERE, not only by the fold that found it); the run
 * directory's realpath must equal the joined path exactly (a symlink is
 * refused, wherever it points); only a name of the `agent-<hex>.jsonl` shape
 * counts; a live run beats a refused one; the mtime edge is exclusive; a
 * run path that is a file, a FIFO or missing is quiet and never throws;
 * every directory opened is closed again; and one call examines at most
 * MAX_WORKFLOW_SCAN directory entries, across the runs and inside one.
 *
 * How: checkWorkflows called in-process on real temp trees — the cheapest
 * seam that proves a boundary on the real file system. Every hostile id names
 * a directory that DOES hold a fresh `agent-<hex>.jsonl`, so a check that let
 * the id through would answer 'alive', not 'quiet'. The close accounting
 * spies on Dir#closeSync, and a listing that fails part-way is a mocked
 * Dir#readSync throwing EIO — a failure this machine cannot produce on demand
 * (tests/README.md § Mocks); both restored in finally. The scan cap: the
 * budget spans the runs, which are checked in the order given, so where it
 * runs out is staged by filling the first run; inside ONE run the listing
 * order is the filesystem's, so there the reads are counted (a spy on
 * Dir#readSync, restored in finally).
 *
 * Why it matters: the run id comes out of an untrusted transcript line, and
 * the answer this scan gives is broadcast as the session's turn. A path that
 * escapes the subagents directory makes the watcher an oracle on someone
 * else's tree (B7's rule); a handle left open per poll leaks one fd every 2 s
 * for as long as a dead workflow launch stays in the fold.
 *
 * NOT claimed here: the watcher calling this with the subagents directory it
 * realpath'd on the same poll, the refusal logged once, and the verdict it
 * feeds
 * (tests/server/agents-launch-watcher.test.ts, agents-launch-edges.test.ts);
 * the race of a symlink swapped in between the realpath and opendir (the
 * residual the module header accepts).
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Dir, lstatSync, realpathSync } from 'node:fs';
import { mkdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { checkWorkflows } from '../../server/agents-workflows.ts';
import { makeTempDir, removeTempDir } from '../helpers/helpers.ts';
import { NOW_S } from '../helpers/agents-fixture.ts';

/** The measured run-id shape (`wf_998cfcac-d41`), and two more of it. */
const RUN = 'wf_998cfcac-d41';
const LIVE = 'wf_aaaaaaaa-aaa';
const QUIET = 'wf_bbbbbbbb-bbb';

/** A fresh `agent-ab.jsonl` in `dir`, created with its parents. Returns the file. */
async function freshAgent(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'agent-ab.jsonl');
  await writeFile(file, 'x');
  return file;
}

/** A `sinceMs` a minute back: a file written by this test is after it. */
function aMinuteAgo(): number {
  return Date.now() - 60_000;
}

test('C2 workflows: a run id not of the measured shape is never joined into a path — even where that path holds a fresh agent transcript', async () => {
  const sub = realpathSync(await makeTempDir('ai-sm-wfid-'));
  try {
    const wf = join(sub, 'workflows');
    await freshAgent(sub); // '..'
    await freshAgent(wf); // '', '.', `${RUN}/..`
    await freshAgent(join(sub, 'elsewhere')); // '../elsewhere', `${RUN}/../../elsewhere`
    await freshAgent(join(wf, 'x', RUN)); // `x/${RUN}`: the shape at the END of the string only
    await freshAgent(join(wf, RUN)); // the control, and `x/../${RUN}` normalised onto it
    // Near misses of the shape: `wf_` + 8 lowercase hex + 1-4 groups of `-` and 1-12 lowercase hex.
    const nearMisses = [
      'wf_998CFCAC-d41',
      'WF_998cfcac-d41',
      'wf-998cfcac-d41',
      'wf_998cfca-d41',
      'wf_998cfcac0-d41',
      'wf_zzzzzzzz-d41',
      'wf_998cfcac',
      'wf_998cfcac-',
      'wf_998cfcac_d41',
      `wf_998cfcac-${'d'.repeat(13)}`,
      `wf_998cfcac${'-d41'.repeat(5)}`,
    ];
    for (const id of nearMisses) await freshAgent(join(wf, id));
    const since = aMinuteAgo();
    assert.equal(checkWorkflows(sub, [RUN], since), 'alive', 'the control: the well-shaped id is read');
    const hostile = ['', '.', '..', '../elsewhere', `${RUN}/..`, `${RUN}/../../elsewhere`, `x/${RUN}`, `x/../${RUN}`, ...nearMisses];
    for (const id of hostile) {
      assert.equal(checkWorkflows(sub, [id], since), 'quiet', `run id ${JSON.stringify(id)}`);
    }
    assert.equal(checkWorkflows(sub, hostile, since), 'quiet', 'all of them in one call');
  } finally {
    await removeTempDir(sub);
  }
});

test('C2 workflows: a fresh file whose name is not `agent-<hex>.jsonl` says nothing — `agent-undefined.jsonl` and near misses included', async () => {
  const sub = realpathSync(await makeTempDir('ai-sm-wfname-'));
  try {
    const run = join(sub, 'workflows', RUN);
    await mkdir(run, { recursive: true });
    // `agent-undefined.jsonl`: what a lookup of a name that did NOT match would be called.
    const names = [
      'agent-undefined.jsonl',
      'agent-ZZ.jsonl',
      'agent-.jsonl',
      `agent-${'a'.repeat(33)}.jsonl`,
      'agent-ab.jsonl.bak',
      'agent-ab.meta.json',
      'notes.jsonl',
    ];
    for (const name of names) await writeFile(join(run, name), 'x');
    assert.equal(checkWorkflows(sub, [RUN], aMinuteAgo()), 'quiet', `none of ${names.join(', ')}`);
    await writeFile(join(run, 'agent-ab.jsonl'), 'x');
    assert.equal(checkWorkflows(sub, [RUN], aMinuteAgo()), 'alive', 'the control: a well-named one');
  } finally {
    await removeTempDir(sub);
  }
});

test('C2 workflows: a run reached through a symlink is refused even when it points INSIDE the subagents directory', async () => {
  const base = realpathSync(await makeTempDir('ai-sm-wflink-'));
  try {
    // At the run's own name: a link to a real, fresh run elsewhere under <sub>.
    const sub = join(base, 'a', 'subagents');
    await freshAgent(join(sub, 'inside', RUN));
    await mkdir(join(sub, 'workflows'), { recursive: true });
    await symlink(join(sub, 'inside', RUN), join(sub, 'workflows', RUN));
    assert.equal(checkWorkflows(sub, [RUN], aMinuteAgo()), 'refused', 'a symlink at the run id');

    // At `workflows`: a link to a real directory under <sub> holding the run.
    const sub2 = join(base, 'b', 'subagents');
    await freshAgent(join(sub2, 'real-workflows', RUN));
    await symlink(join(sub2, 'real-workflows'), join(sub2, 'workflows'));
    assert.equal(checkWorkflows(sub2, [RUN], aMinuteAgo()), 'refused', 'a symlink at workflows/');

    // At the base: a caller that handed in an un-realpath'd directory is refused, not followed.
    const sub3 = join(base, 'c', 'subagents');
    await freshAgent(join(sub3, 'workflows', RUN));
    await symlink(sub3, join(base, 'link-to-c'));
    assert.equal(checkWorkflows(join(base, 'link-to-c'), [RUN], aMinuteAgo()), 'refused', 'a symlinked subagents directory');
    assert.equal(checkWorkflows(sub3, [RUN], aMinuteAgo()), 'alive', 'the same run through its real path');
  } finally {
    await removeTempDir(base);
  }
});

test('C2 workflows: a live run wins over a refused one in either order; refused wins over quiet', async () => {
  const sub = realpathSync(await makeTempDir('ai-sm-wfmix-'));
  try {
    const wf = join(sub, 'workflows');
    await freshAgent(join(sub, 'inside', RUN));
    await mkdir(wf, { recursive: true });
    await symlink(join(sub, 'inside', RUN), join(wf, RUN));
    await freshAgent(join(wf, LIVE));
    await mkdir(join(wf, QUIET));
    const since = aMinuteAgo();
    assert.equal(checkWorkflows(sub, [RUN, LIVE], since), 'alive', 'refused first, live after');
    assert.equal(checkWorkflows(sub, [LIVE, RUN], since), 'alive', 'live first, refused after');
    assert.equal(checkWorkflows(sub, [RUN, QUIET], since), 'refused', 'refused first, quiet after');
    assert.equal(checkWorkflows(sub, [QUIET, RUN], since), 'refused', 'quiet first, refused after');
    assert.equal(checkWorkflows(sub, [QUIET], since), 'quiet', 'an empty run');
    assert.equal(checkWorkflows(sub, [], since), 'quiet', 'no runs at all');
  } finally {
    await removeTempDir(sub);
  }
});

test('C2 workflows: the mtime edge is exclusive — a transcript written exactly at sinceMs is no sign of life', async () => {
  const sub = realpathSync(await makeTempDir('ai-sm-wfedge-'));
  try {
    const file = await freshAgent(join(sub, 'workflows', RUN));
    // Whole seconds: utimes stores them exactly, so the edge is a known number.
    await utimes(file, NOW_S - 10, NOW_S - 10);
    const mtime = lstatSync(file).mtimeMs;
    assert.equal(checkWorkflows(sub, [RUN], mtime), 'quiet', 'written AT sinceMs: not after it');
    assert.equal(checkWorkflows(sub, [RUN], mtime - 1), 'alive', 'one ms later than sinceMs');
  } finally {
    await removeTempDir(sub);
  }
});

test('C2 workflows: a run path that is a file, a FIFO or missing — or no subagents directory at all — is quiet and never throws', async () => {
  const sub = realpathSync(await makeTempDir('ai-sm-wfkind-'));
  try {
    const wf = join(sub, 'workflows');
    await mkdir(wf, { recursive: true });
    await writeFile(join(wf, RUN), 'x');
    execFileSync('mkfifo', [join(wf, LIVE)]);
    // A FIFO wearing an agent transcript's name: opening it would block this
    // test forever, so a pass also proves it was never opened.
    const run = join(wf, QUIET);
    await mkdir(run);
    execFileSync('mkfifo', [join(run, 'agent-ab.jsonl')]);
    const since = aMinuteAgo();
    for (const [dir, id, what] of [
      [sub, RUN, 'a regular file'],
      [sub, LIVE, 'a FIFO'],
      [sub, 'wf_cccccccc-ccc', 'nothing there'],
      [sub, QUIET, 'a FIFO named agent-ab.jsonl'],
      [join(sub, 'gone'), RUN, 'no subagents directory'],
    ] as const) {
      let got: string | undefined;
      assert.doesNotThrow(() => {
        got = checkWorkflows(dir, [id], since);
      }, what);
      assert.equal(got, 'quiet', what);
    }
  } finally {
    await removeTempDir(sub);
  }
});

test('C2 workflows: every run directory opened is closed again — alive, quiet, and a listing that fails part-way', async () => {
  const sub = realpathSync(await makeTempDir('ai-sm-wfclose-'));
  const closes = mock.method(Dir.prototype, 'closeSync');
  try {
    const wf = join(sub, 'workflows');
    await freshAgent(join(wf, LIVE));
    const stale = await freshAgent(join(wf, QUIET));
    await utimes(stale, NOW_S - 3_600, NOW_S - 3_600);
    await freshAgent(join(wf, RUN));
    const closed = (runId: string): number =>
      closes.mock.calls.filter((c) => (c.this as Dir).path === join(wf, runId)).length;
    const since = aMinuteAgo();

    assert.equal(checkWorkflows(sub, [LIVE], since), 'alive');
    assert.equal(closed(LIVE), 1, 'closed after the early "alive" return');
    assert.equal(checkWorkflows(sub, [QUIET], since), 'quiet');
    assert.equal(closed(QUIET), 1, 'closed after a full, quiet listing');

    const eio = mock.method(Dir.prototype, 'readSync', () => {
      throw Object.assign(new Error('EIO: i/o error, readdir'), { code: 'EIO' });
    });
    try {
      assert.equal(checkWorkflows(sub, [RUN], since), 'quiet', 'a failed listing is no sign of life');
    } finally {
      eio.mock.restore();
    }
    assert.equal(closed(RUN), 1, 'closed after the listing threw');
  } finally {
    closes.mock.restore();
    await removeTempDir(sub);
  }
});

/** MAX_WORKFLOW_SCAN in server/agents-workflows.ts (not exported; kept in step here). */
const MAX_WORKFLOW_SCAN = 1024;

/** `count` empty files that are no agent transcript, in `dir`, numbered from `from`. */
async function junk(dir: string, count: number, from = 0): Promise<void> {
  for (let i = from; i < from + count; i++) await writeFile(join(dir, `junk-${i}`), '');
}

test('C2 workflows: the scan cap spans the runs — 1023 names in the first run leave one for the next, 1024 leave none', async () => {
  const sub = realpathSync(await makeTempDir('ai-sm-wfcap-'));
  try {
    const a = join(sub, 'workflows', 'wf_aaaaaaaa-aaa');
    const b = join(sub, 'workflows', 'wf_bbbbbbbb-bbb');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    await writeFile(join(b, 'agent-ab.jsonl'), 'x');
    // Run C is run B's directory reached through a symlink: refused, when it is looked at at all.
    await symlink(b, join(sub, 'workflows', 'wf_cccccccc-ccc'));
    const since = Date.now() - 60_000;
    await junk(a, MAX_WORKFLOW_SCAN - 1);
    assert.equal(checkWorkflows(sub, ['wf_aaaaaaaa-aaa', 'wf_bbbbbbbb-bbb'], since), 'alive', 'one entry left: run B is read');
    assert.equal(checkWorkflows(sub, ['wf_aaaaaaaa-aaa', 'wf_cccccccc-ccc'], since), 'refused', 'one entry left: run C is looked at');
    await junk(a, 1, MAX_WORKFLOW_SCAN - 1);
    assert.equal(checkWorkflows(sub, ['wf_aaaaaaaa-aaa', 'wf_bbbbbbbb-bbb'], since), 'quiet', 'the budget is spent: run B is not read');
    // Not even looked at: a run past the spent budget cannot report a refusal either.
    assert.equal(checkWorkflows(sub, ['wf_aaaaaaaa-aaa', 'wf_cccccccc-ccc'], since), 'quiet', 'the budget is spent: run C is skipped');
  } finally {
    await removeTempDir(sub);
  }
});

test('C2 workflows: ONE run with more names than the cap is read no further than the cap', async () => {
  // Inside one directory the listing order is the filesystem's, so WHICH
  // entry falls past the cap cannot be staged; how many are read can. A spy
  // on Dir#readSync (restored in finally) is the only way to see that work —
  // the result alone cannot tell a capped scan from a full one here.
  const sub = realpathSync(await makeTempDir('ai-sm-wfcap-one-'));
  const run = join(sub, 'workflows', 'wf_dddddddd-ddd');
  const reads = mock.method(Dir.prototype, 'readSync');
  try {
    await mkdir(run, { recursive: true });
    await junk(run, MAX_WORKFLOW_SCAN + 76);
    assert.equal(checkWorkflows(sub, ['wf_dddddddd-ddd'], Date.now() - 60_000), 'quiet');
    const calls = reads.mock.calls.filter((c) => (c.this as Dir).path === run).length;
    // The cap's entries, plus the one read after which the loop sees the budget spent.
    assert.equal(calls, MAX_WORKFLOW_SCAN + 1, `read ${calls} entries of ${MAX_WORKFLOW_SCAN + 76}`);
  } finally {
    reads.mock.restore();
    await removeTempDir(sub);
  }
});
