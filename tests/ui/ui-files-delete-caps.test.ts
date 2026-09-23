/**
 * The hundred-row cap of Nocturne part B10a
 * (`memory/decisions/b10a-multi-select-and-delete.md`), for Delete and for
 * Copy alike, and Copy on a selection (part D4): one list to the host, and a
 * count that says how many really went.
 *
 * Driven through the REAL `web/src/ui/files.ts`, `ui/context-menu.ts`,
 * `ui/delete-dialog.ts` and `ui/statusline.ts` on the DOM double, against the
 * fake `FsGateway` of `tests/helpers/fs-fixture.ts` (shared setup:
 * `tests/helpers/ui-files-delete-fixture.ts`). Split from
 * `tests/ui/ui-files-delete.test.ts`.
 *
 * Why: a batch over the cap refused only by the server has already cost the
 * user a confirmation; a copy count that includes paths with no Windows form
 * says more went than did.
 *
 * NOT claimed (browser work, `.claude/skills/verify-terminal/SKILL.md`): that
 * the chosen rows are legible, that the dialog is readable, that a real Enter
 * activates a `<button>` (the fake DOM has no activation behaviour), and
 * screen-reader output.
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { byKey, dispatch, FakeElement } from '../helpers/fake-dom.ts';
import { FakeApiError, PROJ, settle } from '../helpers/fs-fixture.ts';
import {
  fx,
  dom,
  DD,
  root,
  flashText,
  until,
  clearFlash,
  liveSession,
  dirRow,
  fileRow,
  rowKeys,
  rightClick,
  menuEntry,
  dialogTitle,
  dialogButton,
  pressDelete,
  resetWorld,
} from '../helpers/ui-files-delete-fixture.ts';

beforeEach(async () => {
  await resetWorld();
});

// ---------------------------------------------------------------------------
// The caps
// ---------------------------------------------------------------------------

test('over a hundred rows: the app refuses before the request, for Delete and for Copy alike', async () => {
  // A folder the server answers with 101 files: `ctrl+a` then covers more rows
  // than one batch may carry, and the client says so instead of watching the
  // whole batch bounce off the boundary.
  const many = Array.from({ length: 101 }, (_, i) => ({ name: `f${i}.txt`, dir: false }));
  fx.tree.set(PROJ, many);
  await liveSession();
  assert.ok(rowKeys().length > 100, `non-vacuity: ${rowKeys().length} rows`);

  dispatch(root, 'keydown', { key: 'a', ctrlKey: true });
  pressDelete();
  assert.equal(flashText(), 'Too many items. Delete up to 100 at a time.');
  assert.equal(DD.isDeleteDialogOpen(), false);
  assert.deepEqual(fx.deleteCalls, []);

  clearFlash();
  // `Copy` is live only in the native window, so the host channel is there —
  // and the refusal still comes BEFORE the first mapping.
  const win = dom.win as unknown as { chrome?: { webview: unknown } };
  win.chrome = {
    webview: { postMessage: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
  };
  try {
    const first = byKey(root, `ffile:${PROJ}/f0.txt`) as FakeElement;
    rightClick(first);
    menuEntry('Copy').click();
    await settle();
    assert.equal(flashText(), 'Too many items. Copy up to 100 at a time.');
    assert.deepEqual(fx.winPathCalls, [], 'and not one path was mapped');
  } finally {
    delete win.chrome;
  }
});

test('exactly a hundred rows is the batch the app still takes — for Delete and for Copy alike', async () => {
  // The cap is a LIMIT, not a forbidden number: `MAX_DELETE_ITEMS` items go
  // through in ONE request, and the refusal begins one row later (the test
  // above). An off-by-one here is a hundred rows a user may never delete, with
  // a sentence blaming them for it — and the server would have taken them.
  const many = Array.from({ length: 100 }, (_, i) => ({ name: `f${i}.txt`, dir: false }));
  fx.tree.set(PROJ, many);
  await liveSession();
  assert.equal(rowKeys().length, 100, 'non-vacuity: the tree draws exactly the cap');

  const win = dom.win as unknown as { chrome?: { webview: unknown } };
  const listeners: ((e: { data?: unknown }) => void)[] = [];
  win.chrome = {
    webview: {
      postMessage: () => {},
      addEventListener: (_t: string, fn: (e: { data?: unknown }) => void) => listeners.push(fn),
      removeEventListener: () => {},
    },
  };
  try {
    dispatch(root, 'keydown', { key: 'a', ctrlKey: true });
    rightClick(byKey(root, `ffile:${PROJ}/f0.txt`) as FakeElement);
    menuEntry('Copy').click();
    await settle();
    // `settle()` drains a fixed number of microtask turns; a hundred mappings
    // in sequence need more than one pass, so the wait is on the CONDITION
    // with a bound, never on a duration.
    await until(() => fx.winPathCalls.length === 100);
    assert.equal(fx.winPathCalls.length, 100, 'every chosen row is mapped, none refused');
    for (const fn of [...listeners]) fn({ data: 'copy-files ok 100' });
    await settle();
    assert.equal(flashText(), 'Copied 100 items to the clipboard.');
    clearFlash();
  } finally {
    delete win.chrome;
  }

  dispatch(root, 'keydown', { key: 'a', ctrlKey: true });
  pressDelete();
  assert.equal(dialogTitle(), 'Delete 100 items from api? This cannot be undone.');
  dialogButton('Delete').click();
  await until(() => fx.deleteCalls.length > 0);
  assert.equal(fx.deleteCalls.length, 1, 'one request for the whole hundred');
  assert.equal((fx.deleteCalls[0] as string[]).length, 100);
  assert.equal(flashText(), 'Deleted 100 items.');
  clearFlash();
});

// ---------------------------------------------------------------------------
// Copy, on a selection (part D4)
// ---------------------------------------------------------------------------

test('Copy on three chosen rows maps three paths, hands the host ONE list, and counts them', async () => {
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
    fileRow('README.md').click();
    dispatch(fileRow('LICENSE'), 'click', { ctrlKey: true });
    dispatch(dirRow('server'), 'click', { ctrlKey: true });
    rightClick(fileRow('README.md'));
    menuEntry('Copy').click();
    await settle();

    assert.deepEqual(fx.winPathCalls, [
      `${PROJ}/server`,
      `${PROJ}/README.md`,
      `${PROJ}/LICENSE`,
    ], 'one mapping per chosen row, in tree order');
    assert.equal(posted.length, 1, 'and ONE message to the host: one clipboard, one list');
    assert.equal(posted[0]?.split('\n').length, 4, 'the kind line plus three paths');
    for (const fn of [...listeners]) fn({ data: 'copy-files ok 3' });
    await settle();
    assert.equal(flashText(), 'Copied 3 items to the clipboard.', 'a count, never a path');
  } finally {
    delete win.chrome;
    clearFlash();
  }
});

test('Copy where one path has no Windows form says how many really went', async () => {
  await liveSession();
  const win = dom.win as unknown as { chrome?: { webview: unknown } };
  const listeners: ((e: { data?: unknown }) => void)[] = [];
  win.chrome = {
    webview: {
      postMessage: () => {},
      addEventListener: (_t: string, fn: (e: { data?: unknown }) => void) => listeners.push(fn),
      removeEventListener: () => {},
    },
  };
  try {
    fileRow('README.md').click();
    dispatch(fileRow('LICENSE'), 'click', { ctrlKey: true });
    // The 422 a path with no Windows form really gets.
    fx.winPathFails = new FakeApiError(422, 'That folder has no Windows path.');
    rightClick(fileRow('README.md'));
    menuEntry('Copy').click();
    await settle();
    assert.equal(flashText(), 'The app could not copy that to the clipboard.', 'nothing mapped at all');

    clearFlash();
    fx.winPathFails = null;
    let calls = 0;
    const real = fx.gateway.winPath.bind(fx.gateway);
    fx.gateway.winPath = (path: string) => {
      calls += 1;
      return calls === 1 ? Promise.reject(new FakeApiError(422, 'no')) : real(path);
    };
    rightClick(fileRow('README.md'));
    menuEntry('Copy').click();
    await settle();
    for (const fn of [...listeners]) fn({ data: 'copy-files ok 1' });
    await settle();
    assert.equal(flashText(), 'Copied 1 of 2 items to the clipboard.');
    fx.gateway.winPath = real;
  } finally {
    delete win.chrome;
    clearFlash();
  }
});
