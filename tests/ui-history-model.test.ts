/**
 * `groupHistory` in `web/src/ui/history.ts` — the sessions drawer's HISTORY
 * section groups ended sessions into a FOLDER PER PROJECT (user's request
 * 2026-09-06: "not loose sessions, in a folder per project").
 *
 * The function is pure and takes the project-name lookup as a parameter, so it
 * imports no DOM and this file can drive it under plain `node --test`. What is
 * pinned here is the grouping RULE, not the drawer markup:
 *   - a project the app still knows → one folder under the project's NAME;
 *   - a project id it no longer knows, or none at all → one folder per cwd,
 *     labelled with the directory's last segment (never the full path);
 *   - folders ordered by their newest entry, entries newest first.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { HistoryEntry } from '../shared/protocol.ts';
import { groupHistory } from '../web/src/ui/history.ts';

function entry(over: Partial<HistoryEntry> & { id: string; lastUsedAt: string }): HistoryEntry {
  return {
    conversation: true,
    sessionId: `s-${over.id}`,
    cwd: '/home/sava/projects/web-ui',
    command: 'claude',
    args: ['--model', 'opus'],
    title: over.id,
    createdAt: over.lastUsedAt,
    ended: { at: over.lastUsedAt, reason: 'exit' },
    ...over,
  };
}

/** Two known projects; anything else is unknown to the app. */
const NAMES: Record<string, string> = { p1: 'Web UI', p2: 'Session Manager' };
const nameOf = (id: string | undefined): string | null =>
  id !== undefined && NAMES[id] !== undefined ? NAMES[id] : null;

test('groupHistory: entries of one project collapse into one folder under the project NAME', () => {
  const groups = groupHistory(
    [
      entry({ id: 'a', projectId: 'p1', lastUsedAt: '2026-09-06T10:00:00.000Z' }),
      entry({ id: 'b', projectId: 'p1', lastUsedAt: '2026-09-06T09:00:00.000Z' }),
    ],
    nameOf,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.label, 'Web UI');
  assert.equal(groups[0]?.key, 'p:p1');
  assert.deepEqual(groups[0]?.entries.map((e) => e.id), ['a', 'b']);
});

test('groupHistory: a project id the app no longer knows falls back to a cwd folder, labelled with the last segment only', () => {
  const groups = groupHistory(
    [
      entry({
        id: 'a',
        projectId: 'gone',
        cwd: '/home/sava/projects/deleted-thing',
        lastUsedAt: '2026-09-06T10:00:00.000Z',
      }),
    ],
    nameOf,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.label, 'deleted-thing', 'a folder the app cannot name is still a folder');
  assert.equal(groups[0]?.key, 'c:/home/sava/projects/deleted-thing');
  assert.ok(!groups[0]?.label.includes('/'), 'a group label is never a path');
});

test('groupHistory: entries with no projectId group by cwd — two directories, two folders', () => {
  const groups = groupHistory(
    [
      entry({ id: 'a', cwd: '/tmp/one', lastUsedAt: '2026-09-06T10:00:00.000Z' }),
      entry({ id: 'b', cwd: '/tmp/two', lastUsedAt: '2026-09-06T09:00:00.000Z' }),
      entry({ id: 'c', cwd: '/tmp/one', lastUsedAt: '2026-09-06T08:00:00.000Z' }),
    ],
    nameOf,
  );
  assert.deepEqual(groups.map((g) => g.label), ['one', 'two']);
  assert.deepEqual(groups[0]?.entries.map((e) => e.id), ['a', 'c']);
});

test('groupHistory: the same cwd under a KNOWN project and under none stay separate folders', () => {
  // The project folder is the one the user thinks in; an entry the app can no
  // longer attribute must not be silently folded into it.
  const groups = groupHistory(
    [
      entry({ id: 'a', projectId: 'p1', cwd: '/x/web-ui', lastUsedAt: '2026-09-06T10:00:00.000Z' }),
      entry({ id: 'b', cwd: '/x/web-ui', lastUsedAt: '2026-09-06T09:00:00.000Z' }),
    ],
    nameOf,
  );
  assert.deepEqual(groups.map((g) => g.key), ['p:p1', 'c:/x/web-ui']);
});

test('groupHistory: folders are ordered by their NEWEST entry, whatever order the server sent', () => {
  const groups = groupHistory(
    [
      entry({ id: 'old', projectId: 'p1', lastUsedAt: '2026-09-01T10:00:00.000Z' }),
      entry({ id: 'new', projectId: 'p2', cwd: '/x/sm', lastUsedAt: '2026-09-06T10:00:00.000Z' }),
      entry({ id: 'mid', projectId: 'p1', lastUsedAt: '2026-09-04T10:00:00.000Z' }),
    ],
    nameOf,
  );
  assert.deepEqual(groups.map((g) => g.label), ['Session Manager', 'Web UI']);
  assert.deepEqual(groups[1]?.entries.map((e) => e.id), ['mid', 'old']);
});

