/**
 * `web/src/ui/launch.ts` — the New session dialog's Nocturne B5 half
 * (2026-09-18): tool availability (`GET /api/tools` → inert `Not installed`
 * cards), the per-tool controls of Codex, Gemini and Grok with their argv
 * byte-exact through the DOM, the missing-key notice and its `Add key`, and
 * Start from listing THIS project's ended conversations (`--resume <id>`).
 * Split out of `ui-launch-dialog.test.ts`.
 *
 * Why it matters: an enabled card for a tool that is not installed, a value
 * from one tool's table in another tool's argv, or a dialog that silently
 * resumes a conversation all keep the pure-function tests green.
 *
 * HOW IT RUNS WITHOUT A BROWSER OR A DEPENDENCY: the harness in
 * `tests/helpers/ui-launch-dialog-fixture.ts` — its own small DOM double, the
 * four stubbed imports of launch.ts (`../api.ts`, `../state.ts`, `../log.ts`,
 * `./panes.ts`, plus `./settings.ts`), and ONE real dialog mounted per test
 * file. `./util.ts`, `./icons.ts` and `./launch-args.ts` are the REAL
 * modules.
 *
 * NOT claimed (stays with `.claude/skills/verify-terminal/SKILL.md` and the
 * browser): layout, CSS (including whether a hidden control is really
 * invisible), real pointer hit-testing, screen-reader output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  NOT_INSTALLED,
  TOOLS,
  GROK_PERM_HINT,
} from '../../web/src/ui/launch-args.ts';
import type { KeyStatus, HistoryEntry } from '../../shared/protocol.ts';
import {
  ALL_TOOLS,
  body,
  buttonText,
  byName,
  checked,
  descendants,
  doc,
  errBox,
  FakeElement,
  FakeNode,
  FakeText,
  H,
  L,
  launch,
  type LaunchModule,
  launchUrl,
  one,
  openReady,
  openWith,
  permCard,
  pickByLabel,
  press,
  PROJ,
  type Project,
  scrim,
  settle,
  shellCard,
  startBtn,
  tool,
  type,
  userClick,
} from '../helpers/ui-launch-dialog-fixture.ts';

// ===========================================================================
// Nocturne B5 (2026-09-18): availability, per-tool controls, keys, resume
// ===========================================================================

const noKeys: KeyStatus = {
  saved: { claude: false, gemini: false, grok: false },
  env: { claude: false, gemini: false, grok: false },
};

/** One ended, resumable Claude conversation. */
function conv(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'conv-a',
    conversation: true,
    sessionId: 's1',
    projectId: 'p1',
    cwd: '/home/tester/demo-api',
    command: 'claude',
    args: ['--model', 'opus'],
    title: 'auth refactor',
    createdAt: '2026-09-17T10:00:00Z',
    lastUsedAt: '2026-09-17T10:00:00Z',
    ended: { at: '2026-09-17T11:00:00Z', reason: 'exit' },
    ...over,
  } as HistoryEntry;
}

const startOpts = (): [string, string][] =>
  byName('start').options.map((o) => [o.value, o.textContent]);

test('B5 availability: an open with the answer still in flight flashes NO enabled card', async () => {
  // A FRESH module instance, so this holds whatever ran before it: the very
  // FIRST dialog a page opens, GET /api/tools never answered. No settle — this
  // is the dialog in the moment it opens. What is on screen is what it ASSUMES
  // (the pre-B5 set), never an optimistic grid that then goes dark, and the
  // cards it cannot vouch for carry NO sub-line: inert, claiming nothing.
  const first = (await import(`${launchUrl}?first-open`)) as LaunchModule;
  const host = new FakeElement('div');
  body.append(host);
  H.tools = ALL_TOOLS;
  H.projects = [PROJ];
  first.initLaunchDialog(host);
  first.openLaunchDialog();
  /** A card of the FRESH dialog, by the words on its label line. */
  const firstCard = (label: string): FakeElement => {
    const hits = descendants(host).filter(
      (n) =>
        n.classList.contains('ns-card') &&
        descendants(n).some((d) => d.classList.contains('ns-card-lb') && d.textContent === label),
    );
    assert.equal(hits.length, 1, `card "${label}"`);
    return hits[0] as FakeElement;
  };
  for (const label of ['Codex', 'Gemini CLI', 'Grok', 'Zsh', 'Command Prompt']) {
    const c = firstCard(label);
    assert.equal(c.getAttribute('aria-disabled'), 'true', label);
    assert.equal(c.textContent.includes(NOT_INSTALLED), false, `${label} claims nothing yet`);
  }
  for (const label of ['Claude Code', 'Terminal', 'Other', 'Bash', 'PowerShell']) {
    assert.equal(firstCard(label).getAttribute('aria-disabled'), null, label);
  }
  first.closeLaunchDialog();
});

