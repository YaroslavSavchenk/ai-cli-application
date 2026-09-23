/**
 * `web/src/ui/fs-model.ts` — the pure half of part B2 + A9c
 * (`.claude/plans/nocturne/PLAN-B2.md` §3, §4, §6b, §7, §9): the rules that decide what a
 * REAL folder tree looks like on screen, where files land, and which typed
 * names are allowed to become files.
 *
 * WHY here and not in a DOM test: this is the half that can be wrong without
 * looking wrong. A tree drawn from a cache mid-flight, a root change that must
 * not leave a selection pointing outside itself, and a name rule that must
 * agree with the server's to the byte — none of those is visible in a
 * screenshot, and all of them decide where a user's files end up. Pinning them
 * here means `ui/files.ts` can be rewired, twice, without re-deciding any of
 * it.
 *
 * The name rules are checked against the REAL `server/fsbrowse.ts`
 * `isSafeSegment`, not against a copy of its wording: §6b says the client
 * "mirrors isSafeSegment exactly", and the only way that claim can survive a
 * change to either side is if one test imports both.
 *
 * NOT claimed here (needs a browser, `.claude/skills/verify-terminal/SKILL.md`,
 * and Briefs B/C): that a row is drawn at the indent it states, that a state
 * row is a `<div>` and not a button, that the name row takes the keyboard, or
 * that one byte is ever read from the disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeSegment } from '../../server/fsbrowse.ts';
import type { ChangedFile } from '../../shared/protocol.ts';
import { buildTree, treeRows, type FileChange } from '../../web/src/ui/files-model.ts';
import {
  EMPTY_TEXT,
  LOADING_TEXT,
  MAX_NAME_LEN,
  NO_CHANGES_TEXT,
  changesToFiles,
  createRowIndex,
  destinationOf,
  fsRows,
  isUnder,
  joinPath,
  nameProblem,
  nameProblemText,
  parentPath,
  truncatedText,
  type FolderState,
  type FsRow,
  type NameProblem,
} from '../../web/src/ui/fs-model.ts';

/** Every sentence this module can build, for the copy sweep at the bottom. */
const PRODUCED: string[] = [];
const say = (s: string): string => {
  PRODUCED.push(s);
  return s;
};

// ---------------------------------------------------------------------------
// Names — A9c, §6b
// ---------------------------------------------------------------------------

test('nameProblem: an ordinary name has no problem', () => {
  assert.equal(nameProblem('notes.md'), null);
  assert.equal(nameProblem('Session Manager'), null);
  assert.equal(nameProblem('a'), null);
});

test('nameProblem: a LEADING dot passes — .env and .gitignore are things people create', () => {
  // §1b: hidden names are allowed on purpose; only an all-dots name is refused.
  assert.equal(nameProblem('.env'), null);
  assert.equal(nameProblem('.gitignore'), null);
  assert.equal(nameProblem('.claude'), null);
  assert.equal(nameProblem('..hidden'), null);
});

test('nameProblem: an empty name says to type one', () => {
  assert.equal(nameProblem(''), 'empty');
  assert.equal(say(nameProblemText('empty')), 'Type a name first.');
});

test('nameProblem: either slash is the same refusal — a name is not a path', () => {
  assert.equal(nameProblem('a/b'), 'slash');
  assert.equal(nameProblem('a\\b'), 'slash');
  assert.equal(nameProblem('/'), 'slash');
  assert.equal(nameProblem('../escape'), 'slash');
  assert.equal(say(nameProblemText('slash')), 'A name cannot contain a slash.');
});

test('nameProblem: an all-dots name is refused — that is how a name becomes a direction', () => {
  assert.equal(nameProblem('.'), 'dots');
  assert.equal(nameProblem('..'), 'dots');
  assert.equal(nameProblem('...'), 'dots');
  assert.equal(say(nameProblemText('dots')), 'That name is not allowed.');
});

test('nameProblem: any byte below 0x20 is refused, and says the same thing as an all-dots name', () => {
  assert.equal(nameProblem('a\u0000b'), 'control');
  assert.equal(nameProblem('a\nb'), 'control');
  assert.equal(nameProblem('a\u001fb'), 'control');
  assert.equal(say(nameProblemText('control')), 'That name is not allowed.');
});

