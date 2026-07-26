/**
 * `server/statusline.mjs` — the line Claude Code draws for app-launched
 * sessions. It is a standalone process (claude runs it, not our server), so it
 * is tested exactly the way claude uses it: spawn `node statusline.mjs <mode>
 * <prefs.json>`, pipe a payload on stdin, read one line of stdout.
 *
 * The contract under test:
 *   1. HONESTY — an item appears only when its toggle is ON and the payload
 *      carries a real value. Absent/null/zero-as-unknown -> omitted, never faked.
 *   2. NEVER SPEAK ON FAILURE — corrupt prefs, corrupt payload, empty stdin, a
 *      non-git cwd: print nothing, exit 0. Anything printed lands INSIDE the
 *      user's terminal on every turn, so an error message is worse than a blank.
 *   3. CONFIG IS RE-READ EVERY RUN — that is what makes a settings toggle apply
 *      to already-running sessions.
 *   4. The git branch is cached per `session_id`, in the data dir, ~5 s.
 *
 * Payload fixtures mirror the real shape of Claude Code 2.1.220's status-line
 * stdin JSON (model / workspace / cost / context_window / rate_limits).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDataPaths } from '../server/config.ts';
import { projectRoot } from './helpers.ts';

const SCRIPT = join(projectRoot, 'server', 'statusline.mjs');

/** Run the script the way Claude Code does; resolve with trimmed stdout + code. */
function runStatusline(
  mode: string,
  prefsFile: string,
  payload: unknown,
): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, mode, prefsFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ out: out.replace(/\n$/, ''), err, code }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

/** Run the script with an ARBITRARY argv (fewer/odd args), same stdin protocol. */
function runRaw(
  args: string[],
  payload: unknown,
  env?: NodeJS.ProcessEnv,
): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(env !== undefined ? { env } : {}),
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ out: out.replace(/\n$/, ''), err, code }));
    // The script destroys stdin as soon as it has an answer (or hits its size
    // ceiling), so a large write can legitimately fail with EPIPE mid-flight —
    // that is the guard working, not a test failure.
    child.stdin.on('error', () => {});
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

