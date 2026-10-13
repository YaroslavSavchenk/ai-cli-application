/**
 * `web/src/ui/launch.ts` — part D1 (`.claude/plans/nocturne/PLAN-D1.md`): a
 * project's preferences are what the New session dialog pre-selects for THAT
 * project — on open, and again when another project is picked inside the
 * dialog — except a field the user changed by hand during this open; the
 * preferences are Claude Code's only; the Model select lists the pool with an
 * "Older models" group.
 *
 * Why it matters: before D1 the dialog resolved once per open, so the model
 * shown was the first project's (`server.log`: `project=crypto model=opus`
 * while crypto prefers `fable`), and a `No prompts` preference armed bypass for
 * Codex and Gemini too.
 *
 * HOW IT RUNS WITHOUT A BROWSER: the harness in
 * `tests/helpers/ui-launch-dialog-fixture.ts` (its own DOM double, launch.ts's
 * non-pure imports stubbed, ONE real dialog per file); `./launch-args.ts` and
 * `./launch-prefs-model.ts` are the REAL modules. The rules themselves are
 * pinned purely in `ui-launch-prefs-model.test.ts`.
 *
 * NOT claimed: how a real browser draws the OPTGROUP (the DEV check and the
 * browser screenshot in the D1 report), screen-reader output.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  byName,
  checked,
  dispatch,
  FakeElement,
  H,
  launch,
  openReady,
  openWith,
  permCard,
  pickByLabel,
  PROJ,
  tool,
  userClick,
  type Project,
} from '../helpers/ui-launch-dialog-fixture.ts';

const SONNET: Project = { ...PROJ, id: 'p2', name: 'api', defaultModel: 'sonnet' };
const BOLD: Project = {
  ...PROJ,
  id: 'p3',
  name: 'crypto',
  defaultModel: 'fable',
  defaultPerm: 'bypassPermissions',
  defaultEffort: 'max',
};

/** Pick a project in the dialog's Project select, the way a user does. */
function pickProject(id: string): void {
  const sel = byName('project');
  sel.value = id;
  assert.equal(sel.value, id, `project ${id} is offered`);
  dispatch(sel, 'change');
}

test('the Model select: the newest four as plain options, then ONE "Older models" group with the rest', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  const sel = byName('model');
  const kids = sel.children.filter((c): c is FakeElement => c instanceof FakeElement);
  assert.deepEqual(
    kids.map((c) => (c.tagName === 'OPTION' ? c.textContent : `[${c.tagName}]`)),
    ['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 4.5', '[OPTGROUP]'],
  );
  const group = kids[4] as FakeElement & { label?: string };
  assert.equal(group.label, 'Older models');
  assert.deepEqual(
    group.children.map((c) => c.textContent),
    ['Opus 5', 'Sonnet 5', 'Fable 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Opus 4.5', 'Opus 4.1', 'Sonnet 4.6', 'Sonnet 4.5'],
  );
  assert.equal(sel.value, 'claude-opus-5-5', 'no preference: Opus 5.5, not the first entry');
});

test('a model from Older models launches its pinned id', async () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('model'), 'Opus 4.8');
  assert.deepEqual((await launch())?.args, ['--model', 'claude-opus-4-8', '--permission-mode', 'manual']);
});

test('picking another project inside the dialog applies ITS preferences', async () => {
  openWith([SONNET, BOLD]);
  userClick(tool('Claude Code'));
  assert.equal(byName('project').value, 'p2');
  assert.equal(byName('model').value, 'claude-sonnet-5-5', 'the first project’s alias, resolved');
  pickProject('p3');
  assert.equal(byName('model').value, 'claude-fable-5-1');
  assert.ok(checked(permCard('No prompts')));
  assert.equal(byName('effort').value, 'max');
  assert.deepEqual(await launch(), {
    projectId: 'p3',
    command: 'claude',
    args: ['--model', 'claude-fable-5-1', '--permission-mode', 'bypassPermissions', '--effort', 'max'],
    cols: 120,
    rows: 40,
  });
});