test('B5 availability: an absent executable makes an INERT card that says `Not installed`', async () => {
  await openReady({ tools: { grok: false, zsh: false } });
  for (const [label, live] of [
    ['Claude Code', true],
    ['Codex', true],
    ['Gemini CLI', true],
    ['Grok', false],
  ] as [string, boolean][]) {
    const c = tool(label);
    assert.equal(c.getAttribute('aria-disabled'), live ? null : 'true', label);
    assert.equal(c.textContent.includes(NOT_INSTALLED), !live, label);
  }
  userClick(tool('Terminal'));
  assert.equal(shellCard('Zsh').getAttribute('aria-disabled'), 'true');
  assert.ok(shellCard('Zsh').textContent.includes(NOT_INSTALLED));
  assert.equal(shellCard('Command Prompt').getAttribute('aria-disabled'), null);
  assert.ok(shellCard('Command Prompt').textContent.includes('Windows'), 'a live card keeps its own sub-line');
  // A press on an inert card does nothing and does not even take focus.
  const before = doc.activeElement;
  userClick(tool('Grok'));
  assert.equal(checked(tool('Grok')), false);
  assert.equal(doc.activeElement, before);
});

test('B5 availability: the arrows skip an absent tool, and the answer can put a card BACK', async () => {
  await openReady({ tools: { codex: false, gemini: false } });
  userClick(tool('Claude Code'));
  press('ArrowRight');
  assert.equal(doc.activeElement, tool('Grok'), 'Codex and Gemini CLI are skipped');
  // The next open finds them installed: the same cards are live again.
  await openReady({});
  userClick(tool('Claude Code'));
  press('ArrowRight');
  assert.equal(doc.activeElement, tool('Codex'));
  assert.equal(tool('Codex').getAttribute('aria-disabled'), null);
  assert.ok(tool('Codex').textContent.includes('OpenAI'), 'the card gets its own sub-line back');
});

test('B5 availability: a failed ask keeps the last known answer rather than blanking the grid', async () => {
  await openReady({});
  assert.equal(tool('Codex').getAttribute('aria-disabled'), null);
  H.toolsFail = true;
  L.closeLaunchDialog();
  L.openLaunchDialog();
  await settle();
  H.toolsFail = false;
  assert.equal(tool('Codex').getAttribute('aria-disabled'), null, 'still live: nothing new was learned');
});

test('B5 availability: a selection that goes away moves to the first live card, never stays dead', async () => {
  await openReady({});
  userClick(tool('Grok'));
  assert.ok(checked(tool('Grok')));
  L.closeLaunchDialog();
  H.tools = { ...ALL_TOOLS, grok: false, claude: false };
  L.openLaunchDialog();
  await settle();
  assert.equal(checked(tool('Grok')), false);
  assert.ok(checked(tool('Codex')), 'the first card that can actually launch');
});

test('B5 Codex: the whole form through the DOM, argv byte-exact', async () => {
  await openReady({});
  userClick(tool('Codex'));
  assert.deepEqual(
    byName('model').options.map((o) => [o.value, o.textContent]),
    TOOLS.codex.models.map((m) => [m.id, m.label]),
  );
  assert.deepEqual(
    byName('effort').options.map((o) => [o.value, o.textContent]),
    TOOLS.codex.efforts.map((e) => [e.id, e.label]),
  );
  assert.deepEqual(startOpts(), [
    ['fresh', 'A fresh session'],
    ['last', 'The last session'],
    ['pick', 'Pick an earlier session'],
  ]);
  pickByLabel(byName('model'), 'GPT-5.6 Sol');
  userClick(permCard('Auto edits'));
  pickByLabel(byName('effort'), 'High');
  pickByLabel(byName('start'), 'The last session');
  assert.deepEqual(await launch(), {
    projectId: 'p1',
    command: 'codex',
    args: [
      '-m', 'gpt-5.6-sol',
      '-a', 'on-request', '-s', 'workspace-write',
      '-c', 'model_reasoning_effort=high',
      'resume', '--last',
    ],
    cols: 120,
    rows: 40,
  });
});