interface Fixture {
  session_id: string;
  cwd: string;
  workspace: { current_dir: string; project_dir: string; added_dirs: string[] };
  model: { id: string; display_name: string };
  cost: Record<string, number>;
  context_window: Record<string, unknown>;
  rate_limits?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A full, realistic payload rooted at `dir`. */
function fixture(dir: string, sessionId = 'sess-1'): Fixture {
  return {
    session_id: sessionId,
    transcript_path: '/home/u/.claude/projects/p/sess-1.jsonl',
    cwd: dir,
    model: { id: 'claude-opus-5', display_name: 'Opus 5' },
    workspace: { current_dir: dir, project_dir: dir, added_dirs: [] },
    version: '2.1.220',
    output_style: { name: 'default' },
    cost: {
      total_cost_usd: 0.4231,
      total_duration_ms: 12_000,
      total_api_duration_ms: 8_000,
      total_lines_added: 120,
      total_lines_removed: 14,
    },
    context_window: {
      total_input_tokens: 64_000,
      total_output_tokens: 1_200,
      context_window_size: 200_000,
      used_percentage: 32.4,
      remaining_percentage: 67.6,
    },
    exceeds_200k_tokens: false,
    rate_limits: {
      five_hour: { used_percentage: 45.6, resets_at: 1_780_000_000 },
      seven_day: { used_percentage: 12.2, resets_at: 1_780_500_000 },
    },
  };
}

/** temp workspace: `git` = a real repo on branch `main`, `plain` = not a repo. */
async function makeWorkspace(): Promise<{ root: string; repo: string; plain: string; prefs: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-statusline-'));
  const repo = join(root, 'repo');
  const plain = join(root, 'plain');
  await mkdir(repo);
  await mkdir(plain);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  return { root, repo, plain, prefs: join(root, 'prefs.json') };
}

test('full payload, every toggle on: model | mode | branch | cost | lines | context | usage', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(
      ws.prefs,
      JSON.stringify({
        theme: { bg: 0, fg: 0, scan: false },
        statusLine: { enabled: true, model: true, mode: true, branch: true, cost: true, lines: true, context: true, usage: true },
      }),
    );
    const res = await runStatusline('acceptEdits', ws.prefs, fixture(ws.repo));
    assert.equal(res.code, 0);
    assert.equal(res.err, '');
    assert.equal(res.out, 'Opus 5 | auto-edits | git:main | $0.42 | +120 -14 | ctx 32% | 5h 45% 7d 12%');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('factory defaults (no prefs.json at all): lines and usage stay OFF, the rest on', async () => {
  const ws = await makeWorkspace();
  try {
    const res = await runStatusline('bypassPermissions', join(ws.root, 'absent.json'), fixture(ws.repo));
    assert.equal(res.code, 0);
    assert.equal(res.out, 'Opus 5 | never ask | git:main | $0.42 | ctx 32%');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('corrupt prefs.json falls back to the factory defaults instead of blanking the bar', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.prefs, '{"statusLine": {"model": tru');
    const res = await runStatusline('plan', ws.prefs, fixture(ws.repo));
    assert.equal(res.code, 0);
    assert.equal(res.out, 'Opus 5 | plan | git:main | $0.42 | ctx 32%');
    // A statusLine key of the wrong TYPE is equally non-fatal.
    await writeFile(ws.prefs, JSON.stringify({ statusLine: 'yes please' }));
    const res2 = await runStatusline('default', ws.prefs, fixture(ws.repo));
    assert.equal(res2.out, 'Opus 5 | always ask | git:main | $0.42 | ctx 32%');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('enabled:false prints NOTHING and still exits 0', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: false, model: true, cost: true } }));
    const res = await runStatusline('default', ws.prefs, fixture(ws.repo));
    assert.equal(res.code, 0);
    assert.equal(res.out, '');
    assert.equal(res.err, '');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('every toggle off -> empty line (the whole bar disappears)', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(
      ws.prefs,
      JSON.stringify({ statusLine: { model: false, mode: false, branch: false, cost: false, lines: false, context: false, usage: false } }),
    );
    const res = await runStatusline('acceptEdits', ws.prefs, fixture(ws.repo));
    assert.equal(res.out, '');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('honesty: no rate_limits, non-git cwd, null context, zero cost and zero lines are all OMITTED', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { lines: true, usage: true } }));
    const payload = fixture(ws.plain);
    delete payload.rate_limits; // API-key / pre-first-response sessions have none.
    payload.cost = { total_cost_usd: 0, total_lines_added: 0, total_lines_removed: 0 };
    payload.context_window = { context_window_size: 200_000, used_percentage: null };
    const res = await runStatusline('plan', ws.prefs, payload);
    assert.equal(res.code, 0);
    assert.equal(res.out, 'Opus 5 | plan', 'only the two values that really exist');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('an unknown permission mode is omitted rather than mislabelled; a payload field would win', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { model: false, branch: false, cost: false, context: false } }));
    const bare = await runStatusline('unknown', ws.prefs, fixture(ws.repo));
    assert.equal(bare.out, '', 'no honest label for a mode we do not know');
    // Feature detection: if a future Claude Code puts the mode in the payload,
    // the payload beats the argument the server passed at spawn time.
    const withField = { ...fixture(ws.repo), permission_mode: 'bypassPermissions' };
    const res = await runStatusline('default', ws.prefs, withField);
    assert.equal(res.out, 'never ask');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('never speaks on bad input: empty stdin, non-JSON, a JSON array, a huge number', async () => {
  const ws = await makeWorkspace();
  try {
    for (const payload of ['', 'not json at all', '[]', 'null', '"a string"']) {
      const res = await runStatusline('default', ws.prefs, payload);
      assert.equal(res.code, 0, `exit code for ${JSON.stringify(payload)}`);
      assert.equal(res.out, '', `stdout for ${JSON.stringify(payload)}`);
      assert.equal(res.err, '', `stderr for ${JSON.stringify(payload)}`);
    }
    // Garbage IN a valid object: every field the wrong type.
    const junk = {
      session_id: 42,
      model: 'not-an-object',
      workspace: [],
      cost: { total_cost_usd: 'free', total_lines_added: null },
      context_window: { used_percentage: 'lots' },
      rate_limits: { five_hour: 7 },
    };
    const res = await runStatusline('default', ws.prefs, junk);
    assert.equal(res.code, 0);
    assert.equal(res.out, 'always ask', 'only the argument-sourced item survives');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('control characters in payload strings never reach the terminal', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { branch: false, cost: false, context: false } }));
    const payload = { ...fixture(ws.repo), model: { id: 'x', display_name: 'Opus\u001b[31m 5\u0007\n' } };
    const res = await runStatusline('default', ws.prefs, payload);
    assert.equal(res.out, 'Opus [31m 5 | always ask');
    assert.ok(!res.out.includes('\u001b'), 'no ESC');
    assert.ok(!res.out.includes('\u0007'), 'no BEL');
    assert.equal(res.out.split('\n').length, 1, 'exactly one line');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('the branch is cached in the data dir keyed by session_id (never by pid) and honoured within the TTL', async () => {
  const ws = await makeWorkspace();
  const cacheFile = join(ws.root, 'statusline-cache.json');
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { model: false, mode: false, cost: false, context: false } }));
    const first = await runStatusline('default', ws.prefs, fixture(ws.repo, 'sess-cache'));
    assert.equal(first.out, 'git:main');

    const cache = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<
      string,
      { at: number; branch: string; cwd: string }
    >;
    assert.deepEqual(Object.keys(cache), ['sess-cache'], 'one entry, keyed by the session id');
    assert.equal(cache['sess-cache']?.branch, 'main');
    assert.equal(cache['sess-cache']?.cwd, ws.repo, 'the directory the branch came from is recorded');
    assert.ok(Date.now() - (cache['sess-cache']?.at ?? 0) < 10_000, 'stamped with a real timestamp');

    // Poison the cached value: a fresh run inside the TTL must return it
    // verbatim, which proves no git process was forked for this invocation.
    await writeFile(cacheFile, JSON.stringify({ 'sess-cache': { at: Date.now(), branch: 'from-cache', cwd: ws.repo } }));
    const cached = await runStatusline('default', ws.prefs, fixture(ws.repo, 'sess-cache'));
    assert.equal(cached.out, 'git:from-cache');

    // A fresh entry for a DIFFERENT directory is not an answer for this one.
    const elsewhere = await runStatusline('default', ws.prefs, fixture(ws.plain, 'sess-cache'));
    assert.equal(elsewhere.out, '', 'a cwd mismatch is a miss, not a stale branch from another folder');

    // An expired entry is refreshed from git, and stale entries of OTHER
    // sessions are pruned on the way through.
    await writeFile(
      cacheFile,
      JSON.stringify({
        'sess-cache': { at: Date.now() - 60_000, branch: 'from-cache', cwd: ws.repo },
        'long-gone': { at: Date.now() - 3_600_000, branch: 'zombie', cwd: ws.repo },
      }),
    );
    const refreshed = await runStatusline('default', ws.prefs, fixture(ws.repo, 'sess-cache'));
    assert.equal(refreshed.out, 'git:main');
    const pruned = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(pruned), ['sess-cache'], 'the stale entry was pruned');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('each item is drawn by ITS OWN toggle: one toggle on at a time draws exactly one item', async () => {
  // The all-on and all-off tests above both pass if two guards are swapped.
  // This is the table that pins every `if (config.X)` block to its own key.
  const ws = await makeWorkspace();
  try {
    const cases: [string, string][] = [
      ['model', 'Opus 5'],
      ['mode', 'auto-edits'],
      ['branch', 'git:main'],
      ['cost', '$0.42'],
      ['lines', '+120 -14'],
      ['context', 'ctx 32%'],
      ['usage', '5h 45% 7d 12%'],
    ];
    for (const [key, expected] of cases) {
      const off = {
        enabled: true,
        model: false,
        mode: false,
        branch: false,
        cost: false,
        lines: false,
        context: false,
        usage: false,
      };
      await writeFile(ws.prefs, JSON.stringify({ statusLine: { ...off, [key]: true } }));
      const res = await runStatusline('acceptEdits', ws.prefs, fixture(ws.repo, `sess-only-${key}`));
      assert.equal(res.code, 0, `exit code with only ${key} on`);
      assert.equal(res.out, expected, `only \`${key}\` on must draw exactly ${JSON.stringify(expected)}`);
    }
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('percentages are floored and clamped to 0-100 — never 132%, never a negative, never a fraction', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { model: false, mode: false, branch: false, cost: false, context: true, usage: true } }));
    const over = fixture(ws.repo, 'sess-pct-1');
    over.context_window = { used_percentage: 132.9 };
    over.rate_limits = { five_hour: { used_percentage: 100.4 }, seven_day: { used_percentage: -3 } };
    assert.equal((await runStatusline('default', ws.prefs, over)).out, 'ctx 100% | 5h 100% 7d 0%');

    const fractional = fixture(ws.repo, 'sess-pct-2');
    fractional.context_window = { used_percentage: 99.99 };
    fractional.rate_limits = { five_hour: { used_percentage: 0.9 }, seven_day: { used_percentage: 0 } };
    assert.equal((await runStatusline('default', ws.prefs, fractional)).out, 'ctx 99% | 5h 0% 7d 0%');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('length caps hold: a sourced field is cut at 64 chars and the whole line at 240', async () => {
  // Both caps exist so a hostile/absurd value cannot reshape the pane Claude
  // Code truncates. The line cap is only reachable with maximal fields, so this
  // test drives every item at once with the largest value it can carry.
  const ws = await makeWorkspace();
  try {
    const longBranch = `br-${'x'.repeat(67)}`; // 70 chars
    const bigRepo = join(ws.root, 'bigrepo');
    await mkdir(bigRepo);
    execFileSync('git', ['init', '-q', '-b', longBranch], { cwd: bigRepo });
    await writeFile(
      ws.prefs,
      JSON.stringify({ statusLine: { enabled: true, model: true, mode: true, branch: true, cost: true, lines: true, context: true, usage: true } }),
    );
    const payload = fixture(bigRepo, 'sess-caps');
    const longName = `Opus ${'y'.repeat(65)}`; // 70 chars
    payload.model = { id: 'm', display_name: longName };
    payload.cost = { total_cost_usd: 1e20, total_lines_added: 1e20, total_lines_removed: 1e20 };
    payload.context_window = { used_percentage: 100 };
    payload.rate_limits = { five_hour: { used_percentage: 100 }, seven_day: { used_percentage: 100 } };

    const res = await runStatusline('acceptEdits', ws.prefs, payload);
    assert.equal(res.code, 0);
    assert.equal(res.err, '');
    assert.equal(res.out.length, 240, 'the whole line is capped at 240 chars');
    const items = res.out.split(' | ');
    assert.equal(items[0], longName.slice(0, 64), 'the model name is cut at 64 chars');
    assert.equal(items[0].length, 64);
    assert.equal(items[2], `git:${longBranch.slice(0, 64)}`, 'the branch is cut at 64 chars too');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('the branch cache is capped at 64 entries — the oldest are evicted, this session survives', async () => {
  const ws = await makeWorkspace();
  const cacheFile = join(ws.root, 'statusline-cache.json');
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { model: false, mode: false, cost: false, context: false } }));
    // 80 entries, ALL fresh (nothing to prune) — so only the size cap can act.
    const now = Date.now();
    const crowded: Record<string, { at: number; branch: string; cwd: string }> = {};
    for (let i = 0; i < 80; i += 1) {
      crowded[`old-${i}`] = { at: now - i * 5, branch: `b${i}`, cwd: ws.repo };
    }
    await writeFile(cacheFile, JSON.stringify(crowded));

    const res = await runStatusline('default', ws.prefs, fixture(ws.repo, 'sess-cap'));
    assert.equal(res.out, 'git:main');

    const after = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, unknown>;
    const keys = Object.keys(after);
    assert.equal(keys.length, 64, 'the file never grows past the cap');
    assert.ok(keys.includes('sess-cap'), 'the entry just written is never the one evicted');
    assert.ok(!keys.includes('old-79'), 'the oldest entry was evicted first');
    assert.ok(keys.includes('old-0'), 'the newest survivors stay');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('with NO prefs path argument at all: factory defaults, and no cache file is written anywhere', async () => {
  const ws = await makeWorkspace();
  try {
    const res = await runRaw(['default'], fixture(ws.repo, 'sess-noprefs'));
    assert.equal(res.code, 0);
    assert.equal(res.err, '');
    assert.equal(res.out, 'Opus 5 | always ask | git:main | $0.42 | ctx 32%');
    // No prefs path -> no data dir to cache in; the probe runs uncached rather
    // than writing a cache file next to something it guessed.
    assert.deepEqual(
      (await readdir(ws.root)).filter((f) => f.includes('statusline-cache')),
      [],
    );
    assert.deepEqual(
      (await readdir(ws.repo)).filter((f) => f.includes('statusline-cache')),
      [],
    );
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('the branch is probed in workspace.current_dir, falling back to cwd', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { model: false, mode: false, cost: false, context: false } }));
    // Workspace wins: a session whose cwd is elsewhere still reports the
    // workspace's branch (this is the directory Claude Code is working in).
    const moved = fixture(ws.plain, 'sess-ws-1');
    moved.workspace = { current_dir: ws.repo, project_dir: ws.repo, added_dirs: [] };
    assert.equal((await runStatusline('default', ws.prefs, moved)).out, 'git:main');

    // No workspace at all -> the top-level cwd is the fallback.
    const bare = fixture(ws.repo, 'sess-ws-2') as Record<string, unknown>;
    delete bare['workspace'];
    assert.equal((await runStatusline('default', ws.prefs, bare)).out, 'git:main');

    // An empty current_dir is not a directory: fall back rather than probe ''.
    const empty = fixture(ws.repo, 'sess-ws-3');
    empty.workspace = { current_dir: '', project_dir: '', added_dirs: [] };
    assert.equal((await runStatusline('default', ws.prefs, empty)).out, 'git:main');

    // And the mirror image: a workspace pointing at a non-repo says nothing,
    // even though the payload's own cwd IS a repo.
    const nonRepo = fixture(ws.repo, 'sess-ws-4');
    nonRepo.workspace = { current_dir: ws.plain, project_dir: ws.plain, added_dirs: [] };
    assert.equal((await runStatusline('default', ws.prefs, nonRepo)).out, '');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('an oversized stdin payload is dropped (blank, exit 0) instead of being buffered', async () => {
  const ws = await makeWorkspace();
  try {
    const payload = fixture(ws.repo, 'sess-huge') as Record<string, unknown>;
    payload['padding'] = 'p'.repeat(1024 * 1024 + 4096); // past the 1 MiB ceiling
    const res = await runRaw(['default', ws.prefs], payload);
    assert.equal(res.code, 0);
    assert.equal(res.out, '');
    assert.equal(res.err, '');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('a payload that never arrives gives up and exits — the script can never hang a turn', async () => {
  // Claude Code waits for this process on every assistant message. A stdin that
  // stays open forever must end in a blank bar, not a stuck session.
  const ws = await makeWorkspace();
  const started = Date.now();
  try {
    const res = await new Promise<{ out: string; err: string; code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [SCRIPT, 'default', ws.prefs], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => resolve({ out, err, code }));
      const bail = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('statusline.mjs never exited on an open stdin'));
      }, 20_000);
      child.on('close', () => clearTimeout(bail));
      // Deliberately: write nothing, and never end the stream.
    });
    assert.equal(res.code, 0);
    assert.equal(res.out, '');
    assert.equal(res.err, '');
    assert.ok(Date.now() - started < 20_000, 'it gave up on its own');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('a hanging git probe is abandoned: the branch drops out, every other item still draws', async () => {
  const ws = await makeWorkspace();
  const fakeBin = join(ws.root, 'fakebin');
  try {
    // A `git` that never answers, found FIRST on the child's PATH. The probe's
    // own timeout is the only thing that can end this.
    await mkdir(fakeBin);
    await writeFile(join(fakeBin, 'git'), '#!/bin/sh\nexec sleep 30\n');
    await chmod(join(fakeBin, 'git'), 0o755);
    const started = Date.now();
    const res = await runRaw(['plan', ws.prefs], fixture(ws.repo, 'sess-hang'), {
      ...process.env,
      PATH: `${fakeBin}:${process.env['PATH'] ?? ''}`,
    });
    const elapsed = Date.now() - started;
    assert.equal(res.code, 0);
    assert.equal(res.err, '');
    assert.equal(res.out, 'Opus 5 | plan | $0.42 | ctx 32%', 'no branch item, nothing else lost');
    // Timing is the assertion that matters: without the probe's own timeout the
    // same output would eventually appear — 30 seconds later, with claude
    // waiting on it. (The fake git sleeps 30s; the probe gives up after 1.5s.)
    assert.ok(elapsed < 10_000, `the probe was abandoned early, took ${elapsed}ms`);
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// The cache file is UNTRUSTED INPUT (added 2026-07-26)
//
// statusline-cache.json lives in the data dir, so every process running as this
// user can write it — and whatever comes out of it is printed straight into the
// user's terminal on every assistant turn. That makes a cached value exactly as
// untrusted as the git probe's own stdout, so the READ path must run the same
// clean() the fresh path runs. These four tests are the attack, and the two
// must-agree sites for the file's location, as tests.
// ---------------------------------------------------------------------------

test('a POISONED cache entry is sanitized ON READ: no escape sequence reaches the terminal, and 64 is still the cap', async () => {
  const ws = await makeWorkspace();
  const cacheFile = join(ws.root, 'statusline-cache.json');
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { model: false, mode: false, cost: false, context: false } }));
    // `plain` is NOT a repo: a miss here prints nothing at all, so anything
    // this run prints can only have come out of the cache file.
    const poison = `\u001b]0;pwned\u0007${'b'.repeat(70)}`;
    await writeFile(cacheFile, JSON.stringify({ 'sess-poison': { at: Date.now(), branch: poison, cwd: ws.plain } }));

    const res = await runStatusline('default', ws.prefs, fixture(ws.plain, 'sess-poison'));
    assert.equal(res.code, 0);
    assert.equal(res.err, '');
    // ESC and BEL become spaces, the run collapses, the value is trimmed, and
    // the 64-char field cap applies to a cached string exactly as it does to a
    // fresh probe: `]0;pwned ` (9) + 55 of the 70 b's.
    assert.equal(res.out, `git:]0;pwned ${'b'.repeat(55)}`);
    assert.equal(res.out.slice('git:'.length).length, 64, 'the cached value is capped at 64 like any other field');
    assert.ok(!res.out.includes('\u001b'), 'no ESC — an OSC/CSI sequence could retitle or recolor the pane');
    assert.ok(!res.out.includes('\u0007'), 'no BEL — that is the app’s own attention signal');
    assert.equal(res.out.split('\n').length, 1, 'exactly one line');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('a cache entry that CLEANS TO EMPTY is a MISS: the script probes git instead of drawing an empty item', async () => {
  const ws = await makeWorkspace();
  const cacheFile = join(ws.root, 'statusline-cache.json');
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { model: false, mode: false, cost: false, context: false } }));
    // Fresh timestamp, matching cwd — everything about this entry is a hit
    // EXCEPT its value, which is controls and whitespace only.
    await writeFile(
      cacheFile,
      JSON.stringify({ 'sess-empty': { at: Date.now(), branch: '\u001b\u0007 \t ', cwd: ws.repo } }),
    );

    const res = await runStatusline('default', ws.prefs, fixture(ws.repo, 'sess-empty'));
    assert.equal(res.code, 0);
    assert.equal(res.out, 'git:main', 'fell through to a real probe rather than drawing `git:`');
    const after = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, { branch: string }>;
    assert.equal(after['sess-empty']?.branch, 'main', 'and the unusable entry was overwritten with the probed value');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('a NEGATIVE cache entry (branch null) is re-probed, not honoured — a non-repo cwd forks git every tick', async () => {
  // A consequence of sanitising on read, pinned so the cost is a recorded
  // decision rather than a surprise: `null` cleans to '' and is therefore a
  // MISS. A session sitting in a non-repo directory (or on a detached HEAD)
  // re-probes git on every invocation — every ~2s, the settings file's
  // refreshInterval — and rewrites the cache file each time, where before it
  // answered from the entry for the 5s TTL.
  const ws = await makeWorkspace();
  const cacheFile = join(ws.root, 'statusline-cache.json');
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { model: false, mode: false, cost: false, context: false } }));

    // (a) The directory became a repo since the null was written: the answer is
    // fresh, not the remembered nothing.
    await writeFile(cacheFile, JSON.stringify({ 'sess-neg': { at: Date.now(), branch: null, cwd: ws.repo } }));
    assert.equal((await runStatusline('default', ws.prefs, fixture(ws.repo, 'sess-neg'))).out, 'git:main');

    // (b) Still not a repo: silent either way, so the PROOF that a probe ran is
    // the rewritten timestamp — a honoured entry would not be touched at all.
    const stamped = Date.now() - 3_000; // inside the 5s TTL, so only the value can miss
    await writeFile(cacheFile, JSON.stringify({ 'sess-neg2': { at: stamped, branch: null, cwd: ws.plain } }));
    const silent = await runStatusline('default', ws.prefs, fixture(ws.plain, 'sess-neg2'));
    assert.equal(silent.out, '');
    const after = JSON.parse(await readFile(cacheFile, 'utf8')) as Record<string, { at: number; branch: string | null }>;
    assert.equal(after['sess-neg2']?.branch, null, 'still no branch to report');
    assert.ok(
      (after['sess-neg2']?.at ?? 0) > stamped,
      `the entry was rewritten by a fresh probe (at ${after['sess-neg2']?.at} > ${stamped})`,
    );
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('the file the script writes IS DataPaths.statuslineCacheFile — the two must-agree sites, checked against each other', async () => {
  // statusline.mjs cannot import server/config.ts (it runs inside the foreign
  // `claude` process), so it derives the cache path from the prefs path it is
  // handed, while the backend declares the same path in config.ts and deletes
  // it at boot. Drift between them would silently stop the boot wipe from
  // wiping anything. Both real sites run here: the real resolver produces the
  // path, the real script writes the file.
  const root = await mkdtemp(join(tmpdir(), 'ai-sm-cachepath-'));
  const dataDir = join(root, 'data');
  const repo = join(root, 'repo');
  const previous = process.env['AI_SM_DATA_DIR'];
  try {
    await mkdir(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    process.env['AI_SM_DATA_DIR'] = dataDir;
    const paths = resolveDataPaths();

    // No prefs.json is written: the factory defaults are the point of the run,
    // the cache file is what is being located.
    const res = await runStatusline('default', paths.prefsFile, fixture(repo, 'sess-path'));
    assert.equal(res.code, 0);
    assert.equal(res.out, 'Opus 5 | always ask | git:main | $0.42 | ctx 32%');

    const cache = JSON.parse(await readFile(paths.statuslineCacheFile, 'utf8')) as Record<string, unknown>;
    assert.deepEqual(Object.keys(cache), ['sess-path'], 'the script wrote exactly where config.ts says it does');
    assert.equal((await stat(paths.statuslineCacheFile)).mode & 0o777, 0o600, 'user-only, as config.ts documents');
    // Nothing cache-shaped anywhere else in the data dir.
    assert.deepEqual(
      (await readdir(dataDir)).filter((f) => f.includes('statusline')),
      ['statusline-cache.json'],
    );
  } finally {
    if (previous === undefined) delete process.env['AI_SM_DATA_DIR'];
    else process.env['AI_SM_DATA_DIR'] = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test('a detached HEAD reports no branch (never the word HEAD), and a non-repo cwd is silent', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { model: false, mode: false, cost: false, context: false } }));
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: ws.repo });
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ws.repo, encoding: 'utf8' }).trim();
    execFileSync('git', ['checkout', '-q', head], { cwd: ws.repo });
    const detached = await runStatusline('default', ws.prefs, fixture(ws.repo, 'sess-detached'));
    assert.equal(detached.out, '');
    const notARepo = await runStatusline('default', ws.prefs, fixture(ws.plain, 'sess-plain'));
    assert.equal(notARepo.out, '');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});
