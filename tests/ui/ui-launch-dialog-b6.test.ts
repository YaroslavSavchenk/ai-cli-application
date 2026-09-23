/**
 * `web/src/ui/launch.ts` — Nocturne B6 tool visibility (user decision D1): a
 * tool hidden in Settings is ABSENT from the New session dialog's grid, the
 * selection falls back to the first visible card, the arrows skip it, and the
 * hide is read on every open. Split out of `ui-launch-dialog.test.ts`.
 *
 * Why it matters: a hidden card that is still a tab stop or still the
 * selection launches a tool the user asked never to see.
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
import { NOT_INSTALLED, TOOL_CARDS } from '../../web/src/ui/launch-args.ts';
// The prefs model is pure and DOM-free (no stub needed): the same module
// instance the dialog reads `getHiddenTools()` from on every open.
import { initHiddenTools } from '../../web/src/ui/prefs-model.ts';
import {
  byName,
  cards,
  checked,
  descendants,
  H,
  L,
  launch,
  openReady,
  press,
  PROJ,
  settle,
  tool,
  userClick,
} from '../helpers/ui-launch-dialog-fixture.ts';

// ===========================================================================
// B6 — Tool visibility (user decision D1): a hidden card is ABSENT from the
// grid. Nothing else moves: the backend is not asked a different question,
// running sessions are untouched, and the argv of every card that is still
// there is the one pinned above.
// ===========================================================================

/** Hide these ids for one test, then put the grid back exactly as it was. */
async function withHidden(ids: string[], fn: () => Promise<void>): Promise<void> {
  initHiddenTools({ hidden: ids }, TOOL_CARDS.map((c) => c.id));
  try {
    await fn();
  } finally {
    initHiddenTools({ hidden: [] }, TOOL_CARDS.map((c) => c.id));
    L.closeLaunchDialog();
  }
}

/** The tool cards the user can SEE, by their label, in reading order. */
const shownTools = (): string[] =>
  cards('ns-tool-lb')
    .filter((c) => !c.hidden)
    .map((c) => descendants(c).find((d) => d.classList.contains('ns-card-lb'))?.textContent ?? '');

test('B6 D1: a hidden tool leaves the grid — not inert, absent, and never a tab stop', async () => {
  await withHidden(['codex', 'grok'], async () => {
    await openReady({});
    assert.deepEqual(shownTools(), ['Claude Code', 'Gemini CLI', 'Terminal', 'Other']);
    for (const label of ['Codex', 'Grok']) {
      const c = tool(label);
      assert.equal(c.hidden, true, `${label} must be hidden`);
      assert.equal(c.tabIndex, -1, `${label} must not be a tab stop`);
      assert.equal(checked(c), false, `${label} must not be the selection`);
      // Hidden is NOT `Not installed`: the card says nothing about the backend.
      assert.equal(
        descendants(c).some((d) => d.textContent === NOT_INSTALLED),
        false,
        `${label} must not claim anything about what is installed`,
      );
    }
  });
});

test('B6 D1: the selection falls back to the FIRST visible card, and that card is what launches', async () => {
  // The dialog remembers the last kind; this is the case that matters — the
  // user hides the tool they last launched.
  await openReady({});
  userClick(tool('Claude Code'));
  L.closeLaunchDialog();
  await withHidden(['claude'], async () => {
    await openReady({});
    assert.deepEqual(shownTools(), ['Codex', 'Gemini CLI', 'Grok', 'Terminal', 'Other']);
    assert.equal(checked(tool('Codex')), true, 'the first card still in the grid is selected');
    const post = await launch();
    assert.equal((post as Record<string, unknown>).command, 'codex');
  });
});

test('B6 D1: the projects-drawer open falls back too — its Claude Code intent cannot select a card that is gone', async () => {
  await withHidden(['claude'], async () => {
    await openReady({ projectId: PROJ.id });
    assert.equal(byName('project').value, PROJ.id, 'the project intent still lands');
    assert.equal(checked(tool('Codex')), true);
  });
});

test('B6 D1: a flip is read on every OPEN — the dialog on screen is left alone, the next one has it', async () => {
  await openReady({});
  assert.deepEqual(shownTools(), ['Claude Code', 'Codex', 'Gemini CLI', 'Grok', 'Terminal', 'Other']);
  await withHidden(['gemini'], async () => {
    assert.equal(tool('Gemini CLI').hidden, false, 'the open dialog does not rearrange itself');
    L.closeLaunchDialog();
    L.openLaunchDialog();
    await settle();
    assert.equal(tool('Gemini CLI').hidden, true, 'the next open reads the preference');
  });
  L.openLaunchDialog();
  await settle();
  assert.deepEqual(shownTools(), ['Claude Code', 'Codex', 'Gemini CLI', 'Grok', 'Terminal', 'Other']);
  L.closeLaunchDialog();
});

test('B6 D1: the arrow keys skip a hidden card', async () => {
  await openReady({});
  userClick(tool('Claude Code'));
  L.closeLaunchDialog();
  await withHidden(['codex'], async () => {
    await openReady({});
    tool('Claude Code').focus();
    press('ArrowRight');
    assert.equal(checked(tool('Gemini CLI')), true, 'Codex is not in the ring at all');
    press('ArrowLeft');
    assert.equal(checked(tool('Claude Code')), true);
  });
});

test('B6 D1: a bag that hides all six keeps the first card — the dialog can never be empty', async () => {
  await withHidden(TOOL_CARDS.map((c) => c.id), async () => {
    await openReady({});
    assert.deepEqual(shownTools(), ['Claude Code']);
    assert.equal(checked(tool('Claude Code')), true);
    assert.deepEqual((await launch())?.args, ['--model', 'opus'], 'and it still launches what it always did');
  });
});

test('B6 D1: hiding a card changes nothing about availability — `Not installed` is the backend\'s word alone', async () => {
  await withHidden(['grok'], async () => {
    await openReady({ tools: { codex: false } });
    const codex = tool('Codex');
    assert.equal(codex.hidden, false, 'an absent executable is still SHOWN, inert');
    assert.equal(codex.getAttribute('aria-disabled'), 'true');
    assert.ok(descendants(codex).some((d) => d.textContent === NOT_INSTALLED));
    assert.equal(H.tools.grok, true, 'the hidden tool was not removed from what the backend answers');
  });
});

test('B6 D1: a hidden card is out of the arrow ring on the FIRST frame, before the backend answers', async () => {
  // `applyHiddenTools()` runs synchronously inside `open()`; `GET /api/tools`
  // lands turns later and re-derives the same ring through `setInert`. A grid
  // that only drops a hidden card from the ring when that answer arrives
  // leaves a window in which ArrowRight walks the selection onto a card the
  // user cannot see — and `select()` can hand it the group's only tab stop.
  await openReady({});
  userClick(tool('Claude Code'));
  L.closeLaunchDialog();
  await withHidden(['codex'], async () => {
    L.openLaunchDialog(); // deliberately NOT settled: the answer is still in flight
    assert.equal(H.toolCalls > 0, true, 'the request went out');
    assert.equal(tool('Codex').hidden, true, 'the card left the grid on the opening frame');
    tool('Claude Code').focus();
    press('ArrowRight');
    assert.equal(checked(tool('Gemini CLI')), true, 'and left the ring on that same frame');
    assert.equal(tool('Codex').tabIndex, -1, 'a card nobody can see is never the tab stop');
    press('End');
    assert.equal(checked(tool('Other')), true, 'End lands on the last card that is really there');
    await settle();
    assert.equal(tool('Codex').hidden, true, 'and the availability answer does not bring it back');
  });
});