test('B5 Gemini: the Effort control leaves the form entirely, and the argv follows the table', async () => {
  await openReady({});
  userClick(tool('Gemini CLI'));
  assert.equal(byName('effort').rendered, false, 'hidden');
  assert.equal(byName('effort').disabled, true, 'and disabled — nothing hidden is reachable');
  assert.deepEqual(
    byName('model').options.map((o) => [o.value, o.textContent]),
    [['auto', 'Auto'], ['pro', 'Pro'], ['flash', 'Flash'], ['flash-lite', 'Flash Lite']],
  );
  assert.deepEqual(startOpts(), [
    ['fresh', 'A fresh session'],
    ['last', 'The last session'],
  ]);
  // Untouched: Auto and Always ask both emit nothing at all.
  assert.deepEqual(await launch(), { projectId: 'p1', command: 'gemini', args: [], cols: 120, rows: 40 });
  await openReady({});
  userClick(tool('Gemini CLI'));
  pickByLabel(byName('model'), 'Flash Lite');
  userClick(permCard('No prompts'));
  pickByLabel(byName('start'), 'The last session');
  assert.deepEqual((await launch())?.args, ['-m', 'flash-lite', '--approval-mode', 'yolo', '-r', 'latest']);
  // And the control comes BACK for a tool that has levels.
  await openReady({});
  userClick(tool('Gemini CLI'));
  userClick(tool('Grok'));
  assert.equal(byName('effort').rendered, true);
  assert.equal(byName('effort').disabled, false);
});

test('B5 Grok: Auto edits and Read only are inert cards carrying the hint; the arrows skip them', async () => {
  await openReady({});
  userClick(tool('Grok'));
  for (const label of ['Auto edits', 'Read only']) {
    const c = permCard(label);
    assert.equal(c.getAttribute('aria-disabled'), 'true', label);
    assert.equal(c.tabIndex, -1, label);
    assert.ok(c.textContent.includes(GROK_PERM_HINT), `${label} carries the hint`);
    userClick(c);
    assert.equal(checked(c), false, `${label} never becomes selected`);
  }
  assert.ok(checked(permCard('Always ask')));
  userClick(permCard('Always ask'));
  press('ArrowRight');
  assert.ok(checked(permCard('No prompts')), 'the two inert cards are skipped');
  assert.deepEqual((await launch())?.args, ['--always-approve']);
  // Back on a tool that takes all four, the cards are live again with no hint.
  await openReady({});
  userClick(tool('Grok'));
  userClick(tool('Claude Code'));
  for (const label of ['Auto edits', 'Read only']) {
    assert.equal(permCard(label).getAttribute('aria-disabled'), null, label);
    assert.equal(permCard(label).textContent, label, `${label} drops the hint`);
  }
});

test('B5 Grok: a permission already chosen is dropped when the tool cannot be told it', async () => {
  await openReady({});
  userClick(tool('Claude Code'));
  userClick(permCard('Read only'));
  userClick(tool('Grok'));
  assert.ok(checked(permCard('Always ask')), 'never silently kept as an unreachable mode');
  assert.deepEqual((await launch())?.args, []);
});

test('B5 per-tool memory: a level chosen for one tool never reaches another', async () => {
  await openReady({});
  userClick(tool('Codex'));
  pickByLabel(byName('model'), 'GPT-6 Astra');
  pickByLabel(byName('effort'), 'Extra high');
  userClick(tool('Grok'));
  assert.equal(byName('model').value, 'default', 'Grok starts at its own default');
  assert.equal(byName('effort').value, 'default');
  pickByLabel(byName('effort'), 'Medium');
  userClick(tool('Codex'));
  assert.equal(byName('model').value, 'gpt-6-astra', 'Codex kept what was chosen for Codex');
  assert.equal(byName('effort').value, 'xhigh');
  assert.deepEqual((await launch())?.args, [
    '-m', 'gpt-6-astra', '-a', 'on-request', '-s', 'read-only', '-c', 'model_reasoning_effort=xhigh',
  ]);
});