test('nameProblem: 255 characters is a name, 256 is too long', () => {
  assert.equal(MAX_NAME_LEN, 255);
  assert.equal(nameProblem('a'.repeat(MAX_NAME_LEN)), null);
  assert.equal(nameProblem('a'.repeat(MAX_NAME_LEN + 1)), 'too-long');
  assert.equal(say(nameProblemText('too-long')), 'That name is too long.');
  // The ORDER is isSafeSegment's own: length is judged before the separators,
  // so a name that breaks both rules is told the first thing it broke.
  assert.equal(nameProblem(`${'a'.repeat(MAX_NAME_LEN)}/b`), 'too-long');
});

test('nameProblem: nothing is trimmed — the server does not trim either', () => {
  // A client that trimmed would post a name the user did not type, or refuse
  // one the server accepts. Both are worse than a folder called "  ".
  assert.equal(nameProblem('  '), null);
  assert.equal(nameProblem(' notes.md '), null);
  assert.equal(isSafeSegment('  '), true);
});

test('nameProblem mirrors server/fsbrowse.ts isSafeSegment on every shape either side cares about', () => {
  // §6b: the client rules exist so the ordinary mistakes cost no request. The
  // moment the two disagree, the panel either refuses what the backend would
  // have created or posts what it will certainly refuse.
  const corpus = [
    '',
    'a',
    'notes.md',
    '.env',
    '.gitignore',
    '..hidden',
    '.',
    '..',
    '...',
    '....',
    'a/b',
    'a\\b',
    '/',
    '\\',
    'a\u0000b',
    'a\nb',
    'a\tb',
    'a\u001fb',
    'ab',
    ' ',
    '  a  ',
    'node_modules',
    'файл.txt',
    '日本語',
    'a'.repeat(MAX_NAME_LEN),
    'a'.repeat(MAX_NAME_LEN + 1),
  ];
  const disagreements = corpus.filter((n) => (nameProblem(n) === null) !== isSafeSegment(n));
  assert.deepEqual(disagreements, [], 'the client rules must accept exactly what the server accepts');
  // Non-vacuity: the corpus really contains both verdicts.
  assert.ok(corpus.some((n) => nameProblem(n) === null), 'no accepted name in the corpus');
  assert.ok(corpus.some((n) => nameProblem(n) !== null), 'no refused name in the corpus');
});

// ---------------------------------------------------------------------------
// Path arithmetic — §4
// ---------------------------------------------------------------------------

test('joinPath places exactly one separator, at the filesystem root too', () => {
  assert.equal(joinPath('/home/you', 'notes.md'), '/home/you/notes.md');
  assert.equal(joinPath('/home/you/', 'notes.md'), '/home/you/notes.md');
  assert.equal(joinPath('/', 'home'), '/home');
});

test('parentPath: one level up, and the root is its own parent', () => {
  assert.equal(parentPath('/home/you/projects/web'), '/home/you/projects');
  assert.equal(parentPath('/home/you/projects/web/'), '/home/you/projects');
  assert.equal(parentPath('/home'), '/');
  assert.equal(parentPath('/'), '/');
});

test('isUnder: the root itself counts, and so does anything below it', () => {
  assert.equal(isUnder('/home/you', '/home/you'), true);
  assert.equal(isUnder('/home/you/', '/home/you'), true);
  assert.equal(isUnder('/home/you/projects/web/src', '/home/you'), true);
  assert.equal(isUnder('/home', '/'), true);
});

test('isUnder: a path that merely STARTS with the root is not under it (/home/youevil)', () => {
  // §8 item 1, the prefix trap: a bare startsWith would keep a selection and a
  // cache entry that belong to a different folder entirely, after a root change.
  assert.equal(isUnder('/home/youevil', '/home/you'), false);
  assert.equal(isUnder('/home/youevil/projects', '/home/you'), false);
  assert.equal(isUnder('/home/yo', '/home/you'), false);
  assert.equal(isUnder('/etc', '/home/you'), false);
});

test('destinationOf: at the ROOT the destination is called what the header calls it', () => {
  assert.deepEqual(destinationOf('/home/you', '/home/you', 'Home'), {
    path: '/home/you',
    name: 'Home',
  });
  assert.deepEqual(
    destinationOf('/home/you/projects/web', '/home/you/projects/web', 'Session Manager'),
    { path: '/home/you/projects/web', name: 'Session Manager' },
  );
});

