/**
 * `server/statusline.mjs` — the SNAPSHOT (Nocturne B1): the optional fourth
 * argument. Same script, same stdin, one extra argv word — the absolute path the
 * server composed for this session. What it writes there is what the app's own
 * pane status bar draws, so it obeys the same honesty rule as the line, and it
 * is written whether or not Claude's line is enabled.
 *
 * How: spawn `node statusline.mjs <mode> <prefs.json> <snapshot>` the way the
 * server's launch does, pipe a payload, read the line and the file (runners and
 * payloads: `tests/helpers/statusline-script-fixture.ts`).
 *
 * Why the path is also attacked here: it names a file in an ordinary 0700
 * directory that the script re-reads every turn, so anything running as this
 * user (and, on WSL, Windows) can plant a FIFO or a symlink there first —
 * neither the read nor the write may hang or be redirected.
 *
 * NOT claimed here: the line itself and the branch cache —
 * `tests/server/statusline-script.test.ts`; the pane bar rendering the snapshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { lstat, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sleep } from '../helpers/helpers.ts';
import { SCRIPT, runStatusline, runRaw, fixture, makeWorkspace } from '../helpers/statusline-script-fixture.ts';

/**
 * A clock-separation wait (tests/README.md § Time): a rewrite of the snapshot
 * would carry a LATER mtime than the first run's, so "mtime unchanged" means
 * "not rewritten" only once the clock has moved. 20 ms is well past the
 * file system's timestamp granularity here (ns on ext4).
 */
const MTIME_TICK_MS = 20;

// ---------------------------------------------------------------------------
// The SNAPSHOT (Nocturne B1): the optional fourth argument
//
// Same script, same stdin, one extra argv word — the absolute path the server
// composed for this session. What it writes there is what the app's own pane
// status bar draws, so it obeys the same honesty rule as the line, and it is
// written whether or not Claude's line is enabled.
// ---------------------------------------------------------------------------

/** Run the script the way B1's server does: mode, prefs, snapshot file. */
function runWithSnapshot(
  mode: string,
  prefsFile: string,
  snapshotFile: string,
  payload: unknown,
): Promise<{ out: string; err: string; code: number | null }> {
  return runRaw([mode, prefsFile, snapshotFile], payload);
}