test('a project with no preferences, picked after one with them, lands on the fallbacks — nothing carries over', async () => {
  openWith([BOLD, PROJ]);
  userClick(tool('Claude Code'));
  assert.ok(checked(permCard('No prompts')), 'non-vacuity: the first project armed it');
  pickProject('p1');
  assert.equal(byName('model').value, 'claude-opus-5-5');
  assert.ok(checked(permCard('Always ask')), 'a No prompts preference never rides along to the next project');
  assert.equal(byName('effort').value, 'default');
  assert.deepEqual((await launch())?.args, ['--model', 'claude-opus-5-5', '--permission-mode', 'manual']);
});

test('a field changed by hand survives a project switch; the untouched ones follow the project', async () => {
  openWith([PROJ, BOLD]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('model'), 'Haiku 4.5');
  pickProject('p3');
  assert.equal(byName('model').value, 'claude-haiku-4-5', 'the hand-picked model stays');
  assert.ok(checked(permCard('No prompts')), 'the permission follows the project');
  assert.equal(byName('effort').value, 'max', 'the effort follows the project');

  openWith([PROJ, BOLD]);
  userClick(tool('Claude Code'));
  userClick(permCard('Read only'));
  pickByLabel(byName('effort'), 'Low');
  pickProject('p3');
  assert.ok(checked(permCard('Read only')), 'the hand-picked mode stays');
  assert.equal(byName('effort').value, 'low', 'the hand-picked effort stays');
  assert.equal(byName('model').value, 'claude-fable-5-1', 'the model follows the project');
  assert.deepEqual((await launch())?.args, [
    '--model', 'claude-fable-5-1', '--permission-mode', 'plan', '--effort', 'low',
  ]);
});

test('a hand change counts for one open: the next open shows the project’s preferences again', () => {
  openWith([BOLD]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('model'), 'Sonnet 4.6');
  userClick(permCard('Always ask'));
  openWith([BOLD]);
  assert.equal(byName('model').value, 'claude-fable-5-1');
  assert.ok(checked(permCard('No prompts')));
});

test('a No prompts preference does not arm Codex or Gemini — and Claude Code still shows it', async () => {
  await openReady({ projects: [BOLD] });
  userClick(tool('Claude Code'));
  assert.ok(checked(permCard('No prompts')));
  userClick(tool('Codex'));
  assert.ok(checked(permCard('Always ask')), 'Codex starts on Always ask');
  assert.deepEqual((await launch())?.args, ['-a', 'on-request', '-s', 'read-only']);

  await openReady({ projects: [BOLD] });
  userClick(tool('Gemini CLI'));
  assert.ok(checked(permCard('Always ask')), 'Gemini starts on Always ask');
  assert.deepEqual((await launch())?.args, [], 'no --approval-mode yolo');

  await openReady({ projects: [BOLD] });
  userClick(tool('Gemini CLI'));
  userClick(tool('Claude Code'));
  assert.ok(checked(permCard('No prompts')), 'back on Claude Code the preference shows again');
});

test('D5: a project that prefers Always ask launches Claude Code with `--permission-mode manual`, Grok without it', async () => {
  // The explicit preference beats the legacy bypass beside it (resolvePerm's tiers).
  const ASK: Project = { ...PROJ, id: 'p4', name: 'ask', defaultPerm: 'default', defaultMode: 'skip-permissions' };
  await openReady({ projects: [ASK] });
  userClick(tool('Claude Code'));
  assert.ok(checked(permCard('Always ask')));
  assert.deepEqual(await launch(), {
    projectId: 'p4',
    command: 'claude',
    args: ['--model', 'claude-opus-5-5', '--permission-mode', 'manual'],
    cols: 120,
    rows: 40,
  });

  await openReady({ projects: [ASK] });
  userClick(tool('Grok'));
  assert.ok(checked(permCard('Always ask')));
  assert.deepEqual((await launch())?.args, [], 'Grok never gets a claude flag');
});

test('a dialog that opens on a remembered Codex never starts it armed from the project', async () => {
  await openReady({ projects: [PROJ] });
  userClick(tool('Codex'));
  await openReady({ projects: [BOLD] });
  assert.ok(checked(tool('Codex')), 'non-vacuity: the kind was remembered');
  assert.ok(checked(permCard('Always ask')));
  assert.deepEqual((await launch())?.args, ['-a', 'on-request', '-s', 'read-only']);
});

test('a mode picked by hand on Codex stays when the user moves to Claude Code', async () => {
  await openReady({ projects: [BOLD] });
  userClick(tool('Codex'));
  userClick(permCard('Auto edits'));
  userClick(tool('Claude Code'));
  assert.ok(checked(permCard('Auto edits')), 'a per-launch choice always wins');
});