test('destinationOf: below the root the name is the last segment, and the path is the real one', () => {
  assert.deepEqual(destinationOf('/home/you/projects/web/src', '/home/you', 'Home'), {
    path: '/home/you/projects/web/src',
    name: 'src',
  });
  assert.deepEqual(destinationOf('/home/you/Session Manager', '/home/you', 'Home'), {
    path: '/home/you/Session Manager',
    name: 'Session Manager',
  });
});

test('destinationOf: a trailing slash is TRIMMED, on the root row and below it', () => {
  // The trim is load-bearing twice over, so it gets its own claim: B10 posts
  // `.path` to the server, and a trailing slash is the one shape
  // resolveUnderAllowed() has never been handed; and untrimmed, the ROOT's own row
  // would stop matching its root and would lose the name the header prints.
  assert.deepEqual(destinationOf('/home/you/', '/home/you', 'Home'), {
    path: '/home/you',
    name: 'Home',
  });
  assert.deepEqual(destinationOf('/home/you/projects/web/', '/home/you', 'Home'), {
    path: '/home/you/projects/web',
    name: 'web',
  });
});

test('truncatedText: one item is singular, everything else is plural', () => {
  assert.equal(say(truncatedText(1)), '1 more item is not shown here.');
  assert.equal(say(truncatedText(2)), '2 more items are not shown here.');
  assert.equal(say(truncatedText(200)), '200 more items are not shown here.');
});

// ---------------------------------------------------------------------------
// fsRows — §3
// ---------------------------------------------------------------------------

const ROOT = '/home/you';

/** Three levels, a dotfile that a sorting client would move, and closed folders. */
function fixture(): Map<string, FolderState> {
  return new Map<string, FolderState>([
    [
      ROOT,
      {
        k: 'ready',
        entries: [
          { name: 'projects', dir: true },
          { name: '.bashrc', dir: false },
          { name: 'notes.md', dir: false },
        ],
        truncated: 0,
      },
    ],
    [
      '/home/you/projects',
      {
        k: 'ready',
        entries: [
          { name: 'web', dir: true },
          { name: 'server', dir: true },
          { name: 'README.md', dir: false },
        ],
        truncated: 0,
      },
    ],
    [
      '/home/you/projects/web',
      {
        k: 'ready',
        entries: [
          { name: 'src', dir: true },
          { name: 'index.html', dir: false },
        ],
        truncated: 0,
      },
    ],
    [
      '/home/you/projects/web/src',
      { k: 'ready', entries: [{ name: 'main.ts', dir: false }], truncated: 0 },
    ],
  ]);
}

const OPEN = new Set(['/home/you/projects', '/home/you/projects/web']);

const shape = (rows: readonly FsRow[]): string[] =>
  rows.map((r) => `${r.depth} ${r.kind} ${r.caret === '' ? '-' : r.caret} ${r.name}`);

test('fsRows: an open folder shows its children one level in, a closed one shows nothing', () => {
  assert.deepEqual(shape(fsRows(ROOT, OPEN, fixture())), [
    '0 dir ▾ projects',
    '1 dir ▾ web',
    '2 dir ▸ src',
    '2 file - index.html',
    '1 dir ▸ server',
    '1 file - README.md',
    '0 file - .bashrc',
    '0 file - notes.md',
  ]);
});

test('fsRows: the order is the SERVER’s, never re-sorted', () => {
  // §1a: the server sorts BECAUSE it truncates, so a client that re-ordered a
  // capped listing would re-order a window and make `truncated` a lie. A
  // sorting client would put `.bashrc` first and `server` before `web`.
  const rows = fsRows(ROOT, OPEN, fixture());
  const top = rows.filter((r) => r.depth === 0).map((r) => r.name);
  assert.deepEqual(top, ['projects', '.bashrc', 'notes.md']);
  const inProjects = rows.filter((r) => r.depth === 1).map((r) => r.name);
  assert.deepEqual(inProjects, ['web', 'server', 'README.md']);
});

test('fsRows: a folder path is its parent plus its name, so a row key is a real path', () => {
  const byName = new Map(fsRows(ROOT, OPEN, fixture()).map((r) => [r.name, r.path] as const));
  assert.equal(byName.get('projects'), '/home/you/projects');
  assert.equal(byName.get('src'), '/home/you/projects/web/src');
  assert.equal(byName.get('index.html'), '/home/you/projects/web/index.html');
});