/** Read a snapshot back as a plain object. */
async function readSnapshot(file: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

test('snapshot: a full payload records every field, 0600, beside an unchanged line', async () => {
  const ws = await makeWorkspace();
  const snapshot = join(ws.root, 'sess-snap.json');
  try {
    await writeFile(
      ws.prefs,
      JSON.stringify({
        statusLine: { enabled: true, model: true, mode: true, branch: true, cost: true, lines: true, context: true, usage: true },
      }),
    );
    const res = await runWithSnapshot('plan', ws.prefs, snapshot, fixture(ws.repo, 'sess-snap'));
    assert.equal(res.code, 0);
    assert.equal(res.err, '');
    // The printed line is untouched by the new argument.
    assert.equal(res.out, 'Opus 5 | plan | git:main | $0.42 | +120 -14 | ctx 32% | 5h 45% 7d 12%');

    const written = await readSnapshot(snapshot);
    const at = written['at'] as number;
    assert.equal(typeof at, 'number');
    assert.ok(Math.abs(Date.now() - at) < 60_000, 'at is a ms epoch from just now');
    delete written['at'];
    assert.deepEqual(written, {
      v: 1,
      model: 'Opus 5',
      branch: 'main',
      cost: 0.4231,
      linesAdded: 120,
      linesRemoved: 14,
      context: 32,
      usage5h: 45,
      usage7d: 12,
      // B7: the payload's transcript_path, verbatim — the only handle the
      // backend has on this session's subagents directory.
      transcript: '/home/u/.claude/projects/p/sess-1.jsonl',
    });
    assert.equal((await stat(snapshot)).mode & 0o777, 0o600, 'user-only, like every file this script writes');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('snapshot honesty: zero cost, null context, absent rate limits and zero lines leave NO key', async () => {
  const ws = await makeWorkspace();
  const snapshot = join(ws.root, 'sess-empty.json');
  try {
    const payload = fixture(ws.repo, 'sess-empty');
    payload.cost = { total_cost_usd: 0, total_lines_added: 0, total_lines_removed: 0 };
    payload.context_window = { used_percentage: null };
    delete payload['rate_limits'];
    const res = await runWithSnapshot('default', ws.prefs, snapshot, payload);
    assert.equal(res.code, 0);
    const written = await readSnapshot(snapshot);
    delete written['at'];
    // A zero is a real number and still says nothing: no key, never a 0.
    // `transcript` is not a drawable value and is not subject to that rule:
    // the payload carried it, so it is there.
    assert.deepEqual(written, {
      v: 1,
      model: 'Opus 5',
      branch: 'main',
      transcript: '/home/u/.claude/projects/p/sess-1.jsonl',
    });
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('snapshot: transcript_path is carried VERBATIM — a path is not clean()ed', async () => {
  const ws = await makeWorkspace();
  const snapshot = join(ws.root, 'sess-tp.json');
  try {
    const payload = fixture(ws.repo, 'sess-tp');
    // Spaces are legal in a path and clean() would collapse them, which would
    // hand the backend a path to a DIFFERENT file (or to nothing at all).
    payload['transcript_path'] = '/home/u/.claude/projects/my  project/0ed9d6f2-1d4f-4a4a-9d9e-6f3b2d4c5e6a.jsonl';
    await runWithSnapshot('default', ws.prefs, snapshot, payload);
    const written = await readSnapshot(snapshot);
    assert.equal(
      written['transcript'],
      '/home/u/.claude/projects/my  project/0ed9d6f2-1d4f-4a4a-9d9e-6f3b2d4c5e6a.jsonl',
    );
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('snapshot: a transcript_path that is not a usable string leaves NO key', async () => {
  const ws = await makeWorkspace();
  try {
    for (const [name, value] of [
      ['a number', 12345],
      ['an object', { path: '/x.jsonl' }],
      ['an array', ['/x.jsonl']],
      ['null', null],
      ['empty', ''],
      ['1025 characters', `/${'a'.repeat(1024)}`],
    ] as [string, unknown][]) {
      const snapshot = join(ws.root, `sess-tp-${name.replace(/\W+/g, '-')}.json`);
      const payload = fixture(ws.repo, 'sess-tp-bad');
      payload['transcript_path'] = value;
      const res = await runWithSnapshot('default', ws.prefs, snapshot, payload);
      assert.equal(res.code, 0, `${name}: still exits 0`);
      assert.equal(res.err, '', `${name}: the HARD RULE — never a word on stderr`);
      const written = await readSnapshot(snapshot);
      assert.equal('transcript' in written, false, `${name}: no transcript key`);
    }
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('snapshot: `enabled:false` prints nothing and STILL writes it — the pane bar is a separate switch', async () => {
  const ws = await makeWorkspace();
  const snapshot = join(ws.root, 'sess-off.json');
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: false } }));
    const res = await runWithSnapshot('default', ws.prefs, snapshot, fixture(ws.repo, 'sess-off'));
    assert.equal(res.code, 0);
    assert.equal(res.out, '', 'Claude Code still gets a blank bar');
    assert.equal(res.err, '');
    const written = await readSnapshot(snapshot);
    assert.equal(written['v'], 1);
    assert.equal(written['model'], 'Opus 5');
    assert.equal(written['branch'], 'main', 'the branch toggle is still what decides this one');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('snapshot is written ONLY on change: an identical second run leaves content and mtime alone', async () => {
  const ws = await makeWorkspace();
  const snapshot = join(ws.root, 'sess-idle.json');
  try {
    const payload = fixture(ws.repo, 'sess-idle');
    await runWithSnapshot('default', ws.prefs, snapshot, payload);
    const first = await readFile(snapshot, 'utf8');
    const firstStat = await stat(snapshot);
    await sleep(MTIME_TICK_MS);

    await runWithSnapshot('default', ws.prefs, snapshot, payload);
    const second = await readFile(snapshot, 'utf8');
    const secondStat = await stat(snapshot);
    assert.equal(second, first, 'the 2 s refresh of an idle session must not rewrite the file');
    assert.equal(secondStat.mtimeMs, firstStat.mtimeMs, 'not even the mtime moves: no watcher wake-up');

    // A real change (the session spent money) does rewrite it.
    payload.cost = { ...payload.cost, total_cost_usd: 0.99 };
    await runWithSnapshot('default', ws.prefs, snapshot, payload);
    const third = await readSnapshot(snapshot);
    assert.equal(third['cost'], 0.99);
    assert.notEqual((await stat(snapshot)).mtimeMs, firstStat.mtimeMs);
    // Nothing but the snapshot is left behind: the tmp file is renamed, never orphaned.
    assert.deepEqual(
      (await readdir(ws.root)).filter((f) => f.startsWith('sess-idle')),
      ['sess-idle.json'],
    );
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('snapshot: the branch recorded is the branch on the line, and is absent when the toggle is off', async () => {
  const ws = await makeWorkspace();
  const withBranch = join(ws.root, 'sess-b1.json');
  const withoutBranch = join(ws.root, 'sess-b2.json');
  try {
    const on = await runWithSnapshot('default', ws.prefs, withBranch, fixture(ws.repo, 'sess-b1'));
    assert.match(on.out, /git:main/);
    assert.equal((await readSnapshot(withBranch))['branch'], 'main', 'one probe, both consumers');

    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, branch: false } }));
    const off = await runWithSnapshot('default', ws.prefs, withoutBranch, fixture(ws.repo, 'sess-b2'));
    assert.doesNotMatch(off.out, /git:/);
    assert.equal(Object.hasOwn(await readSnapshot(withoutBranch), 'branch'), false);
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('both bars off: the snapshot is still written, but nobody forks git for a branch nobody draws', async () => {
  const ws = await makeWorkspace();
  const dark = join(ws.root, 'sess-dark.json');
  const lit = join(ws.root, 'sess-lit.json');
  try {
    // The server ALWAYS passes a snapshot path, so with both switches off the
    // probe would otherwise run every 2 s for a value no bar shows.
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: false, paneBar: false, branch: true } }));
    const off = await runWithSnapshot('default', ws.prefs, dark, fixture(ws.repo, 'sess-dark'));
    assert.equal(off.code, 0);
    assert.equal(off.out, '');
    const written = await readSnapshot(dark);
    assert.equal(written['v'], 1, 'the write-on-change rule holds: the file is there');
    assert.equal(Object.hasOwn(written, 'branch'), false, 'no probe, so no branch');
    assert.equal(
      (await readdir(ws.root)).includes('statusline-cache.json'),
      false,
      'and no branch cache either — the probe never ran',
    );

    // The pane bar alone is reason enough to probe.
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: false, paneBar: true, branch: true } }));
    const on = await runWithSnapshot('default', ws.prefs, lit, fixture(ws.repo, 'sess-lit'));
    assert.equal(on.out, '');
    assert.equal((await readSnapshot(lit))['branch'], 'main');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('no fourth argument -> no snapshot anywhere; an unwritable snapshot path still prints the line', async () => {
  const ws = await makeWorkspace();
  try {
    // Exactly the pre-B1 invocation: two arguments, and no snapshot is written.
    const before = await readdir(ws.root);
    const res = await runStatusline('default', ws.prefs, fixture(ws.repo, 'sess-none'));
    assert.equal(res.out, 'Opus 5 | always ask | git:main | $0.42 | ctx 32%');
    const after = await readdir(ws.root);
    assert.deepEqual(
      after.filter((f) => !before.includes(f)),
      ['statusline-cache.json'],
      'the branch cache is the ONLY file a two-argument run creates',
    );

    // A path inside a directory that does not exist: the write fails, silently.
    const impossible = join(ws.root, 'no-such-dir', 'sess-x.json');
    const still = await runWithSnapshot('default', ws.prefs, impossible, fixture(ws.repo, 'sess-x'));
    assert.equal(still.code, 0);
    assert.equal(still.err, '', 'the HARD RULE: a failed snapshot never speaks');
    assert.equal(still.out, 'Opus 5 | always ask | git:main | $0.42 | ctx 32%');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('snapshot strings are cleaned like the line: an ESC in a model name never reaches the file', async () => {
  const ws = await makeWorkspace();
  const snapshot = join(ws.root, 'sess-esc.json');
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  try {
    const payload = fixture(ws.repo, 'sess-esc');
    // A display name is a SOURCED string: it must not be able to recolor the
    // pane it is drawn in, or to smuggle a control byte into the app's own bar.
    payload.model = { id: 'x', display_name: `Opus${ESC}[31m 5${BEL} ${'z'.repeat(80)}` };
    await runWithSnapshot('default', ws.prefs, snapshot, payload);
    const model = (await readSnapshot(snapshot))['model'] as string;
    assert.doesNotMatch(model, /\p{Cc}/u, 'no control byte survives');
    assert.ok(model.length <= 64, `capped at 64, got ${model.length}`);
    // ESC and BEL become spaces, whitespace collapses, the rest is kept as-is.
    assert.equal(model, `Opus [31m 5 ${'z'.repeat(52)}`);
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The snapshot path is NOT a trusted path
//
// It is composed by the server, but it names a file in an ordinary 0700
// directory, and the script re-reads that file on every single turn (to decide
// whether anything changed). Any process running as this user — and, on this
// WSL setup, Windows — can put something else there first. Neither the read nor
// the write may be usable against the turn.
// ---------------------------------------------------------------------------

/** Run the script with a hard deadline; a run that has to be killed is a hang. */
function runWithDeadline(
  args: string[],
  payload: unknown,
  ms: number,
): Promise<{ out: string; err: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, ms);
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ out: out.replace(/\n$/, ''), err, code, timedOut });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

test('snapshot: a FIFO planted at the snapshot path never hangs the turn', async () => {
  const ws = await makeWorkspace();
  const snapshot = join(ws.root, 'sess-fifo.json');
  try {
    execFileSync('mkfifo', [snapshot]);
    // Nothing is holding the other end open, which is the whole attack: an
    // O_RDONLY open of a FIFO waits for a writer, and this script runs on every
    // turn AND every 2 s. A hang here is a hung status line for the session.
    const res = await runWithDeadline(['default', ws.prefs, snapshot], fixture(ws.repo, 'sess-fifo'), 6_000);
    assert.equal(res.timedOut, false, 'the script had to be killed: a planted FIFO hung the turn');
    assert.equal(res.code, 0);
    assert.equal(res.err, '', 'the HARD RULE holds: nothing is ever printed on stderr');
    assert.equal(res.out, 'Opus 5 | always ask | git:main | $0.42 | ctx 32%', 'the line is drawn anyway');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

/**
 * Run the script through `/bin/sh` with `exec`, which keeps the shell's pid —
 * so the tmp name the script will use (`<file>.<pid>.tmp`) is known BEFORE it
 * runs and something can be waiting there. Without `exec` the pid differs and
 * the test would prove nothing.
 *
 * The shell line is a CONSTANT; every value (paths, the node binary) travels
 * as a positional parameter and is expanded quoted (`"$1"` … `"$5"`), never
 * spliced into the command text — a path holding a space or a quote is still
 * one word. CodeQL's `js/shell-command-injection-from-environment` flags any
 * `sh -c` fed environment-derived arguments; alert #13 was dismissed as a
 * false positive on that reading (2026-09-17).
 */
function runWithPlantedTmp(
  snapshot: string,
  linkTarget: string,
  prefsFile: string,
  payload: unknown,
): Promise<{ out: string; code: number | null }> {
  const script = 'ln -s "$2" "$1.$$.tmp"; exec "$3" "$4" default "$5" "$1"';
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', script, 'sh', snapshot, linkTarget, process.execPath, SCRIPT, prefsFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ out: out.replace(/\n$/, ''), code }));
    child.stdin.on('error', () => {});
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

test("snapshot: the tmp file is opened 'wx' — a dangling symlink there is never written through", async () => {
  const ws = await makeWorkspace();
  const snapshot = join(ws.root, 'sess-tmp.json');
  const target = join(ws.root, 'somewhere-else.json');
  try {
    const res = await runWithPlantedTmp(snapshot, target, ws.prefs, fixture(ws.repo, 'sess-tmp'));
    assert.equal(res.code, 0);
    assert.equal(res.out, 'Opus 5 | always ask | git:main | $0.42 | ctx 32%', 'the line is unaffected');
    // 'wx' fails with EEXIST on the planted link, so the link's TARGET is never
    // created: an attacker cannot aim this write at a file of their choosing.
    await assert.rejects(stat(target), 'the symlink target was written through');
    // And the failed write cleans up after itself instead of leaving the link.
    assert.deepEqual(
      (await readdir(ws.root)).filter((f) => f.startsWith('sess-tmp')),
      [],
      'no snapshot, and no leftover tmp link',
    );
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('snapshot: a SYMLINK at the snapshot path is replaced, never read through', async () => {
  const ws = await makeWorkspace();
  const real = join(ws.root, 'sess-sym.json');
  const planted = join(ws.root, 'elsewhere.json');
  try {
    const payload = fixture(ws.repo, 'sess-sym');
    // First, the snapshot this payload really produces...
    await runWithSnapshot('default', ws.prefs, real, payload);
    const body = await readFile(real, 'utf8');
    // ...now the same bytes somewhere else, with a symlink pointing at them.
    // If the script read THROUGH the link it would find its own content, decide
    // nothing changed, and write nothing — so the session's snapshot would
    // never exist, the link would survive, and the pane bar would go quiet for
    // good (the watcher refuses symlinks too).
    await writeFile(planted, body, { mode: 0o600 });
    const link = join(ws.root, 'sess-link.json');
    await symlink(planted, link);

    const res = await runWithSnapshot('default', ws.prefs, link, payload);
    assert.equal(res.code, 0);
    assert.equal(res.err, '');
    const after = await lstat(link);
    assert.equal(after.isSymbolicLink(), false, 'the link was replaced by the rename, not followed');
    assert.equal(after.isFile(), true);
    assert.equal((after.mode & 0o777).toString(8), '600');
    assert.equal((await readSnapshot(link))['model'], 'Opus 5');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});
