/**
 * Drag and paste payloads for the DOM double (`fake-dom.ts`, the entry every
 * test imports): a `DataTransfer` with `items`/`files`/`types`, and the
 * `webkitGetAsEntry()` tree a dropped folder hands over (parts A9, B10).
 *
 * Self-contained: nothing here touches the document. Split out of
 * `fake-dom.ts` (restructure O6, 2026-09-23) so each module keeps one topic.
 */

/**
 * One node of a dropped TREE (part B10): a file with a size, or a folder with
 * children. `unreadable` makes the folder's reader fail the way a folder the
 * browser will not open really does, and `batch` caps how many entries one
 * `readEntries()` call answers with — Chromium's is about 100, and a walk that
 * does not loop would copy only the first batch.
 */
export interface FakeTreeNode {
  name: string;
  dir?: boolean;
  size?: number;
  children?: FakeTreeNode[];
  unreadable?: boolean;
  /** Entries per `readEntries()` call. Defaults to `READ_BATCH`. */
  batch?: number;
}

/** What Chromium's `readEntries()` really answers with at most, per call. */
export const READ_BATCH = 100;

/**
 * What `webkitGetAsEntry()` answers: a NAME, whether it is a folder, and —
 * since part B10, which walks the tree — the two callback APIs the real
 * `FileSystemEntry` carries.
 */
export interface FakeEntry {
  name: string;
  isDirectory: boolean;
  isFile?: boolean;
  file?(ok: (f: unknown) => void, fail?: (e: unknown) => void): void;
  createReader?(): {
    readEntries(ok: (entries: FakeEntry[]) => void, fail?: (e: unknown) => void): void;
  };
}

/**
 * A tree node as the browser hands it over. Callback-style on purpose: the
 * real API is, and a walk that forgets to loop `readEntries()` has to fail
 * here the same way it fails in Chromium.
 */
export function makeEntry(node: FakeTreeNode): FakeEntry {
  const dir = node.dir === true;
  if (!dir) {
    return {
      name: node.name,
      isDirectory: false,
      isFile: true,
      file(ok, fail) {
        if (node.unreadable === true) {
          fail?.(new Error('unreadable'));
          return;
        }
        ok({ name: node.name, size: node.size ?? 0 });
      },
    };
  }
  const children = node.children ?? [];
  const per = node.batch ?? READ_BATCH;
  return {
    name: node.name,
    isDirectory: true,
    isFile: false,
    createReader() {
      let i = 0;
      return {
        readEntries(ok, fail) {
          if (node.unreadable === true) {
            fail?.(new Error('unreadable'));
            return;
          }
          const slice = children.slice(i, i + per);
          i += slice.length;
          ok(slice.map(makeEntry));
        },
      };
    },
  };
}

/** What `getAsFile()` answers, and what a `files` list holds. */
export interface FakeFile {
  name: string;
  size?: number;
}

export interface FakeDataTransferItem {
  kind: string;
  type: string;
  webkitGetAsEntry(): FakeEntry | null;
  getAsFile(): FakeFile | null;
}

/**
 * A `DataTransfer` double. `dropEffect` is MUTABLE on purpose: it is how the
 * drop layer states validity ('copy' vs 'none'), so a test reads back what the
 * module wrote.
 */
export interface FakeDataTransfer {
  types: string[];
  dropEffect: string;
  effectAllowed: string;
  items: FakeDataTransferItem[];
  files: FakeFile[];
}

export interface DataTransferInit {
  /** Defaults to `['Files']` when items or files are given, `[]` otherwise. */
  types?: string[];
  /**
   * Top-level things being dragged. `dir` makes it a folder (no size), and
   * `children` gives that folder a TREE the walk can read (part B10).
   */
  items?: {
    name: string;
    dir?: boolean;
    size?: number;
    kind?: string;
    children?: FakeTreeNode[];
    unreadable?: boolean;
    batch?: number;
  }[];
  /** A plain file list (a paste, the native chooser). */
  files?: FakeFile[];
  /**
   * The DRAGOVER phase, as Chromium really behaves: `types` is all there is,
   * and `webkitGetAsEntry()` / `getAsFile()` answer null until `drop`
   * (measured, PLAN-A9 "Facts checked").
   */
  blind?: boolean;
}

export function makeDataTransfer(init: DataTransferInit = {}): FakeDataTransfer {
  const blind = init.blind === true;
  const items: FakeDataTransferItem[] = (init.items ?? []).map((it) => ({
    kind: it.kind ?? 'file',
    type: '',
    webkitGetAsEntry: () =>
      blind || it.kind === 'string'
        ? null
        : makeEntry({
            name: it.name,
            dir: it.dir === true,
            size: it.size ?? 0,
            ...(it.children === undefined ? {} : { children: it.children }),
            ...(it.unreadable === undefined ? {} : { unreadable: it.unreadable }),
            ...(it.batch === undefined ? {} : { batch: it.batch }),
          }),
    getAsFile: () =>
      blind || it.dir === true || it.kind === 'string'
        ? null
        : { name: it.name, size: it.size ?? 0 },
  }));
  const files: FakeFile[] = init.files ?? [];
  const types =
    init.types ?? (items.length > 0 || files.length > 0 ? ['Files'] : []);
  return { types, dropEffect: 'none', effectAllowed: 'all', items, files };
}
