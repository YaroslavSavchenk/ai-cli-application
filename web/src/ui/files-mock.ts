/**
 * PLACEHOLDER CONTENT for the Files panel (Nocturne part A5).
 *
 * Nothing in this module is real. The panel is built visually first (plan
 * `.claude/PLAN-NOCTURNE.md`, part A5: "All data mocked/static"), and the two
 * parts that replace it are already named:
 *
 *   - part B2 — the file list and its numbers come from `git diff --numstat`
 *     for the active project, and `editing` comes from what the session is
 *     touching (open decision 3, the user's to make).
 *   - part B3 — the commits come from `git log` for the same project.
 *
 * The shapes below are therefore the shapes those parts will produce
 * (`ui/files-model.ts`), so landing them is a swap of this module's exports,
 * not a rewrite of the panel. The file list is deliberately FLAT: the tree is
 * derived, exactly as it will be from a numstat walk.
 *
 * Content is the v3 reference's own mock (`session-manager-v3.html`), with the
 * author changed to this repo's. The ONE live datum the panel shows is the
 * project name in its header, which comes from real state.
 */
import type { CommitEntry, FileChange } from './files-model.ts';

/** Placeholder until B2. Order is the reference's; the model preserves it. */
export const MOCK_FILES: FileChange[] = [
  { path: 'web/src/App.tsx', add: 41, del: 19 },
  { path: 'web/src/Pane.tsx', add: 87, del: 22, editing: true },
  { path: 'web/src/TabStrip.tsx' },
  { path: 'web/src/store.ts', add: 12, del: 4 },
  { path: 'web/DESIGN.md' },
  { path: 'web/package.json' },
  { path: 'server/pty-pool.ts', add: 6, del: 1 },
  { path: 'server/ws.ts' },
  { path: 'server/presence.ts' },
  { path: 'launcher/launch.ps1' },
  { path: 'launcher/make-icon.mjs' },
  { path: 'shared/protocol.ts', add: 30, del: 0 },
  { path: 'README.md' },
  // No extension the badge table knows: this is the row that renders the
  // neutral unknown-type chip, so the panel really shows every chip it can.
  { path: 'LICENSE' },
];

/** Placeholder until B2 — which folders start open. */
export const MOCK_OPEN_FOLDERS: string[] = ['web', 'web/src', 'server'];

/** Placeholder until B3. Newest first, as `git log` returns them. */
export const MOCK_COMMITS: CommitEntry[] = [
  {
    hash: '474d891',
    message: 'Define the update wire contract in shared/protocol.ts',
    author: 'Sava',
    when: '2 hours ago',
    add: 38,
    del: 2,
  },
  {
    hash: '9b2e1f0',
    message: 'Restart handoff: promote host/next on launcher start',
    author: 'Sava',
    when: 'Yesterday',
    add: 47,
    del: 12,
  },
  {
    hash: 'e07c5a2',
    message: 'Keep scrollback on reattach and replay buffered frames',
    author: 'Sava',
    when: 'Yesterday',
    add: 73,
    del: 21,
  },
  {
    hash: '1a8f0d3',
    message: 'Tab strip: merge by dragging a tab onto a pane',
    author: 'Sava',
    when: '2 days ago',
    add: 142,
    del: 43,
  },
  {
    hash: '55c9be7',
    message: 'Initial backend: node-pty sessions over WebSocket',
    author: 'Sava',
    when: '5 days ago',
    add: 346,
    del: 0,
  },
];

/** Placeholder until B3 — the branch the commits list is on. */
export const MOCK_BRANCH = 'main';