test('groupHistory: entries inside a folder are newest first even when the input is ascending', () => {
  const groups = groupHistory(
    [
      entry({ id: 'a', projectId: 'p1', lastUsedAt: '2026-09-01T10:00:00.000Z' }),
      entry({ id: 'b', projectId: 'p1', lastUsedAt: '2026-09-02T10:00:00.000Z' }),
      entry({ id: 'c', projectId: 'p1', lastUsedAt: '2026-09-03T10:00:00.000Z' }),
    ],
    nameOf,
  );
  assert.deepEqual(groups[0]?.entries.map((e) => e.id), ['c', 'b', 'a']);
});

test('groupHistory: an unparsable lastUsedAt sorts last instead of throwing or reordering everything', () => {
  const groups = groupHistory(
    [
      entry({ id: 'bad', projectId: 'p1', lastUsedAt: 'nonsense' }),
      entry({ id: 'good', projectId: 'p1', lastUsedAt: '2026-09-03T10:00:00.000Z' }),
    ],
    nameOf,
  );
  assert.deepEqual(groups[0]?.entries.map((e) => e.id), ['good', 'bad']);
});

test('groupHistory: an empty list produces no folders (the section renders nothing at all)', () => {
  assert.deepEqual(groupHistory([], nameOf), []);
});

test('groupHistory: every entry lands in exactly one folder — nothing is dropped or duplicated', () => {
  const input = [
    entry({ id: 'a', projectId: 'p1', lastUsedAt: '2026-09-06T10:00:00.000Z' }),
    entry({ id: 'b', projectId: 'p2', cwd: '/x/sm', lastUsedAt: '2026-09-05T10:00:00.000Z' }),
    entry({ id: 'c', cwd: '/tmp/loose', lastUsedAt: '2026-09-04T10:00:00.000Z' }),
    entry({ id: 'd', projectId: 'p1', lastUsedAt: '2026-09-03T10:00:00.000Z' }),
  ];
  const ids = groupHistory(input, nameOf).flatMap((g) => g.entries.map((e) => e.id));
  assert.equal(ids.length, input.length);
  assert.deepEqual([...ids].sort(), ['a', 'b', 'c', 'd']);
});

test('groupHistory: two sessions of a DELETED project land in ONE folder — a deleted project keeps its history together', () => {
  // The user deleted the project; both of its sessions ran in the same folder,
  // so they must still read as that one folder rather than as loose entries.
  const groups = groupHistory(
    [
      entry({
        id: 'a',
        projectId: 'gone',
        cwd: '/home/sava/projects/deleted-thing',
        lastUsedAt: '2026-09-06T10:00:00.000Z',
      }),
      entry({
        id: 'b',
        projectId: 'gone',
        cwd: '/home/sava/projects/deleted-thing',
        lastUsedAt: '2026-09-04T10:00:00.000Z',
      }),
    ],
    nameOf,
  );
  assert.equal(groups.length, 1, 'both entries belong to the same (unnamed) folder');
  assert.equal(groups[0]?.key, 'c:/home/sava/projects/deleted-thing');
  assert.equal(groups[0]?.label, 'deleted-thing');
  assert.deepEqual(groups[0]?.entries.map((e) => e.id), ['a', 'b']);
});

test('groupHistory: an unknown project id groups by CWD, so its sessions in two folders stay two folders', () => {
  // The fallback key is the directory, never the dead project id: two folders
  // the app can no longer name must not be merged just because one deleted
  // project once covered both.
  const groups = groupHistory(
    [
      entry({ id: 'a', projectId: 'gone', cwd: '/x/api', lastUsedAt: '2026-09-06T10:00:00.000Z' }),
      entry({ id: 'b', projectId: 'gone', cwd: '/x/web', lastUsedAt: '2026-09-05T10:00:00.000Z' }),
    ],
    nameOf,
  );
  assert.deepEqual(groups.map((g) => g.key), ['c:/x/api', 'c:/x/web']);
  assert.deepEqual(groups.map((g) => g.label), ['api', 'web']);
});

test('groupHistory: a KNOWN project keeps its folder even when its sessions ran in different directories', () => {
  // The mirror image of the test above: with a project id the app still knows,
  // the PROJECT is the folder — the cwd does not split it.
  const groups = groupHistory(
    [
      entry({ id: 'a', projectId: 'p1', cwd: '/x/web-ui', lastUsedAt: '2026-09-06T10:00:00.000Z' }),
      entry({ id: 'b', projectId: 'p1', cwd: '/x/web-ui/sub', lastUsedAt: '2026-09-05T10:00:00.000Z' }),
    ],
    nameOf,
  );
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.key, 'p:p1');
  assert.equal(groups[0]?.label, 'Web UI');
});

test('groupHistory: the input array and its entries are never mutated (the drawer re-renders from state)', () => {
  const input = [
    entry({ id: 'a', projectId: 'p1', lastUsedAt: '2026-09-01T10:00:00.000Z' }),
    entry({ id: 'b', projectId: 'p1', lastUsedAt: '2026-09-03T10:00:00.000Z' }),
  ];
  const snapshot = JSON.stringify(input);
  const groups = groupHistory(input, nameOf);
  assert.deepEqual(groups[0]?.entries.map((e) => e.id), ['b', 'a'], 'the OUTPUT is sorted');
  assert.deepEqual(input.map((e) => e.id), ['a', 'b'], 'the INPUT order is untouched');
  assert.equal(JSON.stringify(input), snapshot, 'no entry was mutated in place');
});
