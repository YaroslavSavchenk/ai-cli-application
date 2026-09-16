/**
 * The fake `FsGateway` the Files-panel tests drive part B2 with, and the one
 * folder tree they all read.
 *
 * WHY A FIXTURE AND NOT A MOCK MODULE. `ui/files.ts` takes its backend
 * INJECTED (PLAN-B2 §9), so every test here is the real panel against a plain
 * object: no module stubbing, no HTTP, no clock. The names are the A5 ones
 * (`README.md`, `web`, `src`, `server`) on purpose — the assertions that
 * survived part B2 read exactly the way they did before it.
 *
 * WHAT A TEST CONTROLS. `calls` records what was asked and in which order (the
 * dedupe, the poll and "no walk, no prefetch" are all read from it), `failWith`
 * makes one path answer the server's own sentence, `hold()` keeps every answer
 * in flight until `release()` (the `Loading…` row, the late answer for a root
 * we left), `holdIf()` keeps ONE call in flight and reads its answer at CALL
 * time (the stale answer that differs from the fresh one for the same path),
 * and `setChanges` decides what git says per root. Part A9c adds the create
 * side: `createCalls` records every `{dir, name, kind}` posted (so "exactly
 * once" and "no request at all" are both readable), `failCreate()` arms the
 * refusal the next one answers with, and `holdCreate()` keeps one in flight
 * while the listings around it keep answering.
 *
 * TIME. There is none: `settle()` turns the microtask queue, which is all the
 * panel's `then -> catch -> finally -> render` chain needs. fake-dom's timers
 * are RECORDED, never fired, so the 5 s Changes poll is asserted by reading
 * `dom.win.intervals` and calling the recorded function.
 */

/** The home folder the FIRST listing (the one with no path) teaches the panel. */
export const HOME = '/home/you';
/**
 * A registered project's folder. OUTSIDE home on purpose: a project the user
 * registered anywhere is an anchor of its own (PLAN-B2 §2), and it is the only
 * way a root change can prove it prunes what is no longer under the root.
 */
export const PROJ = '/work/api';
/** A second project, for the tests about a tab that is about another tab's session. */
export const PROJ2 = '/work/tools';
/** The working directory of a session with no project — its own root since B2. */
export const SCRATCH = '/home/you/scratch';

export interface Entry {
  name: string;
  dir: boolean;
}
export interface Changed {
  path: string;
  add: number | null;
  del: number | null;
  status: 'modified' | 'new' | 'deleted' | 'renamed';
}
export interface Changes {
  isRepo: boolean;
  repoRoot: string | null;
  branch: string | null;
  files: Changed[];
  truncated: number;
}
export interface Gateway {
  entries(path?: string): Promise<{ path: string; entries: Entry[]; truncated: number }>;
  create(dir: string, name: string, kind: 'file' | 'folder'): Promise<{ path: string }>;
  changes(root: string): Promise<Changes>;
}

/**
 * One folder tree, served under every root below. Order is the SERVER's —
 * folders first, then files — and the panel never re-sorts it, so this order
 * is the order the rows must come out in.
 */
export const TREE_SHAPE: Record<string, Entry[]> = {
  '': [
    { name: 'web', dir: true },
    { name: 'server', dir: true },
    { name: 'launcher', dir: true },
    { name: 'shared', dir: true },
    { name: 'README.md', dir: false },
    { name: 'LICENSE', dir: false },
  ],
  '/web': [
    { name: 'src', dir: true },
    { name: 'DESIGN.md', dir: false },
    { name: 'package.json', dir: false },
  ],
  '/web/src': [
    { name: 'App.tsx', dir: false },
    { name: 'Pane.tsx', dir: false },
    { name: 'TabStrip.tsx', dir: false },
    { name: 'store.ts', dir: false },
  ],
  '/server': [
    { name: 'pty-pool.ts', dir: false },
    { name: 'ws.ts', dir: false },
    { name: 'presence.ts', dir: false },
  ],
  '/launcher': [
    { name: 'launch.ps1', dir: false },
    { name: 'make-icon.mjs', dir: false },
  ],
  '/shared': [
    { name: 'empty', dir: true },
    { name: 'protocol.ts', dir: false },
  ],
  '/shared/empty': [],
};

/** The folder whose listing is CAPPED, and by how many rows. */
const TRUNCATED_REL = '/shared';
const TRUNCATED_BY = 3;

/** An `ApiError` in everything the panel duck-types: a status and a sentence. */
export class FakeApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** What the fake answers `changes()` with for a repository root. */
export const CHANGED: Changed[] = [
  { path: 'web/src/App.tsx', add: 12, del: 4, status: 'modified' },
  { path: 'web/src/Pane.tsx', add: 8, del: 6, status: 'modified' },
  { path: 'server/ws.ts', add: 6, del: 0, status: 'modified' },
  { path: 'README.md', add: null, del: null, status: 'new' },
  { path: 'launcher/launch.ps1', add: null, del: 2, status: 'deleted' },
];

