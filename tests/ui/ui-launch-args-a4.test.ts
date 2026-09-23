/**
 * `web/src/ui/launch-args.ts` — the Nocturne A4 dialog tables (2026-09-10):
 * the Tool, Shell and Permission cards, the Start from select, the display
 * labels and the permission help, plus the B12 tool marks and the B5 inert
 * hint. Every dialog state must emit the argv it emitted BEFORE A4, written out
 * literally, never derived from the code under test. Split out of
 * `ui-launch-args.test.ts`.
 *
 * Seam: the pure module, imported and called. `web/src/ui/launch-args.ts` is
 * deliberately DOM-free and xterm-free so plain `node --test` can import it;
 * an accidental DOM dependency would throw at import time here.
 *
 * Why it matters: the cards replaced segments and a checkbox; a card wired to
 * the wrong vocabulary value moves an argv byte and the session starts with
 * another model, mode or history — silently.
 *
 * NOT claimed: the DOM plumbing that fills the `LaunchForm` from the dialog's
 * controls (`tests/ui/ui-launch-dialog.test.ts`), or that the spawned CLI
 * accepts the argv (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import {
  composeArgs,
  MODELS,
  PERMS,
  PERM_SHORT,
  EFFORTS,
  AGENT_LABEL,
  KINDS,
  SHELLS,
  toolIconFor,
  composeSpawn,
  isKind,
  isShellId,
  shellSpawn,
  PERM_HELP,
  MODEL_LABEL,
  modelLabel,
  EFFORT_LABEL,
  NOT_INSTALLED,
  TOOL_CARDS,
  SHELL_CARDS,
  START_FROM,
  continueFromStart,
  isStartFrom,
  AGENT_KINDS,
  TOOLS,
  commandLabel,
} from '../../web/src/ui/launch-args.ts';
import { TOOL_ICON_PATHS } from '../../web/src/ui/icons-tools.ts';
import type {
  ShellId,
  SpawnSpec,
  StartFrom,
} from '../../web/src/ui/launch-args.ts';
import { assertPlainCopy, form } from '../helpers/ui-launch-args-fixture.ts';

// ---------------------------------------------------------------------------
// Nocturne A4 (2026-09-10): every dialog state -> the argv it emitted BEFORE
// ---------------------------------------------------------------------------
//
// The dialog took the v3 layout: a Tool card grid (replacing the Claude /
// Terminal / Other segments), Shell cards (replacing the two shell segments),
// Permission cards (replacing the mode segments) and a Start from select
// (replacing the "Continue last conversation" checkbox). None of that may move
// a single argv byte. The expectations below are written out LITERALLY — the
// argv the pre-A4 dialog produced for the same choice — never derived from the
// code under test.

/** The cards a user can actually pick, and the kind each one launches. */
test('A4/B5 tool cards: six cards in v3 order, every one of them launching a real kind', () => {
  assert.deepEqual(
    TOOL_CARDS.map((t) => [t.id, t.label, t.kind]),
    [
      ['claude', 'Claude Code', 'claude'],
      ['codex', 'Codex', 'codex'],
      ['gemini', 'Gemini CLI', 'gemini'],
      ['grok', 'Grok', 'grok'],
      ['terminal', 'Terminal', 'terminal'],
      ['other', 'Other', 'other'],
    ],
  );
  // Every kind has exactly one card, in the kind vocabulary's own order. Since
  // B5 no card is inert in the TABLE — what a card cannot do is decided at
  // runtime by what the backend finds on its PATH.
  assert.deepEqual(TOOL_CARDS.map((t) => t.kind), [...KINDS]);
  assert.equal(TOOL_CARDS[0].label, AGENT_LABEL, 'the agent card IS the agent product name');
});

