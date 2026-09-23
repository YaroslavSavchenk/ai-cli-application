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
import { chmod, lstat, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveDataPaths } from '../../server/config.ts';
import { projectRoot, sleep, makeTempDir, removeTempDir } from '../helpers/helpers.ts';

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
  const root = await makeTempDir('ai-sm-statusline-');
  const repo = join(root, 'repo');
  const plain = join(root, 'plain');
  await mkdir(repo);
  await mkdir(plain);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const prefs = join(root, 'prefs.json');
  // Claude's own line is OFF by factory default since 2026-09-17 (the bar
  // under the terminal is the default place). The item tests below are about
  // the ITEMS, so the workspace switches the line on; the defaults tests write
  // (or omit) their own prefs.
  await writeFile(prefs, JSON.stringify({ statusLine: { enabled: true } }));
  return { root, repo, plain, prefs };
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

test('factory defaults (no prefs.json at all): the line is OFF — the bar under the terminal is the default place', async () => {
  const ws = await makeWorkspace();
  try {
    const res = await runStatusline('bypassPermissions', join(ws.root, 'absent.json'), fixture(ws.repo));
    assert.equal(res.code, 0);
    assert.equal(res.out, '');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('factory item set (prefs only switch the line on): lines and usage stay OFF, the rest on', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true } }));
    const res = await runStatusline('bypassPermissions', ws.prefs, fixture(ws.repo));
    assert.equal(res.code, 0);
    assert.equal(res.out, 'Opus 5 | never ask | git:main | $0.42 | ctx 32%');
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('corrupt prefs.json falls back to the factory defaults (line off) instead of erroring', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.prefs, '{"statusLine": {"model": tru');
    const res = await runStatusline('plan', ws.prefs, fixture(ws.repo));
    assert.equal(res.code, 0);
    assert.equal(res.err, '');
    assert.equal(res.out, '');
    // A statusLine key of the wrong TYPE is equally non-fatal.
    await writeFile(ws.prefs, JSON.stringify({ statusLine: 'yes please' }));
    const res2 = await runStatusline('default', ws.prefs, fixture(ws.repo));
    assert.equal(res2.code, 0);
    assert.equal(res2.out, '');
    // A member of the wrong type keeps its default; the rest apply.
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, cost: 'no' } }));
    const res3 = await runStatusline('default', ws.prefs, fixture(ws.repo));
    assert.equal(res3.out, 'Opus 5 | always ask | git:main | $0.42 | ctx 32%');
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
      JSON.stringify({ statusLine: { enabled: true, model: false, mode: false, branch: false, cost: false, lines: false, context: false, usage: false } }),
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
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, lines: true, usage: true } }));
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
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, model: false, branch: false, cost: false, context: false } }));
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
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, branch: false, cost: false, context: false } }));
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
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, model: false, mode: false, cost: false, context: false } }));
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

test('paneAgents (B11) is a pane-only key: the script draws the same line with it on or off', async () => {
  // DEFAULT_CONFIG carries `paneAgents: false` only so the panel's factory
  // table and this one stay one list (tests/ui/ui-statusline-model); the line
  // Claude Code draws must not depend on it in either direction.
  const ws = await makeWorkspace();
  try {
    const outs: string[] = [];
    for (const paneAgents of [true, false]) {
      await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, paneAgents } }));
      const res = await runStatusline('default', ws.prefs, fixture(ws.repo, `sess-pa-${paneAgents}`));
      assert.equal(res.code, 0);
      outs.push(res.out);
    }
    assert.equal(outs[0], 'Opus 5 | always ask | git:main | $0.42 | ctx 32%');
    assert.equal(outs[1], outs[0]);
  } finally {
    await rm(ws.root, { recursive: true, force: true });
  }
});

test('percentages are floored and clamped to 0-100 — never 132%, never a negative, never a fraction', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, model: false, mode: false, branch: false, cost: false, context: true, usage: true } }));
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
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, model: false, mode: false, cost: false, context: false } }));
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
    // No prefs = factory = the line off; the probe is skipped, and the point
    // below (no cache file next to a guessed directory) holds all the more.
    assert.equal(res.out, '');
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
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, model: false, mode: false, cost: false, context: false } }));
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
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, model: false, mode: false, cost: false, context: false } }));
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
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, model: false, mode: false, cost: false, context: false } }));
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
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, model: false, mode: false, cost: false, context: false } }));

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
  const root = await makeTempDir('ai-sm-cachepath-');
  const dataDir = join(root, 'data');
  const repo = join(root, 'repo');
  const previous = process.env['AI_SM_DATA_DIR'];
  try {
    await mkdir(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    process.env['AI_SM_DATA_DIR'] = dataDir;
    const paths = resolveDataPaths();

    // prefs.json only switches the line on (off by factory default): the
    // cache file is what is being located, and it lives BESIDE this file.
    await writeFile(paths.prefsFile, JSON.stringify({ statusLine: { enabled: true } }));
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
    await removeTempDir(root);
  }
});

test('a detached HEAD reports no branch (never the word HEAD), and a non-repo cwd is silent', async () => {
  const ws = await makeWorkspace();
  try {
    await writeFile(ws.prefs, JSON.stringify({ statusLine: { enabled: true, model: false, mode: false, cost: false, context: false } }));
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
    await sleep(20);

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