export const NO_REPO: Changes = {
  isRepo: false,
  repoRoot: null,
  branch: null,
  files: [],
  truncated: 0,
};

/** A repository answer for `PROJ`, with any field a test wants to change. */
export function repoAnswer(over: Partial<Changes> = {}): Changes {
  return { isRepo: true, repoRoot: PROJ, branch: 'main', files: CHANGED, truncated: 0, ...over };
}

/** One create the fake was asked for (A9c) — what was posted, in order. */
export interface CreateCall {
  dir: string;
  name: string;
  kind: 'file' | 'folder';
}

export interface Fixture {
  gateway: Gateway;
  /** The listing tree, so a test can add or remove a folder. */
  tree: Map<string, Entry[]>;
  /** Every listing the panel asked for, in order (`undefined` = the home probe). */
  entryCalls: (string | undefined)[];
  /** Every git call, by root. */
  changeCalls: string[];
  /**
   * Every create the panel posted, in order (A9c). "Exactly once" and "no
   * request at all for a name the client rules already refuse" are both read
   * from this list, so a create that fired twice or fired early is a failure
   * with a diff, not a silence.
   */
  createCalls: CreateCall[];
  /**
   * What the NEXT create answers, when a test wants it to fail: the 409 a name
   * that is taken really gets, or anything else with a message. Cleared by
   * `reset()`, never by the call — a test that arms it decides how long it
   * lasts.
   */
  createFails: FakeApiError | null;
  /** Arm the failure above (a 409 and its sentence, by default). */
  failCreate(err?: FakeApiError): void;
  /** Paths that answer a refusal instead of a listing. */
  failWith: Map<string, FakeApiError>;
  /** What git says for a root. Replaceable per test. */
  changesFor: (root: string) => Changes | FakeApiError;
  setChanges(fn: (root: string) => Changes | FakeApiError): void;
  /** Hold every answer until `release()` — the mid-flight states. */
  hold(): void;
  /**
   * Hold every CREATE until `releaseCreate()`, and nothing else. The tree's own
   * listings must keep answering while one is held: the in-flight name row is
   * asserted against a tree that is fully painted around it.
   */
  holdCreate(): void;
  releaseCreate(): void;
  /**
   * Hold only the calls this picks, and read each held answer AT CALL TIME —
   * which is what a slow network really does: the server read that folder
   * then, the answer only arrives later. Everything the predicate does not
   * pick answers at once.
   *
   * It is the only way to build a STALE answer that DIFFERS from the fresh one
   * for the same path: `hold()` queues closures that all read the tree as it
   * is on `release()`, so an old generation's answer and the current one would
   * be byte-identical and no generation check could be observed at all.
   */
  holdIf(pred: (call: Call) => boolean): void;
  release(): void;
  /** Forget the calls, the failures, any held answers, and every change to the tree. */
  reset(): void;
}

/** One question the fake was asked, for `holdIf`. */
export interface Call {
  kind: 'entries' | 'changes';
  /** The path asked for; `undefined` is the home probe (`entries()` with no path). */
  path: string | undefined;
}

/** A computed answer waiting to be delivered (`holdIf`). */
type Answer<T> = { ok: true; value: T } | { ok: false; err: unknown };

/**
 * Build the fake. `roots` are the folders whose subtree is served; anything
 * else answers the 404 sentence, which is how a root that is no longer there
 * is tested.
 */