test('B5 Terminal: the Zsh and Command Prompt cards spawn their argv byte for byte', async () => {
  await openReady({});
  userClick(tool('Terminal'));
  userClick(shellCard('Zsh'));
  assert.deepEqual(await launch(), { projectId: 'p1', command: 'zsh', args: ['-l'], cols: 120, rows: 40 });
  await openReady({});
  userClick(tool('Terminal'));
  userClick(shellCard('Command Prompt'));
  // NO args: the server appends the tail that walks cmd.exe into the folder.
  assert.deepEqual(await launch(), { projectId: 'p1', command: 'cmd.exe', args: [], cols: 120, rows: 40 });
  // With no project, the card's product name titles the session — never a path.
  await openReady({ projects: [] });
  userClick(tool('Terminal'));
  userClick(shellCard('Command Prompt'));
  assert.deepEqual(await launch(), {
    cwd: '/home/tester',
    command: 'cmd.exe',
    args: [],
    title: 'Command Prompt',
    cols: 120,
    rows: 40,
  });
});

test('B5 notice: shown for Gemini CLI and Grok with no key, and for nothing else', async () => {
  const noticeEl = (): FakeElement => one('key notice', (n) => n.classList.contains('ns-notice'));
  await openReady({ keys: noKeys });
  for (const [label, shown] of [
    ['Claude Code', false],
    ['Codex', false],
    ['Gemini CLI', true],
    ['Grok', true],
    ['Terminal', false],
    ['Other', false],
  ] as [string, boolean][]) {
    userClick(tool(label));
    assert.equal(noticeEl().rendered, shown, label);
  }
  userClick(tool('Gemini CLI'));
  assert.equal(
    noticeEl().children[0]?.textContent,
    'Needs an API key, or sign in inside the terminal the first time.',
  );
  assert.equal(buttonText('Add key').rendered, true);
});

test('B5 notice: a saved key or one already in the environment silences it', async () => {
  await openReady({
    keys: { saved: { claude: false, gemini: true, grok: false }, env: { claude: false, gemini: false, grok: false } },
  });
  const noticeEl = (): FakeElement => one('key notice', (n) => n.classList.contains('ns-notice'));
  userClick(tool('Gemini CLI'));
  assert.equal(noticeEl().rendered, false, 'a saved key');
  userClick(tool('Grok'));
  assert.equal(noticeEl().rendered, true, 'and Grok still has none');
  await openReady({
    keys: { saved: { claude: false, gemini: false, grok: false }, env: { claude: false, gemini: false, grok: true } },
  });
  userClick(tool('Grok'));
  assert.equal(noticeEl().rendered, false, 'one set outside the app counts');
});

test('B5 notice: nothing is claimed while the answer is unknown', async () => {
  H.tools = ALL_TOOLS;
  H.keys = noKeys;
  openWith([PROJ]);
  // No settle: the dialog has not been told anything about keys yet, and an
  // unprompted "needs a key" over a machine that has one would be wrong.
  const noticeEl = (): FakeElement => one('key notice', (n) => n.classList.contains('ns-notice'));
  assert.equal(noticeEl().rendered, false);
  // Not even on the two tools the notice IS for. A FRESH module instance whose
  // GET /api/keys never answers, while GET /api/tools does: Gemini CLI and Grok
  // are selectable, the key answer is unknown, and an unprompted "needs a key"
  // over a machine that has one would be wrong.
  H.keysHang = true;
  H.tools = ALL_TOOLS;
  H.projects = [PROJ];
  const pending = (await import(`${launchUrl}?keys-pending`)) as LaunchModule;
  const host = new FakeElement('div');
  body.append(host);
  pending.initLaunchDialog(host);
  pending.openLaunchDialog();
  await settle(); // the availability answer lands; the key answer never does
  const pendingCard = (label: string): FakeElement => {
    const hits = descendants(host).filter(
      (n) =>
        n.classList.contains('ns-card') &&
        descendants(n).some((d) => d.classList.contains('ns-card-lb') && d.textContent === label),
    );
    assert.equal(hits.length, 1, `card "${label}"`);
    return hits[0] as FakeElement;
  };
  const pendingNotice = (): FakeElement => {
    const hits = descendants(host).filter((n) => n.classList.contains('ns-notice'));
    assert.equal(hits.length, 1, 'key notice');
    return hits[0] as FakeElement;
  };
  for (const label of ['Gemini CLI', 'Grok']) {
    userClick(pendingCard(label));
    assert.equal(pendingNotice().rendered, false, `${label}, the key answer still in flight`);
  }
  pending.closeLaunchDialog();
  H.keysHang = false;
});