test('A4 tool cards: each selectable card spawns exactly what its old segment spawned', () => {
  const byCard: Record<string, SpawnSpec | null> = {};
  for (const t of TOOL_CARDS) {
    byCard[t.id] = composeSpawn(form({ kind: t.kind, customLine: 'htop --tree' }));
  }
  assert.deepEqual(byCard, {
    claude: { command: 'claude', args: ['--model', 'opus'] },
    codex: { command: 'codex', args: ['-a', 'on-request', '-s', 'read-only'] },
    gemini: { command: 'gemini', args: [] },
    grok: { command: 'grok', args: [] },
    terminal: { command: '/bin/bash', args: ['-l'] },
    other: { command: 'htop', args: ['--tree'] },
  });
});

test('A4/B5 shell cards: four cards, each wired to its SHELLS entry byte for byte', () => {
  assert.deepEqual(
    SHELL_CARDS.map((c) => [c.id, c.label, c.sub, c.shell]),
    [
      ['bash', 'Bash', 'WSL', 'wsl'],
      ['zsh', 'Zsh', 'WSL', 'zsh'],
      ['powershell', 'PowerShell', 'Windows', 'powershell'],
      ['cmd', 'Command Prompt', 'Windows', 'cmd'],
    ],
  );
  const spawned: Record<string, SpawnSpec | null> = {};
  for (const c of SHELL_CARDS) {
    spawned[c.id] = composeSpawn(form({ kind: 'terminal', shell: c.shell }));
  }
  assert.deepEqual(spawned, {
    bash: { command: '/bin/bash', args: ['-l'] },
    zsh: { command: 'zsh', args: ['-l'] },
    // v3 draws `pwsh.exe`; the app keeps today's argv (not adopted in A4).
    powershell: { command: 'powershell.exe', args: ['-NoLogo'] },
    cmd: { command: 'cmd.exe', args: [] },
  });
  // Every shell has exactly one card, in the SHELLS order.
  assert.deepEqual(SHELL_CARDS.map((c) => c.shell), SHELLS.map((s) => s.id));
});

test('A4 Start from: `The last conversation in this project` IS the old checkbox — --continue, last', () => {
  assert.deepEqual(
    START_FROM.map((s) => [s.value, s.label]),
    [
      ['fresh', 'A fresh conversation'],
      ['continue', 'The last conversation in this project'],
    ],
  );
  assert.equal(continueFromStart('fresh'), false);
  assert.equal(continueFromStart('continue'), true);
  // Anything the select could not have produced is a fresh start, never a resume.
  for (const odd of ['', 'Continue', 'resume', 'last']) assert.equal(continueFromStart(odd), false, odd);
  for (const s of START_FROM) assert.ok(isStartFrom(s.value));
  for (const bad of ['', 'resume', 'CONTINUE', 1, null, undefined]) assert.equal(isStartFrom(bad), false);

  assert.deepEqual(composeSpawn(form({ continueLast: continueFromStart('continue') })), {
    command: 'claude',
    args: ['--model', 'opus', '--continue'],
  });
  assert.deepEqual(composeSpawn(form({ continueLast: continueFromStart('fresh') })), {
    command: 'claude',
    args: ['--model', 'opus'],
  });
  // The checkbox's hardest case, now reached through the select.
  assert.deepEqual(
    composeSpawn(
      form({ model: 'fable', perm: 'bypassPermissions', effort: 'xhigh', continueLast: continueFromStart('continue') }),
    ),
    {
      command: 'claude',
      args: ['--model', 'fable', '--permission-mode', 'bypassPermissions', '--effort', 'xhigh', '--continue'],
    },
  );
});