test('fsRows: an open folder with no listing yet says Loading… at the CHILD indent', () => {
  const listings = fixture();
  listings.delete('/home/you/projects/web');
  const rows = fsRows(ROOT, new Set([...OPEN]), listings);
  const at = rows.findIndex((r) => r.name === 'web');
  const state = rows[at + 1] as FsRow;
  assert.deepEqual(
    { kind: state.kind, name: state.name, depth: state.depth, path: state.path },
    { kind: 'state', name: LOADING_TEXT, depth: 2, path: '' },
  );
});

test('fsRows: an explicit loading state draws the same row as no state at all', () => {
  const missing = fixture();
  missing.delete('/home/you/projects/web');
  const loading = fixture();
  loading.set('/home/you/projects/web', { k: 'loading' });
  assert.deepEqual(shape(fsRows(ROOT, OPEN, loading)), shape(fsRows(ROOT, OPEN, missing)));
});

test('fsRows: a ready folder with nothing in it says so, instead of looking unopened', () => {
  const listings = fixture();
  listings.set('/home/you/projects/web', { k: 'ready', entries: [], truncated: 0 });
  const rows = fsRows(ROOT, OPEN, listings);
  const at = rows.findIndex((r) => r.name === 'web');
  assert.deepEqual(shape(rows.slice(at, at + 2)), ['1 dir ▾ web', `2 state - ${EMPTY_TEXT}`]);
});

test('fsRows: a failed folder shows the SERVER’s sentence, verbatim, in its own slot', () => {
  // §1d + §2: a symlink out of home is listed but not enterable, and the
  // backend's own sentence is what the row says. Nothing here rewrites it.
  const listings = fixture();
  listings.set('/home/you/projects/web', {
    k: 'error',
    message: 'This folder is outside your home folder.',
  });
  const rows = fsRows(ROOT, OPEN, listings);
  const at = rows.findIndex((r) => r.name === 'web');
  const state = rows[at + 1] as FsRow;
  assert.equal(state.kind, 'state');
  assert.equal(state.name, 'This folder is outside your home folder.');
  assert.equal(state.depth, 2);
});

test('fsRows: a truncated folder says how many are missing, as its LAST child row', () => {
  const listings = fixture();
  listings.set('/home/you/projects/web', {
    k: 'ready',
    entries: [
      { name: 'src', dir: true },
      { name: 'index.html', dir: false },
    ],
    truncated: 200,
  });
  const rows = fsRows(ROOT, OPEN, listings);
  const at = rows.findIndex((r) => r.name === 'web');
  assert.deepEqual(shape(rows.slice(at, at + 4)), [
    '1 dir ▾ web',
    '2 dir ▸ src',
    '2 file - index.html',
    `2 state - ${truncatedText(200)}`,
  ]);
});

test('fsRows: the truncated row comes after an EXPANDED subtree, not in the middle of it', () => {
  const listings = fixture();
  listings.set('/home/you/projects/web', {
    k: 'ready',
    entries: [
      { name: 'src', dir: true },
      { name: 'index.html', dir: false },
    ],
    truncated: 1,
  });
  const rows = fsRows(ROOT, new Set([...OPEN, '/home/you/projects/web/src']), listings);
  const at = rows.findIndex((r) => r.name === 'web');
  assert.deepEqual(shape(rows.slice(at, at + 5)), [
    '1 dir ▾ web',
    '2 dir ▾ src',
    '3 file - main.ts',
    '2 file - index.html',
    `2 state - ${truncatedText(1)}`,
  ]);
});

test('fsRows: the ROOT’s own states replace the whole body, at depth 0', () => {
  for (const [state, text] of [
    [undefined, LOADING_TEXT],
    [{ k: 'loading' } as FolderState, LOADING_TEXT],
    [{ k: 'ready', entries: [], truncated: 0 } as FolderState, EMPTY_TEXT],
    [{ k: 'error', message: 'This folder is no longer there.' } as FolderState, 'This folder is no longer there.'],
  ] as const) {
    const listings = fixture();
    if (state === undefined) listings.delete(ROOT);
    else listings.set(ROOT, state);
    assert.deepEqual(shape(fsRows(ROOT, OPEN, listings)), [`0 state - ${text}`], text);
  }
});

test('fsRows: a truncated ROOT keeps its rows and adds the note last, at depth 0', () => {
  const listings = fixture();
  listings.set(ROOT, {
    k: 'ready',
    entries: [{ name: 'notes.md', dir: false }],
    truncated: 3,
  });
  assert.deepEqual(shape(fsRows(ROOT, OPEN, listings)), [
    '0 file - notes.md',
    `0 state - ${truncatedText(3)}`,
  ]);
});