test('B5 notice: `Add key` closes the dialog and hands Settings the tool to focus', async () => {
  await openReady({ keys: noKeys });
  userClick(tool('Grok'));
  H.settingsOpens.length = 0;
  userClick(buttonText('Add key'));
  assert.equal(L.isLaunchDialogOpen(), false, 'the dialog gets out of the way');
  assert.deepEqual(H.settingsOpens, [{ page: 'prefs', focusKey: 'grok' }]);
  await openReady({ keys: noKeys });
  userClick(tool('Gemini CLI'));
  H.settingsOpens.length = 0;
  userClick(buttonText('Add key'));
  assert.deepEqual(H.settingsOpens, [{ page: 'prefs', focusKey: 'gemini' }]);
});

test('B5 Start from: Claude Code lists THIS project’s ended conversations, newest first', async () => {
  const P2: Project = { ...PROJ, id: 'p2', name: 'other' };
  await openReady({
    projects: [PROJ, P2],
    history: [
      conv({ id: 'c-old', title: 'old work', lastUsedAt: '2026-09-01T10:00:00Z' }),
      conv({ id: 'c-new', title: 'auth refactor', lastUsedAt: '2026-09-17T10:00:00Z' }),
      conv({ id: 'c-p2', title: 'other project', projectId: 'p2' }),
      conv({ id: 'c-live', title: 'running now', ended: null }),
      conv({ id: 'c-noconv', title: 'a shell', conversation: false }),
    ],
  });
  userClick(tool('Claude Code'));
  await settle();
  const opts = startOpts();
  assert.deepEqual(opts.slice(0, 2), [
    ['fresh', 'A fresh conversation'],
    ['continue', 'The last conversation in this project'],
  ]);
  assert.deepEqual(
    opts.slice(2).map(([v]) => v),
    ['c-new', 'c-old'],
    'this project only, ended only, conversations only, newest first',
  );
  // The label is the title plus the Earlier section's own relative wording.
  assert.match(opts[2]?.[1] ?? '', /^auth refactor, /);
  // Asked ONCE per open, however many times the tool is switched back to it.
  const asked = H.historyCalls;
  userClick(tool('Codex'));
  userClick(tool('Claude Code'));
  userClick(tool('Grok'));
  userClick(tool('Claude Code'));
  await settle();
  assert.equal(H.historyCalls, asked, 'the list is cached for the life of one open');
});

test('B5 Start from: choosing a conversation emits --resume <id> and presets the Name', async () => {
  await openReady({ history: [conv()] });
  userClick(tool('Claude Code'));
  await settle();
  const label = startOpts().find(([v]) => v === 'conv-a')?.[1] as string;
  pickByLabel(byName('start'), label);
  assert.equal(byName('title').value, 'auth refactor', 'the Name is preset to the entry’s title');
  assert.deepEqual(await launch(), {
    projectId: 'p1',
    command: 'claude',
    args: ['--model', 'opus', '--resume', 'conv-a'],
    title: 'auth refactor',
    cols: 120,
    rows: 40,
  });
  // The preset is editable, and --continue is never sent alongside.
  await openReady({ history: [conv()] });
  userClick(tool('Claude Code'));
  await settle();
  pickByLabel(byName('start'), startOpts().find(([v]) => v === 'conv-a')?.[1] as string);
  type(byName('title'), 'my own name');
  const post = await launch();
  assert.equal(post?.title, 'my own name');
  assert.equal((post?.args as string[]).includes('--continue'), false);
});

