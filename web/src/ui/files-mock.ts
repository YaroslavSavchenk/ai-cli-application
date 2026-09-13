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
import { commitTotals, pathSeed, syntheticDiff, type CommitFileChange } from './commit-model.ts';
import type { CommitEntry, FileChange } from './files-model.ts';

/**
 * Placeholder until B2. Order is the reference's; the model preserves it.
 *
 * The rows that CARRY numbers get them from `counted()` — the same count of
 * the same synthetic diff the commit view and the editor's Changes tab draw,
 * so no screen ever states a size another screen contradicts. The numberless
 * rows stay numberless on purpose: they are "listed but unchanged", which is a
 * different fact from "+0 -0". `MOCK_FILES` is built after `counted()` is
 * declared, at the bottom of this module.
 */
export const MOCK_FILES: FileChange[] = [];

/** The paths in MOCK_FILES, in the reference's order; `true` = carries numbers. */
const MOCK_FILE_ROWS: readonly (readonly [string, boolean])[] = [
  ['web/src/App.tsx', true],
  ['web/src/Pane.tsx', true],
  ['web/src/TabStrip.tsx', false],
  ['web/src/store.ts', true],
  ['web/DESIGN.md', false],
  ['web/package.json', false],
  ['server/pty-pool.ts', true],
  ['server/ws.ts', false],
  ['server/presence.ts', false],
  ['launcher/launch.ps1', false],
  ['launcher/make-icon.mjs', false],
  ['shared/protocol.ts', true],
  ['README.md', false],
  // No extension the badge table knows: this is the row that renders the
  // neutral unknown-type chip, so the panel really shows every chip it can.
  ['LICENSE', false],
];

/** The one file the panel draws as being edited right now (the amber pulse). */
const MOCK_EDITING = 'web/src/Pane.tsx';

/** Placeholder until B2 — which folders start open. */
export const MOCK_OPEN_FOLDERS: string[] = ['web', 'web/src', 'server'];

/**
 * PLACEHOLDER FILE CONTENTS for the editor and the commit view (part A6).
 *
 * Two things read this map: an editor file tab (the text in the textarea) and
 * `syntheticDiff()` (the rows a diff block draws). Part B4 replaces both reads
 * with the backend's own file read, and `saveMockFile()` with a write to disk.
 *
 * The texts are the v3 reference's own mock sources, kept short on purpose:
 * they exist to give the editor real line lengths, real indentation and enough
 * lines for a gutter — not to describe this repository. The one honest line
 * above the editor body says exactly that.
 */
