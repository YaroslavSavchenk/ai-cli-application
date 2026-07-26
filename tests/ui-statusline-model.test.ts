/**
 * `web/src/ui/statusline-model.ts` — the DOM-free config model behind the
 * settings panel's ONE section: what Claude Code's own status line shows.
 *
 * Two guarantees under test:
 *   1. The resolved toggles are byte-identical to what `server/statusline.mjs`
 *      resolves from the same bag. The script applies its own defaults for any
 *      member prefs.json does not carry, so a disagreement here would make the
 *      panel show one thing while the terminal draws another. The FACTORY table
 *      below is written out literally (not imported from either side) so a
 *      change on either side has to come here and be justified.
 *   2. `sessionsWithoutStatusLine` names exactly the sessions a relaunch would
 *      change — running, of the known agent, and lacking the injected settings
 *      file. Anything else must never be nagged about.
 *
 * State is a module singleton (node --test runs each *.test.ts in its own
 * process), so every test seeds it first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEAD_PREFS_KEYS,
  clampStatusLine,
  getStatusLine,
  initStatusLine,
  sessionsWithoutStatusLine,
  setStatusLine,
  statusLineDefaults,
  statusLinePatch,
  type StatusLineCfg,
} from '../web/src/ui/statusline-model.ts';
import type { SessionInfo } from '../shared/protocol.ts';

/** The factory set, transcribed from DEFAULT_CONFIG in server/statusline.mjs. */
const FACTORY: StatusLineCfg = {
  enabled: true,
  model: true,
  mode: true,
  branch: true,
  cost: true,
  lines: false,
  context: true,
  usage: false,
};

test('statusLineDefaults() is the factory set (ON: enabled/model/mode/branch/cost/context; OFF: lines/usage), returned by value', () => {
  assert.deepEqual(statusLineDefaults(), FACTORY);
  const a = statusLineDefaults();
  a.enabled = false;
  assert.equal(statusLineDefaults().enabled, true, 'callers cannot mutate the shared default');
});

test('the factory set matches server/statusline.mjs DEFAULT_CONFIG exactly — the panel and the drawn line must agree', () => {
  // Read from the script itself: the two tables are allowed to move, but only
  // together. A drift here means a toggle shows OFF while the item is drawn.
  const text = readFileSync(new URL('../server/statusline.mjs', import.meta.url), 'utf8');
  const block = /const DEFAULT_CONFIG = \{([^}]*)\}/.exec(text);
  assert.ok(block !== null, 'DEFAULT_CONFIG must still exist in server/statusline.mjs');
  const fromScript: Record<string, boolean> = {};
  for (const line of block[1].split('\n')) {
    const m = /^\s*(\w+):\s*(true|false),/.exec(line);
    if (m !== null) fromScript[m[1]] = m[2] === 'true';
  }
  assert.deepEqual(fromScript, FACTORY);
});

test('clampStatusLine with absent / garbage / wrong-shape input resolves to the full factory set', () => {
  for (const bad of [undefined, null, 'nope', 42, true, [1, 2, 3]]) {
    assert.deepEqual(clampStatusLine(bad), FACTORY, `input ${JSON.stringify(bad)} → factory`);
  }
});

test('clampStatusLine fills every key: a partial bag keeps its booleans and defaults the rest', () => {
  // Turn a normally-OFF item on and a normally-ON item off; leave the rest absent.
  assert.deepEqual(clampStatusLine({ usage: true, model: false }), {
    enabled: true,
    model: false, // explicitly off
    mode: true,
    branch: true,
    cost: true,
    lines: false,
    context: true,
    usage: true, // explicitly on
  });
});

test('EVERY key is individually resolvable — the internal key list can never fall behind the factory table', () => {
  // clampStatusLine only copies members it iterates. If a key were added to the
  // factory table but not to that list, the panel would silently refuse to store
  // that toggle while still rendering a row for it.
  for (const key of Object.keys(FACTORY) as (keyof StatusLineCfg)[]) {
    const flipped = !FACTORY[key];
    assert.deepEqual(
      clampStatusLine({ [key]: flipped }),
      { ...FACTORY, [key]: flipped },
      `\`${key}\` must survive the clamp on its own`,
    );
  }
});

test('clampStatusLine coerces per key: non-boolean members fall to their default, never a truthy/falsy string', () => {
  assert.deepEqual(
    clampStatusLine({ model: 'yes', usage: 1, lines: 'x', cost: null, enabled: {} }),
    FACTORY,
  );
});