test('B5 Start from: switching project re-filters the list and falls back to a fresh start', async () => {
  const P2: Project = { ...PROJ, id: 'p2', name: 'other' };
  await openReady({
    projects: [PROJ, P2],
    history: [conv({ id: 'c-p1' }), conv({ id: 'c-p2', title: 'other work', projectId: 'p2' })],
  });
  userClick(tool('Claude Code'));
  await settle();
  pickByLabel(byName('start'), startOpts().find(([v]) => v === 'c-p1')?.[1] as string);
  assert.equal(byName('start').value, 'c-p1');
  pickByLabel(byName('project'), 'other');
  assert.deepEqual(startOpts().map(([v]) => v), ['fresh', 'continue', 'c-p2']);
  assert.equal(byName('start').value, 'fresh', 'never silently a DIFFERENT conversation');
  assert.deepEqual((await launch())?.args, ['--model', 'opus']);
});

test('B5 Start from: with no project selected, only the entries that ran in the HOME folder are offered', async () => {
  // A project-less session starts in the home folder (launch() sends exactly
  // that cwd), so those are the conversations `--resume` can mean here — a
  // project-less entry from some OTHER folder would resume somewhere else.
  await openReady({
    projects: [],
    history: [
      conv({ id: 'c-p1' }),
      conv({ id: 'c-home', title: 'home work', projectId: undefined, cwd: '/home/tester' }),
      conv({ id: 'c-elsewhere', title: 'other folder', projectId: undefined, cwd: '/srv/scratch' }),
    ],
  });
  userClick(tool('Claude Code'));
  await settle();
  assert.deepEqual(startOpts().map(([v]) => v), ['fresh', 'continue', 'c-home']);
});

test('B5 Start from: the other three tools never list a conversation', async () => {
  await openReady({ history: [conv()] });
  for (const [label, values] of [
    ['Codex', ['fresh', 'last', 'pick']],
    ['Gemini CLI', ['fresh', 'last']],
    ['Grok', ['fresh', 'last']],
  ] as [string, string[]][]) {
    userClick(tool(label));
    assert.deepEqual(startOpts().map(([v]) => v), values, label);
  }
});

test('B5 resume: a live conversation is refused by the server and the dialog says so, unchanged', async () => {
  // POST /api/sessions answers 409 when the chosen conversation is still
  // running. The dialog shows the server's sentence and stays open; nothing
  // about the form moves, so the user can pick another entry.
  await openReady({ history: [conv()] });
  userClick(tool('Claude Code'));
  await settle();
  pickByLabel(byName('start'), startOpts().find(([v]) => v === 'conv-a')?.[1] as string);
  H.nextPost = () => Promise.reject(new Error('That conversation is already running.'));
  await launch();
  assert.equal(L.isLaunchDialogOpen(), true);
  assert.equal(errBox().hidden, false);
  assert.equal(errBox().textContent, 'That conversation is already running.');
  assert.equal(byName('start').value, 'conv-a', 'the choice is left exactly as it was');
  assert.equal(startBtn().disabled, false);
});

test('B5: the reopened dialog never silently resumes — Start from is fresh again', async () => {
  await openReady({ history: [conv()] });
  userClick(tool('Claude Code'));
  await settle();
  pickByLabel(byName('start'), startOpts().find(([v]) => v === 'conv-a')?.[1] as string);
  L.closeLaunchDialog();
  L.openLaunchDialog();
  await settle();
  assert.equal(byName('start').value, 'fresh');
  assert.deepEqual((await launch())?.args, ['--model', 'opus']);
});

test('B5 copy rule: no flag, subcommand or CLI value is visible anywhere in the dialog', async () => {
  const visible = (n: FakeNode): string =>
    n instanceof FakeText
      ? n.data
      : n instanceof FakeElement && !n.hidden
        ? n.children.map(visible).join(' ')
        : '';
  for (const label of ['Claude Code', 'Codex', 'Gemini CLI', 'Grok', 'Terminal']) {
    await openReady({ keys: noKeys, history: [conv()] });
    userClick(tool(label));
    const text = visible(scrim());
    for (const bit of [
      '--', 'resume', 'on-request', 'workspace-write', 'read-only', 'auto_edit', 'yolo',
      'model_reasoning_effort', 'latest', 'cmd.exe', 'zsh ', '$ ', 'gpt-', 'grok-4.6',
    ]) {
      assert.equal(text.includes(bit), false, `${label}: the dialog shows ${JSON.stringify(bit)}`);
    }
    assert.ok(text.includes('Start session'), `${label}: non-vacuity, real copy was read`);
  }
});
