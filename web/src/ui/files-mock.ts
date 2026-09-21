/**
 * PLACEHOLDER CONTENT for the Files panel (Nocturne part A5), what is left of
 * it after parts B2 and B3.
 *
 * The FILE TREE went first: the panel lists a real folder through the backend
 * since B2, and the `Changes` tab draws real `git diff --numstat` rows. The
 * COMMITS went in B3 (`MOCK_COMMITS`, `mockCommitByHash`, `MOCK_BRANCH` and
 * the counting that kept their numbers honest): the Commits tab, the commit
 * view and every diff row read `git log` / `git show` through
 * `ui/commit-store.ts`, and the synthetic diff those numbers were counted from
 * went with them.
 *
 * ONE HALF IS LEFT, and part B4 takes it: FILE CONTENTS (`mockFileContent` /
 * `saveMockFile`), read by an editor file tab and written by its Save button.
 *
 * Content is the v3 reference's own mock (`session-manager-v3.html`), with the
 * author changed to this repo's.
 */

/**
 * PLACEHOLDER FILE CONTENTS for the editor (part A6).
 *
 * ONE thing reads this map since part B3: an editor file tab (the text in the
 * textarea). Part B4 replaces that read with the backend's own file read, and
 * `saveMockFile()` with a write to disk.
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
 * The text an editor tab reads, or NULL when the mock knows nothing about that
 * path. Null rather than a sentence dressed as a file: the pane then draws its
 * own note and offers no field to type in, which is the whole difference
 * between "there is nothing here" and "here is what is in it".
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
