/**
 * `web/src/ui/files.ts` — after a copy, and the clipboard (part B10):
 * `refreshAfterDrop` re-reads only the root or an open folder the copy landed
 * in, and a row's `Copy` goes through the backend's path mapping and says
 * what happened in the statusline flash. Split out of `ui-files-panel.test.ts`.
 *
 * Seam: the REAL `web/src/ui/files.ts` on the shared DOM double, against the
 * REAL `web/src/state.ts`, `ui/util.ts`, `ui/icons.ts`, `ui/files-model.ts`,
 * `ui/fs-model.ts`, `ui/commit-model.ts` and `ui/commit-store.ts`, with the
 * backend a fake `FsGateway` (`tests/helpers/fs-fixture.ts` over
 * `tests/helpers/commits-fixture.ts`) — no HTTP, no module stubbing, no clock.
 * Booted once per file by `tests/helpers/ui-files-panel-fixture.ts` and reset
 * before every test (`resetPanel`).
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`):
 * layout, colour, the amber pulse actually animating, that a drag really
 * reflows a PTY, hit-testing, screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  byClass,
  dispatch,
  textsOf,
} from '../helpers/fake-dom.ts';
import {
  FakeApiError,
  PROJ,
  settle,
} from '../helpers/fs-fixture.ts';
import {
  clearFlash,
  dom,
  F,
  fileRow,
  flashText,
  fx,
  liveSession,
  resetPanel,
  root,
} from '../helpers/ui-files-panel-fixture.ts';

beforeEach(resetPanel);

// ---------------------------------------------------------------------------
// After a copy, and the clipboard (part B10)
// ---------------------------------------------------------------------------

test('refreshAfterDrop re-reads the ROOT the copy landed in', async () => {
  await liveSession();
  fx.entryCalls.length = 0;
  F.refreshAfterDrop({ path: PROJ, name: 'api' });
  await settle();
  assert.deepEqual(fx.entryCalls, [PROJ], 'exactly one listing, for the folder that changed');
});

test('refreshAfterDrop re-reads an OPEN folder, and asks for nothing else', async () => {
  await liveSession();
  fx.entryCalls.length = 0;
  F.refreshAfterDrop({ path: `${PROJ}/web`, name: 'web' });
  await settle();
  assert.deepEqual(fx.entryCalls, [`${PROJ}/web`]);
});

test('a copy into a folder nobody opened costs NO request at all', async () => {
  await liveSession();
  fx.entryCalls.length = 0;
  // `shared` is in the tree and has never been expanded: there is no listing
  // of it on screen, so re-reading it would be a request thrown away.
  F.refreshAfterDrop({ path: `${PROJ}/shared`, name: 'shared' });
  await settle();
  assert.deepEqual(fx.entryCalls, []);
  // Nor does a folder of another root, or one that is not in the tree at all.
  F.refreshAfterDrop({ path: '/somewhere/else', name: 'else' });
  await settle();
  assert.deepEqual(fx.entryCalls, []);
});

test('the copy that landed is on screen after ONE refresh', async () => {
  await liveSession();
  (fx.tree.get(`${PROJ}/web`) ?? []).push({ name: 'dropped.txt', dir: false });
  F.refreshAfterDrop({ path: `${PROJ}/web`, name: 'web' });
  await settle();
  assert.ok(
    textsOf(root, 'files-name').includes('dropped.txt'),
    'the panel shows what the drop put there',
  );
});

test('Copy on a row: the BACKEND maps the path, the host gets it, and the flash names the row', async () => {
  await liveSession();
  const win = dom.win as unknown as { chrome?: { webview: unknown } };
  const posted: string[] = [];
  const listeners: ((e: { data?: unknown }) => void)[] = [];
  win.chrome = {
    webview: {
      postMessage: (m: string) => posted.push(m),
      addEventListener: (_t: string, fn: (e: { data?: unknown }) => void) => listeners.push(fn),
      removeEventListener: (_t: string, fn: (e: { data?: unknown }) => void) => {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      },
    },
  };
  try {
    dispatch(fileRow('README.md'), 'contextmenu', { clientX: 10, clientY: 10 });
    const copy = byClass(dom.body, 'cm-item').find((b) => b.textContent.startsWith('Copy'));
    assert.ok(copy !== undefined, 'non-vacuity: the menu is open and carries the entry');
    assert.equal(copy.getAttribute('aria-disabled'), null, 'a native window can copy');
    copy.click();
    await settle();
    assert.deepEqual(fx.winPathCalls, [`${PROJ}/README.md`], 'the mapping is the server s');
    assert.deepEqual(posted, ['copy-files\n\\\\wsl.localhost\\Ubuntu\\work\\api\\README.md']);
    for (const fn of [...listeners]) fn({ data: 'copy-files ok 1' });
    await settle();
    assert.equal(flashText(), 'Copied README.md to the clipboard.', 'by NAME, never by path');
  } finally {
    delete win.chrome;
    clearFlash();
  }
});

test('Copy that the host refuses says so, in one sentence, whatever went wrong', async () => {
  await liveSession();
  const win = dom.win as unknown as { chrome?: unknown };
  try {
    // No host at all: the entry is visibly disabled and nothing is asked for.
    dispatch(fileRow('README.md'), 'contextmenu', { clientX: 10, clientY: 10 });
    const copy = byClass(dom.body, 'cm-item').find((b) => b.textContent.startsWith('Copy'));
    assert.equal(copy?.getAttribute('aria-disabled'), 'true');
    assert.ok(
      copy?.textContent.includes('This window cannot put files on the clipboard.'),
      `the note is the one the model owns: ${copy?.textContent}`,
    );
    copy?.click();
    await settle();
    assert.deepEqual(fx.winPathCalls, [], 'a disabled entry asks the server nothing');
    assert.equal(flashText(), '');

    // A host that IS there, and a path the backend will not map (422).
    win.chrome = {
      webview: {
        postMessage: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    };
    fx.winPathFails = new FakeApiError(422, 'That file cannot be reached from Windows.');
    dispatch(fileRow('README.md'), 'contextmenu', { clientX: 10, clientY: 10 });
    const live = byClass(dom.body, 'cm-item').find((b) => b.textContent.startsWith('Copy'));
    assert.equal(live?.getAttribute('aria-disabled'), null);
    live?.click();
    await settle();
    assert.equal(flashText(), 'The app could not copy that to the clipboard.');
    assert.equal(flashText().includes('/'), false, 'and it carries no path');
  } finally {
    delete win.chrome;
    clearFlash();
  }
});
