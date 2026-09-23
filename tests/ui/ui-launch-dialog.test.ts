/**
 * `web/src/ui/launch.ts` — the New session dialog (Nocturne A4), driven like a
 * user through the REAL module: cards clicked, selects picked by their visible
 * words, keys pressed, and the `POST /api/sessions` body captured at the api
 * boundary. The contract it guards is the one A4 promised: every dialog state
 * that existed before A4 still sends byte-for-byte the argv it sent then, the
 * inert cards launch nothing, and the new pieces (info popover, Start from,
 * card keyboard) behave as specified. The B5 agents are in
 * `ui-launch-dialog-b5.test.ts`, B6 tool visibility in
 * `ui-launch-dialog-b6.test.ts`.
 *
 * WHY A HARNESS HERE. `tests/ui/ui-launch-args.test.ts` pins `composeSpawn`, but
 * the A4 risk sits one layer up: the selects now show LABELS (`Opus`,
 * `Extra high`, `The last conversation in this project`) over VALUES (`opus`,
 * `xhigh`, `continue`). One swapped `opt.value = label` and the dialog sends
 * `--model Opus`, or silently drops `--effort` / `--continue`, while every
 * pure-function test stays green. Only the plumbing can show that.
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
  EFFORTS,
  EFFORT_LABEL,
  MODELS,
  MODEL_LABEL,
  NOT_INSTALLED,
  PERMS,
  PERM_HELP,
  PERM_SHORT,
  SHELL_CARDS,
  START_FROM,
  TOOL_CARDS,
} from '../../web/src/ui/launch-args.ts';
import {
  body,
  buttonText,
  byName,
  cards,
  checked,
  descendants,
  dispatch,
  doc,
  errBox,
  FakeElement,
  FakeNode,
  FakeText,
  FOCUSABLE_TAGS,
  group,
  H,
  helpBox,
  infoBtn,
  L,
  launch,
  mainSawEscape,
  modalHost,
  one,
  openWith,
  permCard,
  pickByLabel,
  preA4,
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
// Tests
// ===========================================================================

test('harness non-vacuity: the REAL dialog mounted, with its three card groups and the stubs wired', () => {
  assert.equal(modalHost.children.length, 1, 'initLaunchDialog appends one scrim');
  assert.ok(scrim().classList.contains('modal-scrim'), 'ui/keys.ts finds an open dialog by .modal-scrim');
  assert.equal(cards('ns-tool-lb').length, TOOL_CARDS.length);
  assert.equal(cards('ns-shell-lb').length, SHELL_CARDS.length);
  assert.equal(cards('ns-perm-lb').length, PERMS.length);
  assert.equal(H.subscribers.length, 1, 'ONE permanent state subscription');
  openWith([PROJ]);
  assert.equal(scrim().hidden, false);
  assert.equal(doc.activeElement, byName('title'), 'open() puts the keyboard in the Name box');
});

test('B12: every Tool card holds its tool’s real logo in the tile — one per card, no letters, Claude’s tile keeps its tint', () => {
  openWith([PROJ]);
  const want: [string, string][] = [
    ['Claude Code', 'claude'],
    ['Codex', 'codex'],
    ['Gemini CLI', 'gemini'],
    ['Grok', 'grok'],
    ['Terminal', 'terminal'],
    ['Other', 'command'],
  ];
  for (const [label, id] of want) {
    const tile = descendants(tool(label)).find((d) => d.classList.contains('ns-mark'));
    assert.ok(tile !== undefined, `${label}: a tile`);
    assert.equal(tile.textContent, '', `${label}: a logo, not letters`);
    assert.equal(tile.getAttribute('aria-hidden'), 'true');
    const logos = descendants(tile).filter((d) => d.getAttribute('data-tool') !== null);
    assert.deepEqual(logos.map((l) => l.getAttribute('data-tool')), [id], label);
    assert.equal(logos[0]?.getAttribute('width'), '14', `${label}: one size in every tile`);
    assert.equal(tile.classList.contains('is-agent'), label === 'Claude Code', `${label}: the accent tint only on Claude`);
  }
});

test('defaults: an untouched dialog sends exactly `claude --model opus` for the project, no title', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  const post = await launch();
  assert.deepEqual(post, { projectId: 'p1', command: 'claude', args: ['--model', 'opus'], cols: 120, rows: 40 });
  assert.equal(L.isLaunchDialogOpen(), false, 'a successful launch closes the dialog');
  assert.deepEqual(H.upserted.at(-1), 'sess-' + H.posts.length, 'the new session gets its tab');
});

test('the selects SHOW labels and SEND values: every option is (vocabulary id, table label)', () => {
  openWith([PROJ]);
  const opts = (name: string): [string, string][] => byName(name).options.map((o) => [o.value, o.textContent]);
  assert.deepEqual(opts('model'), MODELS.map((m) => [m, MODEL_LABEL[m]]));
  assert.deepEqual(opts('effort'), EFFORTS.map((e) => [e, EFFORT_LABEL[e]]));
  assert.deepEqual(opts('start'), START_FROM.map((s) => [s.value, s.label]));
});

test('A4 contract through the DOM: all 192 claude states (model x permission card x effort x Start from) send the pre-A4 argv', async () => {
  let n = 0;
  for (const m of MODELS) {
    for (const p of PERMS) {
      for (const e of EFFORTS) {
        for (const s of START_FROM) {
          openWith([PROJ]);
          userClick(tool('Claude Code'));
          pickByLabel(byName('model'), MODEL_LABEL[m]);
          userClick(permCard(PERM_SHORT[p.mode]));
          pickByLabel(byName('effort'), EFFORT_LABEL[e]);
          pickByLabel(byName('start'), s.label);
          const post = await launch();
          assert.deepEqual(
            post,
            { projectId: 'p1', command: 'claude', args: preA4(m, p.mode, e, s.value === 'continue'), cols: 120, rows: 40 },
            `${m}/${p.mode}/${e}/${s.value}`,
          );
          n++;
        }
      }
    }
  }
  assert.equal(n, 192);
});

test('A4 contract, spelled out: the hardest claude state and the two Start from choices, literal argv', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('model'), 'Sonnet');
  userClick(permCard('Auto edits'));
  pickByLabel(byName('effort'), 'Extra high');
  pickByLabel(byName('start'), 'The last conversation in this project');
  assert.deepEqual((await launch())?.args, [
    '--model', 'sonnet', '--permission-mode', 'acceptEdits', '--effort', 'xhigh', '--continue',
  ]);
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('model'), 'Fable');
  userClick(permCard('No prompts'));
  pickByLabel(byName('effort'), 'Max');
  pickByLabel(byName('start'), 'A fresh conversation');
  assert.deepEqual((await launch())?.args, ['--model', 'fable', '--permission-mode', 'bypassPermissions', '--effort', 'max']);
});

test('Terminal: the Bash card is `/bin/bash -l`, the PowerShell card is `powershell.exe -NoLogo`, byte for byte', async () => {
  openWith([PROJ]);
  userClick(tool('Terminal'));
  userClick(shellCard('Bash'));
  assert.deepEqual(await launch(), { projectId: 'p1', command: '/bin/bash', args: ['-l'], cols: 120, rows: 40 });
  openWith([PROJ]);
  userClick(tool('Terminal'));
  userClick(shellCard('PowerShell'));
  assert.deepEqual(await launch(), { projectId: 'p1', command: 'powershell.exe', args: ['-NoLogo'], cols: 120, rows: 40 });
});

test('Terminal: claude choices made before switching never leak into the shell argv', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('model'), 'Haiku');
  userClick(permCard('No prompts'));
  pickByLabel(byName('effort'), 'Max');
  pickByLabel(byName('start'), 'The last conversation in this project');
  userClick(tool('Terminal'));
  userClick(shellCard('Bash'));
  assert.deepEqual((await launch())?.args, ['-l']);
});

test('Other: the custom line is whitespace-split verbatim — tabs, runs, quotes and a path all as before', async () => {
  const cases: [string, string, string[]][] = [
    ['htop --tree', 'htop', ['--tree']],
    ['  bash \t -c   true ', 'bash', ['-c', 'true']],
    ['echo "a b"', 'echo', ['"a', 'b"']],
    ["printf '%s' x", 'printf', ["'%s'", 'x']],
    ['/usr/bin/env python3 -i', '/usr/bin/env', ['python3', '-i']],
    ['--weird foo', '--weird', ['foo']],
    ['claude --model opus --continue', 'claude', ['--model', 'opus', '--continue']],
  ];
  for (const [line, command, args] of cases) {
    openWith([PROJ]);
    userClick(tool('Other'));
    type(byName('command'), line);
    assert.deepEqual(await launch(), { projectId: 'p1', command, args, cols: 120, rows: 40 }, JSON.stringify(line));
  }
});

test('Other: a blank command sends nothing, says so, and puts the keyboard in the Command field', async () => {
  for (const line of ['', '   ', '\t \t']) {
    openWith([PROJ]);
    userClick(tool('Other'));
    type(byName('command'), line);
    assert.equal(await launch(), null, JSON.stringify(line));
    assert.equal(errBox().hidden, false);
    assert.equal(errBox().textContent, 'Type a command.');
    assert.equal(doc.activeElement, byName('command'));
    assert.equal(L.isLaunchDialogOpen(), true);
  }
});

test('Other: the log line carries the SHAPE of a custom command, never its text', async () => {
  openWith([PROJ]);
  userClick(tool('Other'));
  type(byName('command'), 'deploy-tool --token s3cr3t-value now');
  H.logs = [];
  await launch();
  const joined = H.logs.join('\n');
  assert.match(joined, /launch: kind=other project=demo-api words=4/);
  for (const leak of ['deploy-tool', 's3cr3t-value', '--token']) assert.equal(joined.includes(leak), false, leak);
});

test('No projects: Terminal still launches into the home folder, titled by the shell name, never a path', async () => {
  const fsBefore = H.fsListCalls;
  openWith([]);
  userClick(tool('Terminal'));
  userClick(shellCard('Bash'));
  assert.equal(startBtn().disabled, false);
  assert.equal(
    one('no-projects line', (n) => n.classList.contains('ns-none')).children[0]?.textContent,
    'No projects yet. This one opens in your home folder.',
  );
  assert.deepEqual(await launch(), {
    cwd: '/home/tester',
    command: '/bin/bash',
    args: ['-l'],
    title: 'Bash',
    cols: 120,
    rows: 40,
  });
  openWith([]);
  userClick(tool('Terminal'));
  userClick(shellCard('PowerShell'));
  assert.deepEqual(await launch(), {
    cwd: '/home/tester',
    command: 'powershell.exe',
    args: ['-NoLogo'],
    title: 'PowerShell',
    cols: 120,
    rows: 40,
  });
  assert.ok(H.fsListCalls - fsBefore <= 1, 'the home folder is asked at most once per page');
});

test('No projects: Claude Code and Other stay unlaunchable (Start session disabled, nothing sent)', async () => {
  for (const t of ['Claude Code', 'Other']) {
    openWith([]);
    userClick(tool(t));
    if (t === 'Other') type(byName('command'), 'htop');
    assert.equal(startBtn().disabled, true, t);
    assert.equal(await launch(), null, t);
  }
});

test('a typed Name is sent trimmed as the title; a blank one sends no title (the server uses the project name)', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  assert.equal(byName('title').placeholder, 'demo-api', 'the placeholder IS the project name');
  type(byName('title'), '  my run  ');
  assert.equal((await launch())?.title, 'my run');
});

test('inert tool cards: rendered, aria-disabled, never a tab stop, and a click launches nothing new', async () => {
  openWith([PROJ]);
  userClick(tool('Terminal'));
  userClick(shellCard('Bash'));
  for (const label of ['Codex', 'Gemini CLI', 'Grok']) {
    const c = tool(label);
    assert.equal(c.getAttribute('aria-disabled'), 'true', label);
    assert.equal(c.tabIndex, -1, label);
    assert.ok(c.textContent.includes(NOT_INSTALLED), `${label} carries the hint`);
    const focusBefore = doc.activeElement;
    userClick(c);
    assert.equal(checked(c), false, `${label} never becomes selected`);
    assert.equal(doc.activeElement, focusBefore, `${label}: a press does not even take focus`);
    assert.ok(checked(tool('Terminal')), `${label}: the selection stays on Terminal`);
  }
  assert.deepEqual((await launch())?.command, '/bin/bash', 'still the Terminal launch');
});

test('inert shell cards: Zsh and Command Prompt cannot be picked; the chosen shell stays', async () => {
  openWith([PROJ]);
  userClick(tool('Terminal'));
  userClick(shellCard('PowerShell'));
  for (const label of ['Zsh', 'Command Prompt']) {
    const c = shellCard(label);
    assert.equal(c.getAttribute('aria-disabled'), 'true', label);
    assert.equal(c.tabIndex, -1, label);
    userClick(c);
    assert.equal(checked(c), false, label);
  }
  assert.ok(checked(shellCard('PowerShell')));
  assert.deepEqual(await launch(), { projectId: 'p1', command: 'powershell.exe', args: ['-NoLogo'], cols: 120, rows: 40 });
});

test('card keyboard: arrows move the selection over LIVE cards only, wrapping; Home/End jump', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  const sel = (): string[] =>
    cards('ns-tool-lb').filter(checked).map((c) => c.textContent);
  assert.equal(doc.activeElement, tool('Claude Code'));
  press('ArrowRight');
  assert.equal(doc.activeElement, tool('Terminal'), 'Codex/Gemini CLI/Grok are skipped');
  assert.deepEqual(sel().length, 1);
  press('ArrowDown');
  assert.equal(doc.activeElement, tool('Other'));
  press('ArrowRight');
  assert.equal(doc.activeElement, tool('Claude Code'), 'wraps');
  press('ArrowLeft');
  assert.equal(doc.activeElement, tool('Other'), 'wraps backwards');
  press('Home');
  assert.equal(doc.activeElement, tool('Claude Code'));
  press('End');
  assert.equal(doc.activeElement, tool('Other'));
  assert.equal(byName('command').rendered, true, 'the arrows really switched the kind');
  // Exactly one tab stop per group: the selected card.
  const stops = cards('ns-tool-lb').filter((c) => c.tabIndex === 0);
  assert.deepEqual(stops, [tool('Other')]);
  // Shells: Bash <-> PowerShell, inert ones skipped.
  userClick(tool('Terminal'));
  userClick(shellCard('Bash'));
  press('ArrowRight');
  assert.equal(doc.activeElement, shellCard('PowerShell'));
  assert.ok(checked(shellCard('PowerShell')));
  press('ArrowRight');
  assert.equal(doc.activeElement, shellCard('Bash'));
});

test('permission cards: the four PERM_SHORT labels in PERMS order, arrows cycle them, only No prompts is danger', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  const labels = cards('ns-perm-lb').map((c) => c.textContent);
  assert.deepEqual(labels, PERMS.map((p) => PERM_SHORT[p.mode]));
  assert.deepEqual(
    cards('ns-perm-lb').filter((c) => c.classList.contains('is-danger')).map((c) => c.textContent),
    [PERM_SHORT.bypassPermissions],
  );
  userClick(permCard('Always ask'));
  press('ArrowRight');
  assert.ok(checked(permCard('Auto edits')));
  press('End');
  assert.ok(checked(permCard('No prompts')));
});

test('the claude-only controls leave the form for Terminal and Other: hidden AND disabled, popover closed', () => {
  for (const t of ['Terminal', 'Other']) {
    openWith([PROJ]);
    userClick(tool('Claude Code'));
    userClick(infoBtn());
    assert.equal(helpBox().hidden, false);
    userClick(tool(t));
    for (const name of ['model', 'effort', 'start']) {
      assert.equal(byName(name).disabled, true, `${t}: ${name} disabled`);
      assert.equal(byName(name).rendered, false, `${t}: ${name} hidden`);
    }
    assert.equal(infoBtn().disabled, true, `${t}: info button disabled`);
    for (const c of cards('ns-perm-lb')) assert.equal(c.disabled, true, `${t}: ${c.textContent} disabled`);
    assert.equal(helpBox().hidden, true, `${t}: the popover closes with the claude box`);
    assert.equal(byName('command').rendered, t === 'Other', `${t}: Command field`);
    assert.equal(group('ns-shell-lb').rendered, t === 'Terminal', `${t}: Shell cards`);
    // And back: everything claude comes back enabled.
    userClick(tool('Claude Code'));
    for (const name of ['model', 'effort', 'start']) assert.equal(byName(name).disabled, false, name);
    assert.equal(infoBtn().disabled, false);
    assert.equal(byName('command').rendered, false);
    assert.equal(group('ns-shell-lb').rendered, false);
  }
});

test('Tab trap: the cycle wraps between the REAL first and last stops; inert and unselected cards never count', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  const stops = descendants(modalHost).filter(
    (n) => n.rendered && n.tabIndex >= 0 && ((FOCUSABLE_TAGS.has(n.tagName) && !n.disabled) || n.hasAttribute('tabindex')),
  );
  // Close, then one card per group, Name, Project, Model, Effort, info, Start from, Cancel, Start session.
  assert.equal(stops[0], buttonText('×'));
  assert.equal(stops.at(-1), startBtn());
  for (const label of ['Codex', 'Gemini CLI', 'Grok']) assert.equal(stops.includes(tool(label)), false, label);
  startBtn().focus();
  assert.equal(press('Tab').defaultPrevented, true);
  assert.equal(doc.activeElement, buttonText('×'), 'Tab at the last stop wraps to the first');
  assert.equal(press('Tab', true).defaultPrevented, true);
  assert.equal(doc.activeElement, startBtn(), 'Shift+Tab at the first stop wraps to the last');
});

test('info popover: the ONE explanation — four PERM_SHORT terms with their PERM_HELP lines, closed by default', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  assert.equal(helpBox().hidden, true, 'closed on open');
  assert.equal(infoBtn().getAttribute('aria-expanded'), 'false');
  assert.equal(infoBtn().getAttribute('aria-controls'), 'ns-perm-help');
  assert.equal(infoBtn().getAttribute('aria-label'), 'What these mean');
  userClick(infoBtn());
  assert.equal(helpBox().hidden, false);
  assert.equal(infoBtn().getAttribute('aria-expanded'), 'true');
  const dl = descendants(helpBox()).filter((n) => n.tagName === 'DT' || n.tagName === 'DD');
  assert.deepEqual(
    dl.map((n) => [n.tagName, n.textContent]),
    PERMS.flatMap((p) => [
      ['DT', PERM_SHORT[p.mode]],
      ['DD', PERM_HELP[p.mode]],
    ]),
  );
  userClick(infoBtn());
  assert.equal(helpBox().hidden, true, 'the button toggles it shut');
});

test('info popover: Esc closes ONLY the popover (main.ts never sees it), a second Esc closes the dialog', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  userClick(infoBtn());
  const seen = mainSawEscape;
  const e = press('Escape');
  assert.equal(e.defaultPrevented, true);
  assert.equal(helpBox().hidden, true, 'popover closed');
  assert.equal(L.isLaunchDialogOpen(), true, 'dialog still open');
  assert.equal(mainSawEscape, seen, 'the capture listener stopped the event before the app-level handler');
  assert.equal(doc.activeElement, infoBtn(), 'the keyboard goes back to the info button');
  press('Escape');
  assert.equal(mainSawEscape, seen + 1);
  assert.equal(L.isLaunchDialogOpen(), false, 'with the popover shut, Esc is the dialog’s again');
});

test('info popover: Esc from the page body (after a click on the popover text) still closes only the popover', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  userClick(infoBtn());
  doc.activeElement = body;
  press('Escape');
  assert.equal(helpBox().hidden, true);
  assert.equal(L.isLaunchDialogOpen(), true);
});

test('info popover: a press outside it, or focus moving on, closes it; a press inside keeps it', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  userClick(infoBtn());
  const dd = descendants(helpBox()).find((n) => n.tagName === 'DD') as FakeElement;
  dispatch(dd, 'pointerdown');
  assert.equal(helpBox().hidden, false, 'a press on its own text keeps it');
  userClick(byName('title'));
  assert.equal(helpBox().hidden, true, 'a press elsewhere closes it');
  userClick(infoBtn());
  permCard('Always ask').focus();
  assert.equal(helpBox().hidden, true, 'Tab onto the cards it covers closes it');
});

test('open(): Effort and Start from reset every open; kind, shell and command text are remembered', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('effort'), 'High');
  pickByLabel(byName('start'), 'The last conversation in this project');
  L.closeLaunchDialog();
  L.openLaunchDialog();
  assert.equal(byName('effort').value, 'default');
  assert.equal(byName('start').value, 'fresh');
  assert.deepEqual((await launch())?.args, ['--model', 'opus'], 'a reopened dialog never silently continues');

  openWith([PROJ]);
  userClick(tool('Other'));
  type(byName('command'), 'htop --tree');
  L.closeLaunchDialog();
  L.openLaunchDialog();
  assert.ok(checked(tool('Other')), 'the kind is remembered');
  assert.equal(byName('command').value, 'htop --tree', 'the command text is remembered');

  openWith([PROJ]);
  userClick(tool('Terminal'));
  userClick(shellCard('PowerShell'));
  L.closeLaunchDialog();
  L.openLaunchDialog();
  assert.ok(checked(tool('Terminal')));
  assert.ok(checked(shellCard('PowerShell')), 'the shell is remembered');
  assert.equal((await launch())?.command, 'powershell.exe');
});

test('project defaults: model and mode resolve once per open from the selected project', async () => {
  const P2: Project = { ...PROJ, id: 'p2', name: 'other', defaultModel: 'haiku', defaultMode: 'skip-permissions' };
  openWith([P2]);
  userClick(tool('Claude Code'));
  assert.deepEqual((await launch())?.args, ['--model', 'haiku', '--permission-mode', 'bypassPermissions']);
  // A mode picked by hand is NOT carried into the next open: defaults win again.
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  userClick(permCard('Read only'));
  L.closeLaunchDialog();
  L.openLaunchDialog();
  assert.ok(checked(permCard('Always ask')));
  assert.deepEqual((await launch())?.args, ['--model', 'opus']);
});

test('project intent (drawer row +): back to Claude Code for THAT project, its defaults layered on', async () => {
  const P2: Project = { ...PROJ, id: 'p2', name: 'other', defaultModel: 'sonnet' };
  openWith([PROJ, P2]);
  userClick(tool('Other'));
  type(byName('command'), 'htop');
  openWith([PROJ, P2], { projectId: 'p2' });
  assert.ok(checked(tool('Claude Code')), 'a stale Other cannot hijack a project launch');
  assert.equal(byName('project').value, 'p2');
  assert.deepEqual(await launch(), { projectId: 'p2', command: 'claude', args: ['--model', 'sonnet'], cols: 120, rows: 40 });
});

test('a failed launch keeps the dialog open with the error, and Start session usable again', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  H.nextPost = () => Promise.reject(new Error('Folder not found.'));
  await launch();
  assert.equal(L.isLaunchDialogOpen(), true);
  assert.equal(errBox().hidden, false);
  assert.equal(errBox().textContent, 'Folder not found.');
  assert.equal(startBtn().disabled, false);
});

test('closing hands the keyboard back; the outside press and Cancel both close', () => {
  const opener = new FakeElement('button');
  body.append(opener);
  L.closeLaunchDialog();
  opener.focus();
  H.projects = [PROJ];
  L.openLaunchDialog();
  userClick(buttonText('Cancel'));
  assert.equal(L.isLaunchDialogOpen(), false);
  assert.equal(doc.activeElement, opener, 'focus returns to where the dialog was opened from');
  L.openLaunchDialog();
  userClick(scrim());
  assert.equal(L.isLaunchDialogOpen(), false, 'a press on the scrim closes');
  L.openLaunchDialog();
  dispatch(scrim().children[0] as FakeElement, 'mousedown');
  assert.equal(L.isLaunchDialogOpen(), true, 'a press on the modal itself does not');
});

test('no command preview: nothing in the rendered dialog spells the argv — before, and WHILE the launch is in flight', async () => {
  // Visible text only: option VALUES are attributes, not copy.
  const visible = (n: FakeNode): string =>
    n instanceof FakeText
      ? n.data
      : n instanceof FakeElement && !n.hidden
        ? n.children.map(visible).join(' ')
        : '';
  const assertNoArgv = (when: string): void => {
    const text = visible(scrim());
    for (const argvBit of ['--', 'acceptEdits', 'claude ', '$ ', 'xhigh', '-l', '/bin/bash', 'powershell.exe', '-NoLogo']) {
      assert.equal(text.includes(argvBit), false, `${when}: the dialog shows ${JSON.stringify(argvBit)}`);
    }
    assert.ok(text.includes('Start session'), `${when}: non-vacuity, real copy was read`);
  };
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('model'), 'Sonnet');
  userClick(permCard('Auto edits'));
  pickByLabel(byName('effort'), 'Extra high');
  pickByLabel(byName('start'), 'The last conversation in this project');
  assertNoArgv('claude, before launch');
  // Hold the POST open: whatever the dialog shows between the press and the
  // answer is on screen for as long as the server takes.
  let release: (v: unknown) => void = () => {};
  H.nextPost = () => new Promise((r) => (release = r));
  userClick(startBtn());
  await settle();
  assert.equal(L.isLaunchDialogOpen(), true, 'still open while the POST is pending');
  assertNoArgv('claude, in flight');
  release({ id: 'held', command: 'claude', args: [] });
  await settle();
  for (const shell of ['Bash', 'PowerShell']) {
    openWith([PROJ]);
    userClick(tool('Terminal'));
    userClick(shellCard(shell));
    H.nextPost = () => new Promise((r) => (release = r));
    userClick(startBtn());
    await settle();
    assertNoArgv(`${shell}, in flight`);
    release({ id: 'held-' + shell, command: 'x', args: [] });
    await settle();
  }
});