const MOCK_FILE_CONTENTS = new Map<string, string>([
  [
    'web/src/Pane.tsx',
    `import { useEffect, useRef } from "react";
import { Terminal } from "xterm";
import { useSession } from "./store";

export function Pane({ id }: { id: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const session = useSession(id);

  useEffect(() => {
    const term = new Terminal({ fontFamily: "JetBrains Mono", fontSize: 12.5 });
    term.open(ref.current!);
    const off = session.attach(term);
    return () => { off(); term.dispose(); };
  }, [id]);

  return (
    <section className="pane">
      <PaneHeader session={session} />
      <div ref={ref} className="pane-terminal" />
      <StatusBar session={session} />
    </section>
  );
}
`,
  ],
  [
    'web/src/App.tsx',
    `import { TopBar } from "./TopBar";
import { TabStrip } from "./TabStrip";
import { Screen } from "./Screen";
import { useStore } from "./store";

export default function App() {
  const active = useStore(s => s.active);
  return (
    <div className="app">
      <TopBar />
      <Screen id={active} />
      <TabStrip />
    </div>
  );
}
`,
  ],
  [
    'shared/protocol.ts',
    `export interface AttachMessage {
  kind: "attach";
  id: string;
  scrollback: string;
}

export interface DataMessage {
  kind: "data";
  id: string;
  data: string;
}

export interface ResizeMessage {
  kind: "resize";
  id: string;
  cols: number;
  rows: number;
}
`,
  ],
  [
    'web/src/store.ts',
    `import { create } from "zustand";

export const useStore = create((set) => ({
  active: null,
  sessions: [],
  focus(id: string) {
    set({ active: id });
  },
  add(session: Session) {
    set((state) => ({ sessions: [...state.sessions, session] }));
  },
}));

export function useSession(id: string) {
  return useStore((state) => state.sessions.find((x) => x.id === id));
}
`,
  ],
  [
    'web/src/TabStrip.tsx',
    `import { useStore } from "./store";

export function TabStrip() {
  const sessions = useStore(s => s.sessions);
  const active = useStore(s => s.active);
  const focus = useStore(s => s.focus);

  return (
    <nav className="tabstrip">
      {sessions.map(s => (
        <button key={s.id} onClick={() => focus(s.id)} data-on={s.id === active}>
          {s.title}
        </button>
      ))}
    </nav>
  );
}
`,
  ],
  [
    'server/ws.ts',
    `import { WebSocketServer } from "ws";
import { pool } from "./pty-pool";

export function attachSockets(server) {
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", (socket, id) => {
    const session = pool.get(id);
    socket.send(session.scrollback());
    session.onData((data) => socket.send(data));
    socket.on("message", (raw) => session.write(raw));
  });

  return wss;
}
`,
  ],
  [
    'server/pty-pool.ts',
    `import { spawn } from "node-pty";

const sessions = new Map();

export const pool = {
  create(command, args, cwd, cols, rows) {
    const pty = spawn(command, args, { cwd, cols, rows, name: "xterm-256color" });
    const session = { pty, buffer: [] };
    pty.onData((data) => session.buffer.push(data));
    sessions.set(pty.pid, session);
    return session;
  },
  get(id) {
    return sessions.get(id);
  },
};
`,
  ],
  [
    'README.md',
    `# Session Manager

Run several terminal sessions side by side in one window.

Every session is a real terminal on this machine. Panes, tabs and layouts
are yours; the sessions keep running while you look at something else.

Start the app from the shortcut, then open a session from the top bar.
`,
  ],
  [
    'launcher/launch.ps1',
    `param([string]$Distro = "Ubuntu")

$ErrorActionPreference = "Stop"

function Get-Runtime {
  $file = Join-Path $HOME ".session-manager/runtime.json"
  if (-not (Test-Path $file)) {
    return $null
  }
  $raw = Get-Content $file -Raw
  return ConvertFrom-Json $raw
}

$runtime = Get-Runtime
if ($null -eq $runtime) {
  Write-Host "Starting the background service"
  Start-Service-Backend $Distro
  Start-Sleep -Seconds 2
  $runtime = Get-Runtime
}

Open-Window "http://127.0.0.1:$($runtime.port)"
`,
  ],
  [
    'launcher/make-icon.mjs',
    `import { readFile, writeFile } from "node:fs/promises";

const SIZES = [16, 32, 48, 256];

function header(count) {
  const buf = Buffer.alloc(6);
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(count, 4);
  return buf;
}

export async function makeIcon(source, target) {
  const images = [];
  for (const size of SIZES) {
    images.push(await readFile(source.replace("SIZE", String(size))));
  }
  const parts = [header(images.length), ...images];
  await writeFile(target, Buffer.concat(parts));
}
`,
  ],
]);

/**
 * The sentence a surface prints INSTEAD of a file it has no example of. It is
 * a note, never a line of that file: rendered as a diff row with a number and
 * a `+` beside it, it would read as content the file really has.
 */
export const NO_EXAMPLE_CONTENT = 'There is no example content for this file yet.';

/**
 * The text an editor tab or a diff block reads, or NULL when the mock knows
 * nothing about that path. Null rather than a sentence dressed as a file: the
 * two readers draw `NO_EXAMPLE_CONTENT` as a plain note (and the editor offers
 * no field to type in), which is the whole difference between "there is
 * nothing here" and "here is what is in it".
 */
export function mockFileContent(path: string): string | null {
  return MOCK_FILE_CONTENTS.get(path) ?? null;
}

/**
 * Save (part A6): the text goes back into the map above and nowhere else —
 * nothing on disk is touched. Part B4 replaces this with the backend write,
 * and the editor's Save button is already wired to it.
 */