test('A4 full matrix: model x permission card x effort x Start from -> the pre-A4 argv, spelled out', () => {
  // Pre-A4 recipe, written independently of composeArgs: `claude --model <m>`,
  // then `--permission-mode <p>` unless always-ask, then `--effort <e>` unless
  // default, then `--continue` when the checkbox (now: Start from) said so.
  let n = 0;
  for (const m of MODELS) {
    for (const p of PERMS) {
      for (const e of EFFORTS) {
        for (const s of START_FROM) {
          const expected: string[] = ['--model', m];
          if (p.mode !== 'default') expected.push('--permission-mode', p.mode);
          if (e !== 'default') expected.push('--effort', e);
          if (s.value === 'continue') expected.push('--continue');
          const got = composeSpawn(
            form({ model: m, perm: p.mode, effort: e, continueLast: continueFromStart(s.value) }),
          );
          assert.deepEqual(got, { command: 'claude', args: expected }, `${m}/${p.mode}/${e}/${s.value}`);
          n++;
        }
      }
    }
  }
  assert.equal(n, 4 * 4 * 6 * 2, 'the matrix must really cover every state');
});

test('A4 other card: the custom line with and without a project spawns what it always did', () => {
  // The project never enters argv (it is the cwd); pinned here so a future
  // card-level refactor cannot start threading it through composeSpawn.
  assert.deepEqual(composeSpawn(form({ kind: 'other', customLine: '/bin/echo hi' })), {
    command: '/bin/echo',
    args: ['hi'],
  });
  assert.equal(composeSpawn(form({ kind: 'other', customLine: '' })), null);
});