export function makeFixture(roots: readonly string[] = [HOME, PROJ, PROJ2, SCRATCH]): Fixture {
  const tree = new Map<string, Entry[]>();
  /** The one shape, laid out under every served root — and `reset()`'s undo. */
  function fillTree(): void {
    tree.clear();
    for (const rootPath of roots) {
      for (const [rel, rows] of Object.entries(TREE_SHAPE)) tree.set(`${rootPath}${rel}`, rows);
    }
  }
  fillTree();
  const truncated = new Set(roots.map((r) => `${r}${TRUNCATED_REL}`));

  const entryCalls: (string | undefined)[] = [];
  const changeCalls: string[] = [];
  const createCalls: CreateCall[] = [];
  const failWith = new Map<string, FakeApiError>();
  let held: (() => void)[] | null = null;
  /** Creates waiting for `releaseCreate()` — the in-flight row (A9c §6b). */
  let heldCreate: (() => void)[] | null = null;
  /** Answers already READ, waiting for `release()` (`holdIf`). */
  const delayed: (() => void)[] = [];
  let holdPred: ((call: Call) => boolean) | null = null;

  /**
   * Either answer now, queue the closure (`hold()`), or read the answer now
   * and queue its DELIVERY (`holdIf`) — the three the fake supports, in one
   * place so `entries` and `changes` can never drift apart.
   */
  function gate<T>(
    call: Call,
    compute: () => Answer<T>,
    resolve: (v: T) => void,
    reject: (e: unknown) => void,
  ): void {
    const deliver = (a: Answer<T>): void => {
      if (a.ok) resolve(a.value);
      else reject(a.err);
    };
    if (holdPred !== null && holdPred(call)) {
      const a = compute();
      delayed.push(() => deliver(a));
      return;
    }
    const answer = (): void => deliver(compute());
    if (held === null) answer();
    else held.push(answer);
  }

  const fx: Fixture = {
    tree,
    entryCalls,
    changeCalls,
    createCalls,
    failWith,
    createFails: null,
    failCreate(err = new FakeApiError(409, 'That name is already taken.')) {
      fx.createFails = err;
    },
    changesFor: (root) => (root === PROJ ? repoAnswer() : NO_REPO),
    setChanges(fn) {
      fx.changesFor = fn;
    },
    hold() {
      held = [];
    },
    holdCreate() {
      heldCreate = [];
    },
    releaseCreate() {
      const queue = heldCreate ?? [];
      heldCreate = null;
      for (const fn of queue) fn();
    },
    holdIf(pred) {
      holdPred = pred;
    },
    release() {
      const queue = held ?? [];
      held = null;
      holdPred = null;
      for (const fn of queue) fn();
      // The answers that were READ earlier land LAST on purpose: that is the
      // whole shape of a late answer — the fresh one is already on screen.
      const late = delayed.splice(0);
      for (const fn of late) fn();
    },
    reset() {
      // The tree is a test's to change (a folder that grew, a root that went
      // away), so every test gets the same one back — a fixture that leaked
      // one test's filesystem into the next would be worse than no fixture.
      fillTree();
      entryCalls.length = 0;
      changeCalls.length = 0;
      createCalls.length = 0;
      fx.createFails = null;
      failWith.clear();
      held = null;
      heldCreate = null;
      holdPred = null;
      delayed.length = 0;
      fx.changesFor = (root) => (root === PROJ ? repoAnswer() : NO_REPO);
    },
    gateway: {
      entries(path?: string) {
        entryCalls.push(path);
        return new Promise((resolve, reject) => {
          const compute = (): Answer<{ path: string; entries: Entry[]; truncated: number }> => {
            const key = path ?? HOME;
            const bad = failWith.get(key);
            if (bad !== undefined) return { ok: false, err: bad };
            const rows = tree.get(key);
            if (rows === undefined) {
              return { ok: false, err: new FakeApiError(404, 'This folder is no longer there.') };
            }
            return {
              ok: true,
              value: { path: key, entries: rows, truncated: truncated.has(key) ? TRUNCATED_BY : 0 },
            };
          };
          gate({ kind: 'entries', path }, compute, resolve, reject);
        });
      },
      /**
       * One create (A9c). It RECORDS first and answers second, so a test can
       * see a request that should never have gone out even when the answer is
       * the one it wanted anyway.
       *
       * On success the new entry is put in the TREE as well: the panel refetches
       * the folder straight away, and a fake that answered a path it then
       * listed without would make "the keyboard lands on the new row"
       * untestable. `hold()` and `holdIf()` do not gate it — nothing in §6b
       * needs a create to be in flight across a render except the busy state,
       * which `holdCreate` below serves on its own terms.
       */
      create(dir: string, name: string, kind: 'file' | 'folder') {
        createCalls.push({ dir, name, kind });
        const bad = fx.createFails;
        if (bad !== null) return Promise.reject(bad);
        const path = `${dir}/${name}`;
        const rows = tree.get(dir);
        if (rows !== undefined && !rows.some((e) => e.name === name)) {
          rows.push({ name, dir: kind === 'folder' });
        }
        if (kind === 'folder' && !tree.has(path)) tree.set(path, []);
        if (heldCreate === null) return Promise.resolve({ path });
        return new Promise<{ path: string }>((resolve) => {
          heldCreate?.push(() => resolve({ path }));
        });
      },
      changes(root: string) {
        changeCalls.push(root);
        return new Promise((resolve, reject) => {
          const compute = (): Answer<Changes> => {
            const a = fx.changesFor(root);
            return a instanceof FakeApiError ? { ok: false, err: a } : { ok: true, value: a };
          };
          gate({ kind: 'changes', path: root }, compute, resolve, reject);
        });
      },
    },
  };
  return fx;
}

/**
 * Let the fake's promises land. The panel's chain is
 * `then -> catch -> finally -> render`, so a handful of microtask turns is
 * both enough and honest: there is no clock in these tests.
 */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}