export function saveMockFile(path: string, text: string): void {
  MOCK_FILE_CONTENTS.set(path, text);
}

/**
 * The numbers of one commit, COUNTED from the very diff its view will draw
 * rather than typed in beside it: `+A -D` per file, summed for the commit. A
 * mock whose header claimed `+346 -0` over a body full of red rows is the one
 * thing placeholder data must not do — it teaches the reader to distrust the
 * screen. Part B3 reads both from `git show --numstat` and deletes this.
 *
 * KNOWN MOCK-ONLY LIMIT: these numbers are counted ONCE, at module init, while
 * `saveMockFile()` can replace a file's text afterwards — so after a save the
 * redrawn diff and the frozen header can disagree until the page is reloaded.
 * Part B3 reads real numbers and part B4 writes to disk, which closes it; it is
 * not worth a recount path in placeholder data.
 */
function counted(path: string): CommitFileChange {
  let add = 0;
  let del = 0;
  for (const row of syntheticDiff(mockFileContent(path) ?? '', pathSeed(path))) {
    if (row.kind === 'add') add += 1;
    else if (row.kind === 'del') del += 1;
  }
  return { path, add, del };
}

function withCounts(paths: readonly string[]): {
  files: CommitFileChange[];
  add: number;
  del: number;
} {
  const files: CommitFileChange[] = paths.map(counted);
  return { files, ...commitTotals(files) };
}

/**
 * Placeholder until B3. Newest first, as `git log` returns them. Only the
 * words and the paths are written here; every number comes from `withCounts`,
 * so the Commits row, the view's header and the diff under it always agree —
 * and `MOCK_FILES` is counted the same way, so the Files tab's "since last
 * commit" numbers are the same kind of number about a different set of files.
 */
export const MOCK_COMMITS: CommitEntry[] = [
  {
    hash: '474d891',
    message: 'Define the update wire contract in shared/protocol.ts',
    author: 'Sava',
    when: '2 hours ago',
    ...withCounts(['shared/protocol.ts', 'server/ws.ts']),
  },
  {
    hash: '9b2e1f0',
    message: 'Restart handoff: promote host/next on launcher start',
    author: 'Sava',
    when: 'Yesterday',
    ...withCounts(['launcher/launch.ps1', 'launcher/make-icon.mjs']),
  },
  {
    hash: 'e07c5a2',
    message: 'Keep scrollback on reattach and replay buffered frames',
    author: 'Sava',
    when: 'Yesterday',
    ...withCounts(['server/pty-pool.ts', 'web/src/store.ts']),
  },
  {
    hash: '1a8f0d3',
    message: 'Tab strip: merge by dragging a tab onto a pane',
    author: 'Sava',
    when: '2 days ago',
    ...withCounts(['web/src/TabStrip.tsx', 'web/src/Pane.tsx']),
  },
  {
    hash: '55c9be7',
    message: 'Initial backend: node-pty sessions over WebSocket',
    author: 'Sava',
    when: '5 days ago',
    ...withCounts(['server/pty-pool.ts', 'server/ws.ts', 'README.md']),
  },
];

/**
 * The commit with this short hash, or null. The hash IS the identity (see
 * `CommitEntry`), so part B3 keeps this signature and reads `git show` instead.
 */
export function mockCommitByHash(hash: string | null): CommitEntry | null {
  if (hash === null) return null;
  return MOCK_COMMITS.find((c) => c.hash === hash) ?? null;
}

/** Placeholder until B3 — the branch the commits list is on. */
export const MOCK_BRANCH = 'main';

// `MOCK_FILES` is filled here, not at its declaration: `counted()` reads
// `mockFileContent()`, which reads the map declared between the two.
for (const [path, numbered] of MOCK_FILE_ROWS) {
  const editing = path === MOCK_EDITING ? { editing: true } : {};
  if (!numbered) {
    MOCK_FILES.push({ path, ...editing });
    continue;
  }
  const { add, del } = counted(path);
  MOCK_FILES.push({ path, add, del, ...editing });
}