test('A4 display labels: capitalised model and effort words, the VALUES unchanged', () => {
  assert.deepEqual(MODEL_LABEL, { opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku', fable: 'Fable' });
  assert.deepEqual(EFFORT_LABEL, {
    default: 'Default',
    low: 'Low',
    medium: 'Medium',
    high: 'High',
    xhigh: 'Extra high',
    max: 'Max',
  });
  // Total over the vocabularies — a value without a label would render empty.
  for (const m of MODELS) assert.equal(typeof MODEL_LABEL[m], 'string');
  for (const e of EFFORTS) assert.equal(typeof EFFORT_LABEL[e], 'string');
});

test('A4 copy rule: no label the dialog shows ever reaches argv, and every one is plain copy', () => {
  const shown: string[] = [
    ...Object.values(MODEL_LABEL),
    ...Object.values(EFFORT_LABEL),
    ...Object.values(PERM_SHORT),
    ...TOOL_CARDS.flatMap((t) => [t.label, t.sub]),
    ...SHELL_CARDS.flatMap((c) => [c.label, c.sub]),
    ...START_FROM.map((s) => s.label),
    ...AGENT_KINDS.flatMap((k) => [
      ...TOOLS[k].models.map((m) => m.label),
      ...TOOLS[k].efforts.map((e) => e.label),
      ...TOOLS[k].starts.map((s) => s.label),
      ...TOOLS[k].inertPerms.map((p) => p.hint),
    ]),
    NOT_INSTALLED,
  ];
  for (const text of shown) {
    assertPlainCopy(text, 'dialog label');
    for (const sep of ['·', '—', ' | ']) assert.equal(text.includes(sep), false, `separator in ${text}`);
  }
  // Across the whole matrix, argv carries values only — never a display word.
  const displayOnly = new Set(
    shown.filter((t) => !(MODELS as readonly string[]).includes(t) && !(EFFORTS as readonly string[]).includes(t)),
  );
  for (const m of MODELS) {
    for (const p of PERMS) {
      for (const e of EFFORTS) {
        const args = composeArgs(m, p.mode, true, e);
        for (const a of args) assert.equal(displayOnly.has(a), false, `display word ${a} reached argv`);
      }
    }
  }
});

test('B12 marks: every tile is a real logo, one per tool, each agent its own LobeHub mark', () => {
  assert.deepEqual(
    TOOL_CARDS.map((t) => [t.kind, t.icon]),
    [
      ['claude', 'claude'],
      ['codex', 'codex'],
      ['gemini', 'gemini'],
      ['grok', 'grok'],
      ['terminal', 'terminal'],
      ['other', 'command'],
    ],
  );
  // Every mark a card can name has path data (icons-tools.ts, a Record over
  // the id union — this is the runtime half of that guarantee).
  for (const t of TOOL_CARDS) {
    const p = TOOL_ICON_PATHS[t.icon];
    assert.ok(p !== undefined && p.d.length > 20, `${t.id}: ${t.icon} has a path`);
    assert.ok(p.vb === 24 || p.vb === 256, `${t.icon}: a known grid`);
  }
});

test('B12 toolIconFor: a session wears its tool by command basename; a shell the terminal; the rest the command mark', () => {
  assert.equal(toolIconFor('claude'), 'claude');
  assert.equal(toolIconFor('/usr/local/bin/claude'), 'claude', 'basename, like commandLabel');
  assert.equal(toolIconFor('C:\\tools\\claude'), 'claude', 'both separators');
  assert.equal(toolIconFor('codex'), 'codex');
  assert.equal(toolIconFor('/home/you/.npm/bin/gemini'), 'gemini');
  assert.equal(toolIconFor('grok'), 'grok');
  for (const sh of SHELLS) assert.equal(toolIconFor(sh.command), 'terminal', sh.command);
  assert.equal(toolIconFor('/usr/bin/bash'), 'command', 'not this app\'s Bash card: exact shells only, as shellLabel');
  assert.equal(toolIconFor('htop'), 'command');
  assert.equal(toolIconFor(''), 'command');
  assert.equal(toolIconFor('toString'), 'command', 'no prototype lookups');
  assert.equal(toolIconFor('claude-code'), 'command', 'a basename, not a prefix');
  // Every id it can return has a path.
  for (const id of ['claude', 'codex', 'gemini', 'grok', 'terminal', 'command'] as const) {
    assert.ok(TOOL_ICON_PATHS[id].d.length > 20, id);
  }
  assert.deepEqual(Object.keys(TOOL_ICON_PATHS).sort(), ['claude', 'codex', 'command', 'gemini', 'grok', 'terminal']);
});

test('B12 toolIconFor, the edges: prototype keys, odd paths, case, and the same verdict as commandLabel', () => {
  for (const c of ['constructor', '__proto__', 'hasOwnProperty', 'valueOf', '/usr/bin/constructor']) {
    assert.equal(toolIconFor(c), 'command', `${c}: no prototype lookups`);
  }
  assert.equal(toolIconFor('./codex'), 'codex', 'a relative path is still its basename');
  assert.equal(toolIconFor('..\\bin\\grok'), 'grok');
  assert.equal(toolIconFor('C:/Users/you/AppData/Roaming/npm/gemini'), 'gemini', 'forward slashes on a Windows path');
  assert.equal(toolIconFor('claude/'), 'command', 'a trailing separator leaves no basename to claim');
  assert.equal(toolIconFor('Claude'), 'command', 'case-sensitive, as commandLabel and isClaudeCommand');
  assert.equal(toolIconFor('claude.exe'), 'command', 'an exact basename, no extension guessing');
  assert.equal(toolIconFor(' claude'), 'command', 'no trimming of what the user typed');
  assert.equal(toolIconFor('bash'), 'command', 'bare `bash` is not the app’s `/bin/bash` card');
  assert.equal(toolIconFor('/usr/bin/zsh'), 'command', 'and a path to zsh is not its bare `zsh` card');
  assert.equal(toolIconFor('C:\\Windows\\System32\\cmd.exe'), 'command', 'the shell rule is exact-command, not basename');
  // The icon and the label never disagree about whether a command is KNOWN:
  // a mark other than `command` exactly when the label is not the raw command.
  const cases = [
    'claude', '/opt/claude', 'codex', 'gemini', 'grok', '/bin/bash', 'zsh', 'powershell.exe', 'cmd.exe',
    'htop', 'bash', 'Claude', 'claude-code', 'toString', '__proto__', '', 'python3 -m http.server',
  ];
  for (const c of cases) {
    assert.equal(toolIconFor(c) !== 'command', commandLabel(c) !== c, `${JSON.stringify(c)}: icon and label agree`);
  }
});

test('B5 inert hint: one plain string, and `Not available yet` is gone from the whole frontend', () => {
  assert.equal(NOT_INSTALLED, 'Not installed');
  assertPlainCopy(NOT_INSTALLED, 'inert hint');
  // Nothing in the card TABLES is inert any more: availability is a runtime
  // answer (GET /api/tools), rendered by the dialog.
  assert.deepEqual(TOOL_CARDS.filter((t) => !isKind(t.kind)), []);
  assert.deepEqual(SHELL_CARDS.filter((c) => !isShellId(c.shell)), []);
  // The retired string may not survive anywhere in the frontend (the janitor
  // item in .claude/plans/nocturne/PLAN-B5.md's final gate).
  const webSrc = new URL('../../web/src/', import.meta.url);
  const walk = (dir: URL): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(new URL(`${e.name}/`, dir))
        : e.name.endsWith('.ts')
          ? [readFileSync(new URL(e.name, dir), 'utf8')]
          : [],
    );
  const offenders = walk(webSrc).filter((src) => src.includes('Not available yet'));
  assert.equal(offenders.length, 0, '`Not available yet` must be gone from web/src');
});

test('A4 permission help: the ONE explanation, one short plain line per mode, total over PERMS', () => {
  assert.deepEqual(PERM_HELP, {
    default: 'Asks before every edit or command.',
    acceptEdits: 'Edits files without asking. Still asks before commands.',
    plan: 'Reads and plans. Changes nothing.',
    bypassPermissions: 'Does everything without asking. Use with care.',
  });
  for (const p of PERMS) {
    const line = PERM_HELP[p.mode];
    assert.equal(typeof line, 'string', p.mode);
    assertPlainCopy(line, 'permission help');
    assert.equal(line.includes('\n'), false, 'one line per mode');
    assert.ok(line.length <= 60, `short: ${line}`);
    for (const sep of ['·', '—', ' | ']) assert.equal(line.includes(sep), false, `separator in ${line}`);
    // It explains the mode in words; it never names the CLI value (only the
    // camelCase ones are checkable — `plan` and `default` are English words).
    for (const v of ['acceptEdits', 'bypassPermissions']) {
      assert.equal(line.includes(v), false, `${p.mode}: help names ${v}`);
    }
  }
});

test('type-level guard: StartFrom is the literal union the select binds to', () => {
  const starts: StartFrom[] = ['fresh', 'continue'];
  assert.deepEqual(starts, START_FROM.map((s) => s.value));
});

// ---------------------------------------------------------------------------
// Nocturne A4 gate additions (test-engineer, 2026-09-10): the rules the card
// and label tables must keep, stated as rules rather than as one snapshot.
// ---------------------------------------------------------------------------

test('A4 cards: every card holds a REAL vocabulary value; ids and labels are unique per grid', () => {
  for (const t of TOOL_CARDS) assert.ok(isKind(t.kind), `${t.id} -> ${t.kind}`);
  for (const c of SHELL_CARDS) assert.ok(isShellId(c.shell), `${c.id} -> ${c.shell}`);
  for (const grid of [TOOL_CARDS, SHELL_CARDS] as const) {
    const ids = grid.map((c) => c.id);
    const labels = grid.map((c) => c.label);
    assert.equal(new Set(ids).size, ids.length, `duplicate id in ${ids.join(',')}`);
    assert.equal(new Set(labels).size, labels.length, `duplicate label in ${labels.join(',')}`);
  }
  // No two cards launch the same thing: one card per kind, one per shell.
  const kinds = TOOL_CARDS.map((t) => t.kind);
  const shells = SHELL_CARDS.map((c) => c.shell);
  assert.equal(new Set(kinds).size, kinds.length);
  assert.equal(new Set(shells).size, shells.length);
});

test('A4 card ids are never vocabulary values: a smuggled card id falls back to the WSL shell', () => {
  // A CARD id and a VALUE id are separate layers (`bash` is the card, `wsl` the
  // shell). The only way a card could launch the wrong thing is its id leaking
  // into a value slot; every guard refuses it, and shellSpawn's fallback is the
  // first real shell — never nothing.
  assert.equal(isShellId('bash'), false);
  assert.deepEqual(shellSpawn('bash' as ShellId), { command: '/bin/bash', args: ['-l'] });
  // The tool cards' ids DO equal their kinds since B5 — stated, so a future
  // rename of one without the other shows up here.
  assert.deepEqual(TOOL_CARDS.map((t) => t.id), TOOL_CARDS.map((t) => t.kind));
});

test('A4 card copy never names a command, a path or a flag (sub-lines included)', () => {
  const words = [
    ...TOOL_CARDS.flatMap((t) => [t.label, t.sub]),
    ...SHELL_CARDS.flatMap((c) => [c.label, c.sub]),
  ];
  for (const w of words) {
    assertPlainCopy(w, 'card copy');
    assert.equal(w.includes('/'), false, `a path in card copy: ${w}`);
    assert.equal(w.includes('\\'), false, `a path in card copy: ${w}`);
    assert.equal(/\.exe\b/i.test(w), false, `an executable in card copy: ${w}`);
    assert.equal(/(^|\s)-{1,2}[A-Za-z]/.test(w), false, `a flag in card copy: ${w}`);
    for (const s of SHELLS) assert.equal(w.includes(s.command), false, `${w} names ${s.command}`);
    assert.equal(/\bclaude\b/.test(w), false, `the lowercase command name in card copy: ${w}`);
  }
});

test('A4 Start from: the FIRST option (what a select shows when nothing else is chosen) never continues', () => {
  // open() resets the select to `fresh`; if that value ever vanished, a real
  // <select> would fall back to its first option — which therefore must be
  // the fresh start, or a reopened dialog would silently send --continue.
  assert.equal(START_FROM[0].value, 'fresh');
  assert.equal(continueFromStart(START_FROM[0].value), false);
  assert.equal(START_FROM.filter((s) => continueFromStart(s.value)).length, 1, 'exactly one option continues');
  // continueFromStart only ever says yes to a value the select can hold.
  for (const v of ['continue', 'fresh', '', 'Continue', ' continue', 'continue ', 'resume', 'The last conversation in this project']) {
    if (continueFromStart(v)) assert.ok(isStartFrom(v), v);
  }
  // The LABEL is never mistaken for the value (a label-valued option would do exactly this).
  for (const s of START_FROM) assert.equal(continueFromStart(s.label), false, s.label);
});

test('A4 select labels: MODEL_LABEL and EFFORT_LABEL are keyed by exactly their vocabulary, in order, all distinct', () => {
  assert.deepEqual(Object.keys(MODEL_LABEL), [...MODELS]);
  assert.deepEqual(Object.keys(EFFORT_LABEL), [...EFFORTS]);
  for (const table of [MODEL_LABEL, EFFORT_LABEL] as Record<string, string>[]) {
    const labels = Object.values(table);
    assert.equal(new Set(labels).size, labels.length, `two options would read the same: ${labels.join(', ')}`);
    for (const l of labels) {
      assertPlainCopy(l, 'select label');
      assert.ok(l.trim() === l && l.length > 0, JSON.stringify(l));
    }
  }
  // A label is never itself a DIFFERENT vocabulary value (a select that shows
  // `high` for `xhigh` would read as a lie).
  for (const [k, l] of Object.entries(EFFORT_LABEL)) {
    for (const v of EFFORTS) if (v !== k) assert.notEqual(l.toLowerCase(), v, `${k} reads as ${v}`);
  }
});

test('modelLabel: a known model id reads as its MODEL_LABEL; any other value is echoed verbatim', () => {
  for (const m of MODELS) assert.equal(modelLabel(m), MODEL_LABEL[m], m);
  assert.equal(modelLabel('opus'), 'Opus');
  // A custom command's own --model value is never relabelled by resemblance.
  for (const raw of ['Opus', 'OPUS', 'opus ', 'claude-opus-4-1', 'gpt-5', '']) assert.equal(modelLabel(raw), raw, raw);
  // A value that names an Object.prototype member must not be looked up in the
  // table (`MODEL_LABEL[id] ?? id` would render `function toString() {...}` in
  // the drawer for a custom `--model toString`); only the MODELS guard admits a key.
  for (const raw of ['toString', 'constructor', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(modelLabel(raw), raw, raw);
  }
});

test('B5 modelLabel: EVERY tool`s model id reads as the word its dialog select showed', () => {
  // The pane status bar, the sessions drawer and the Earlier rows read `-m`
  // now, so a Codex / Gemini / Grok model must not reach them as a raw CLI id.
  for (const kind of AGENT_KINDS) {
    for (const m of TOOLS[kind].models) assert.equal(modelLabel(m.id), m.label, `${kind} ${m.id}`);
  }
  assert.equal(modelLabel('gpt-6-astra'), 'GPT-6 Astra');
  assert.equal(modelLabel('pro'), 'Pro');
  assert.equal(modelLabel('grok-4.6'), 'Grok 4.6');
  assert.equal(modelLabel('opus'), 'Opus', 'claude unchanged');
});

test('B5 model ids: one id never means two different words across the four tables', () => {
  // modelLabel is ONE table over all four tools, so a shared id (`default`)
  // must carry the same label everywhere, or the same word on screen would
  // mean two things — and `pro` could read as a Codex model.
  const seen = new Map<string, string>();
  for (const kind of AGENT_KINDS) {
    for (const m of TOOLS[kind].models) {
      const prev = seen.get(m.id);
      if (prev !== undefined) assert.equal(m.label, prev, `${m.id} reads two ways`);
      seen.set(m.id, m.label);
    }
  }
  // The ids that appear twice are exactly the sentinels that emit NOTHING, so
  // no argv (and therefore no status bar) can ever carry them.
  const counts = new Map<string, number>();
  for (const kind of AGENT_KINDS) {
    for (const m of TOOLS[kind].models) counts.set(m.id, (counts.get(m.id) ?? 0) + 1);
  }
  for (const [id, n] of counts) {
    if (n > 1) {
      const owners = AGENT_KINDS.filter((k) => TOOLS[k].models.some((m) => m.id === id));
      for (const k of owners) assert.equal(TOOLS[k].modelNone, id, `${k} emits ${id}`);
    }
  }
});

test('A4 PERM_HELP: plain sentences, one per mode, naming no flag, command or CLI value', () => {
  assert.deepEqual(Object.keys(PERM_HELP), PERMS.map((p) => p.mode));
  const lines = PERMS.map((p) => PERM_HELP[p.mode]);
  assert.equal(new Set(lines).size, lines.length, 'each mode explains itself differently');
  const banned = [
    'claude',
    'permission-mode',
    'permission mode',
    'dangerously',
    'skip-permissions',
    'bypass',
    'acceptedits',
    'bypasspermissions',
    'plan mode',
    '--',
    '`',
    '$',
  ];
  for (const p of PERMS) {
    const line = PERM_HELP[p.mode];
    assert.match(line, /^[A-Z][^\n]*\.$/, `${p.mode}: one sentence-cased line ending in a full stop`);
    for (const b of banned) assert.equal(line.toLowerCase().includes(b), false, `${p.mode}: names ${b}`);
    // It explains; it does not repeat another mode's label as if it were that mode.
    for (const q of PERMS) {
      if (q.mode !== p.mode) assert.equal(line.includes(PERM_SHORT[q.mode]), false, `${p.mode} quotes ${q.mode}`);
    }
  }
  // The danger mode's line carries the caution; no other line does.
  assert.ok(/care/i.test(PERM_HELP.bypassPermissions));
  for (const p of PERMS) if (!p.danger) assert.equal(/care|danger/i.test(PERM_HELP[p.mode]), false, p.mode);
});