test('clampStatusLine ignores foreign keys — a bag carrying the RETIRED per-pane items resolves to the factory set', () => {
  // `time`, `diff` and `skill` were the old strip's items and have no meaning
  // here; they must not leak into the object the script reads.
  const resolved = clampStatusLine({ time: true, diff: true, skill: true });
  assert.deepEqual(resolved, FACTORY);
  assert.deepEqual(Object.keys(resolved).sort(), Object.keys(FACTORY).sort());
});

test('init / get / set: seeding, replacing and copy-on-read', () => {
  initStatusLine({ usage: true });
  assert.equal(getStatusLine().usage, true);
  assert.equal(getStatusLine().enabled, true, 'absent members keep their factory value');

  setStatusLine({ enabled: false }); // REPLACES, then re-clamps
  assert.deepEqual(getStatusLine(), { ...FACTORY, enabled: false }, 'usage:true is gone, not merged');

  const got = getStatusLine();
  got.branch = false;
  assert.equal(getStatusLine().branch, true, 'mutating a returned copy must not poison the store');
});

test('a full explicit bag round-trips verbatim (the exact inverse of the defaults)', () => {
  const inverse: StatusLineCfg = {
    enabled: false,
    model: false,
    mode: false,
    branch: false,
    cost: false,
    lines: true,
    context: false,
    usage: true,
  };
  initStatusLine(inverse);
  assert.deepEqual(getStatusLine(), inverse);
});

test('statusLinePatch writes EVERY member explicitly under `statusLine` — absent would mean "factory", not "chosen"', () => {
  initStatusLine({ usage: true, context: false });
  const patch = statusLinePatch(getStatusLine());
  assert.deepEqual(Object.keys(patch), ['statusLine']);
  assert.deepEqual(patch.statusLine, { ...FACTORY, usage: true, context: false });
  // The patch is a copy: mutating it must not reach the store.
  (patch.statusLine as StatusLineCfg).enabled = false;
  assert.equal(getStatusLine().enabled, true);
});

test('DEAD_PREFS_KEYS names exactly the two retired bag keys', () => {
  assert.deepEqual([...DEAD_PREFS_KEYS], ['defaults', 'statusBar']);
});

// ---------------------------------------------------------------------------
// sessionsWithoutStatusLine — who the relaunch notice may name
// ---------------------------------------------------------------------------

function session(over: Partial<SessionInfo>): SessionInfo {
  return {
    id: 's',
    title: 'session',
    command: 'claude',
    args: [],
    cwd: '/home/sava/projects/web-ui',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: new Date().toISOString(),
    attention: false,
    ...over,
  };
}

test('names running claude sessions the server did NOT give a status line', () => {
  const list = [
    session({ id: 'a', title: 'auth-refactor' }), // statusline absent → predates it
    session({ id: 'b', title: 'api-tests', statusline: false }), // explicitly none
  ];
  assert.deepEqual(
    sessionsWithoutStatusLine(list).map((s) => s.title),
    ['auth-refactor', 'api-tests'],
  );
});

test('never names a session that HAS a status line', () => {
  assert.deepEqual(sessionsWithoutStatusLine([session({ statusline: true })]), []);
});

test('never names an EXITED session — relaunching one is the pane banner’s job, not a settings nag', () => {
  assert.deepEqual(sessionsWithoutStatusLine([session({ status: 'exited', exitCode: 0 })]), []);
});

test('never names a non-claude session — no other agent ever had a status line to miss', () => {
  const others = [
    session({ command: 'bash' }),
    session({ command: 'htop' }),
    session({ command: '/usr/bin/python3' }),
    session({ command: 'claude-code' }), // near-miss name, different program
    session({ command: 'notclaude' }),
  ];
  assert.deepEqual(sessionsWithoutStatusLine(others), []);
});

test('matches on the LAST path segment, exactly as the server decides it', () => {
  // server/sessions.ts spawns with basename(command) === 'claude', so an
  // absolute path to the same binary is the same case and must be named too.
  const list = [
    session({ id: 'p', title: 'abs-path', command: '/home/sava/.local/bin/claude' }),
    session({ id: 'q', title: 'relative', command: './claude' }),
  ];
  assert.deepEqual(
    sessionsWithoutStatusLine(list).map((s) => s.title),
    ['abs-path', 'relative'],
  );
});

test('an empty session set produces no notice at all', () => {
  assert.deepEqual(sessionsWithoutStatusLine([]), []);
  assert.deepEqual(sessionsWithoutStatusLine(new Map<string, SessionInfo>().values()), []);
});