test('fsRows: state rows carry no path — a sentence is not a place to drop files', () => {
  const listings = fixture();
  listings.set('/home/you/projects/web', { k: 'ready', entries: [], truncated: 0 });
  listings.delete('/home/you/projects/web/src');
  const rows = fsRows(ROOT, OPEN, listings);
  const states = rows.filter((r) => r.kind === 'state');
  assert.ok(states.length >= 1, 'no state row in the fixture');
  for (const s of states) {
    assert.equal(s.path, '');
    assert.equal(s.caret, '');
    assert.equal(s.open, false);
  }
});

test('fsRows: indent and caret are the A5 vocabulary, byte for byte, at every depth', () => {
  // The Files tab (this module) and the Changes tab (files-model.ts treeRows)
  // draw in the SAME panel: two indents that agree today and drift tomorrow
  // would be two trees in one column. `rowIndent`/`caretGlyph` are imported
  // from the A5 module, and this is the claim that says so out loud.
  const a5 = treeRows(
    buildTree([{ path: 'projects/web/src/main.ts' }]),
    new Set(['projects', 'projects/web', 'projects/web/src']),
  );
  const a5Indent = new Map(a5.map((r) => [r.depth, r.indent] as const));
  assert.deepEqual([...a5Indent.entries()].sort((x, y) => x[0] - y[0]), [
    [0, 8],
    [1, 22],
    [2, 36],
    [3, 50],
  ]);

  const rows = fsRows(ROOT, new Set([...OPEN, '/home/you/projects/web/src']), fixture());
  const seen = new Set<number>();
  for (const r of rows) {
    assert.equal(r.indent, a5Indent.get(r.depth), `depth ${r.depth}`);
    seen.add(r.depth);
  }
  assert.deepEqual([...seen].sort((x, y) => x - y), [0, 1, 2, 3], 'all four depths drawn');

  const a5Open = a5.find((r) => r.dir && r.open);
  const a5Closed = treeRows(buildTree([{ path: 'projects/web/src/main.ts' }]), new Set()).find(
    (r) => r.dir,
  );
  const fsOpen = rows.find((r) => r.kind === 'dir' && r.open);
  const fsClosed = fsRows(ROOT, OPEN, fixture()).find((r) => r.kind === 'dir' && !r.open);
  assert.equal(fsOpen?.caret, a5Open?.caret);
  assert.equal(fsClosed?.caret, a5Closed?.caret);
});

// ---------------------------------------------------------------------------
// createRowIndex — A9c, §6b
// ---------------------------------------------------------------------------

test('createRowIndex: the name row goes directly under the folder that will hold it', () => {
  const rows = fsRows(ROOT, OPEN, fixture());
  const at = rows.findIndex((r) => r.name === 'web');
  assert.equal(createRowIndex(rows, '/home/you/projects/web', ROOT), at + 1);
  assert.equal(
    createRowIndex(rows, '/home/you/projects', ROOT),
    rows.findIndex((r) => r.name === 'projects') + 1,
  );
  // A CLOSED folder that is on screen answers too: §6b expands it first, and
  // the name row then lands as its first child.
  assert.equal(
    createRowIndex(rows, '/home/you/projects/server', ROOT),
    rows.findIndex((r) => r.name === 'server') + 1,
  );
});

test('createRowIndex: the panel ROOT has no row of its own, so the name row is first', () => {
  const rows = fsRows(ROOT, OPEN, fixture());
  assert.equal(createRowIndex(rows, ROOT, ROOT), 0);
  assert.equal(createRowIndex(rows, `${ROOT}/`, ROOT), 0);
  assert.equal(createRowIndex([], ROOT, ROOT), 0);
});

test('createRowIndex: a folder that is not on screen answers -1 — the caller cancels', () => {
  const rows = fsRows(ROOT, OPEN, fixture());
  // Inside a CLOSED folder, so its own row is not drawn either.
  const shallow = fsRows(ROOT, new Set(['/home/you/projects']), fixture());
  assert.equal(createRowIndex(shallow, '/home/you/projects/web/src', ROOT), -1);
  // Gone from the listing entirely.
  assert.equal(createRowIndex(rows, '/home/you/projects/gone', ROOT), -1);
  // A FILE row with that path is not a folder row.
  assert.equal(createRowIndex(rows, '/home/you/notes.md', ROOT), -1);
});