test('a mode picked by hand survives a tool that cannot take it: Always ask there, the hand pick again on Claude Code', async () => {
  await openReady({ projects: [BOLD] });
  userClick(tool('Claude Code'));
  userClick(permCard('Read only'));
  userClick(tool('Grok'));
  assert.ok(checked(permCard('Always ask')), 'Grok cannot be told Read only: its cards show Always ask');
  userClick(tool('Claude Code'));
  assert.ok(checked(permCard('Read only')), 'back on Claude Code the hand pick shows again, not Always ask nor No prompts');
  assert.deepEqual((await launch())?.args, [
    '--model', 'claude-fable-5-1', '--permission-mode', 'plan', '--effort', 'max',
  ]);
});

test('a hostile hand-edited model preference never reaches the argv: the fallback model, no extra flag', async () => {
  openWith([{ ...PROJ, defaultModel: '--dangerously-skip-permissions' }]);
  userClick(tool('Claude Code'));
  assert.equal(byName('model').value, 'claude-opus-5-5');
  assert.deepEqual((await launch())?.args, ['--model', 'claude-opus-5-5', '--permission-mode', 'manual']);
});

test('project intent (drawer row Session) lays THAT project’s preferences on', async () => {
  openWith([PROJ, BOLD], { projectId: 'p3' });
  assert.equal(byName('project').value, 'p3');
  assert.deepEqual((await launch())?.args, [
    '--model', 'claude-fable-5-1', '--permission-mode', 'bypassPermissions', '--effort', 'max',
  ]);
});

test('a project edited while the dialog is open shows its new preferences at once; a hand change still wins', () => {
  openWith([PROJ]);
  userClick(tool('Claude Code'));
  pickByLabel(byName('effort'), 'High');
  H.projects = [{ ...PROJ, defaultModel: 'claude-opus-4-7', defaultEffort: 'low' }];
  for (const fn of H.subscribers) fn('projects');
  assert.equal(byName('model').value, 'claude-opus-4-7');
  assert.equal(byName('effort').value, 'high', 'the hand-picked effort stays');
});

test('a model or effort picked on Codex is Codex’s own: Claude Code still follows the next project', async () => {
  await openReady({ projects: [PROJ, BOLD] });
  userClick(tool('Codex'));
  pickByLabel(byName('model'), 'GPT-6 Astra');
  pickByLabel(byName('effort'), 'Minimal');
  pickProject('p3');
  userClick(tool('Claude Code'));
  assert.equal(byName('model').value, 'claude-fable-5-1', 'a Codex pick is no hand change of Claude’s model');
  assert.equal(byName('effort').value, 'max', 'a Codex pick is no hand change of Claude’s effort');
  userClick(tool('Codex'));
  assert.equal(byName('model').value, 'gpt-6-astra', 'Codex keeps its own pick');
});

test('only Claude Code’s Model select carries the Older models group — no empty group on another tool or on Effort', async () => {
  await openReady({ projects: [PROJ] });
  const groups = (name: string): number =>
    byName(name).children.filter((c) => c instanceof FakeElement && c.tagName === 'OPTGROUP').length;
  userClick(tool('Claude Code'));
  assert.equal(groups('model'), 1, 'non-vacuity: Claude Code has its one group');
  assert.equal(groups('effort'), 0, 'Claude Code effort');
  for (const t of ['Codex', 'Gemini CLI', 'Grok']) {
    userClick(tool(t));
    assert.equal(groups('model'), 0, `${t} model`);
    assert.equal(groups('effort'), 0, `${t} effort`);
  }
});

test('a hand-picked mode Grok cannot take stays off Grok’s cards when the project changes', async () => {
  await openReady({ projects: [PROJ, BOLD] });
  userClick(tool('Claude Code'));
  userClick(permCard('Read only'));
  userClick(tool('Grok'));
  assert.ok(checked(permCard('Always ask')), 'precondition: Grok shows Always ask');
  pickProject('p3');
  assert.ok(checked(permCard('Always ask')), 'a project change on Grok never arms the mode Grok cannot be told');
  assert.equal(checked(permCard('Read only')), false);
  userClick(tool('Claude Code'));
  assert.ok(checked(permCard('Read only')), 'the hand pick is back on Claude Code');
});