// ---------------------------------------------------------------------------
// changesToFiles — §7
// ---------------------------------------------------------------------------

const changed = (o: Partial<ChangedFile> & { path: string }): ChangedFile => ({
  add: 0,
  del: 0,
  status: 'modified',
  ...o,
});

test('changesToFiles: a modified file keeps both numbers', () => {
  assert.deepEqual(changesToFiles([changed({ path: 'web/src/main.ts', add: 12, del: 3 })]), [
    { path: 'web/src/main.ts', add: 12, del: 3 },
  ]);
});

test('changesToFiles: a NEW file is numberless — the row a file without a diff has always been', () => {
  const files = changesToFiles([changed({ path: 'notes.md', status: 'new', add: null, del: null })]);
  assert.deepEqual(files, [{ path: 'notes.md' }] as FileChange[]);
  // And the A5 renderer draws it as one: no ink ramp, no `+N -N`.
  const row = treeRows(buildTree(files), new Set())[0];
  assert.equal(row?.hasDiff, false);
});

test('changesToFiles: a BINARY file is numberless too (numstat prints a dash)', () => {
  assert.deepEqual(changesToFiles([changed({ path: 'web/app.ico', add: null, del: null })]), [
    { path: 'web/app.ico' },
  ]);
});

test('changesToFiles: a DELETED file carries its removals and no additions', () => {
  const files = changesToFiles([changed({ path: 'old.ts', status: 'deleted', add: 0, del: 40 })]);
  assert.deepEqual(files, [{ path: 'old.ts', del: 40 }] as FileChange[]);
  assert.equal('add' in (files[0] as FileChange), false, 'nothing is added to a file that is gone');
});

test('changesToFiles: a RENAMED file is one row at its NEW path', () => {
  assert.deepEqual(
    changesToFiles([changed({ path: 'web/src/fs-model.ts', status: 'renamed', add: 4, del: 1 })]),
    [{ path: 'web/src/fs-model.ts', add: 4, del: 1 }],
  );
});

test('changesToFiles: nothing sets `editing`, so no row pulses (plan open decision 3)', () => {
  const files = changesToFiles([
    changed({ path: 'a.ts', add: 1, del: 1 }),
    changed({ path: 'b.ts', status: 'new', add: null, del: null }),
  ]);
  assert.deepEqual(files.filter((f) => f.editing !== undefined), []);
  assert.deepEqual(
    treeRows(buildTree(files), new Set()).filter((r) => r.busy),
    [],
  );
});

test('changesToFiles: an empty answer is an empty list, not a state', () => {
  assert.deepEqual(changesToFiles([]), []);
});

// ---------------------------------------------------------------------------
// Copy rules over everything this module can say
// ---------------------------------------------------------------------------

test('every sentence this module builds is plain: no path, no key name, no decorative separator', () => {
  const strings = [
    ...PRODUCED,
    LOADING_TEXT,
    EMPTY_TEXT,
    NO_CHANGES_TEXT,
    ...(['empty', 'slash', 'dots', 'control', 'too-long'] as NameProblem[]).map(nameProblemText),
    truncatedText(1),
    truncatedText(1000),
  ];
  assert.ok(strings.length >= 15, `non-vacuity: only ${strings.length} sentences swept`);
  for (const s of strings) {
    assert.ok(!s.includes('/'), `a path separator reached copy: ${JSON.stringify(s)}`);
    assert.ok(!s.includes('\\'), `a path separator reached copy: ${JSON.stringify(s)}`);
    assert.ok(!s.includes(' — '), `a decorative separator reached copy: ${JSON.stringify(s)}`);
    assert.ok(!s.includes(' · '), `a decorative separator reached copy: ${JSON.stringify(s)}`);
    assert.ok(!/--[A-Za-z]/.test(s), `a flag shape reached copy: ${JSON.stringify(s)}`);
    assert.ok(!/\bgit\b/.test(s), `a command name reached copy: ${JSON.stringify(s)}`);
  }
});

test('the state sentences are the ones §3 and §7 fixed, and they end in a full stop where they are sentences', () => {
  assert.equal(LOADING_TEXT, 'Loading…');
  assert.equal(EMPTY_TEXT, 'Empty folder');
  assert.equal(NO_CHANGES_TEXT, 'No changes since the last commit.');
});
