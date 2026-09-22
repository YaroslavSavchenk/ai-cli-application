/**
 * The PROTECTED-ENTRY SET — by identity (dev+ino), never by string
 * (B13 security re-review, round 2).
 *
 * WHY. Rename and delete refuse the anchors (home, every registered project
 * root), the app's data dir, and every folder or link that holds one. Before
 * this module that was judged by STRINGS: the realpath of each anchor, plus
 * (round 1) the stored project path and the configured AI_SM_DATA_DIR taken
 * lexically. Both miss cases the kernel does not:
 *   - a symlink DEEPER in the chain: project stored as `<home>/a/lnk/proj`,
 *     `a -> <home>/b`, `<home>/b/lnk -> <home>/c`. Renaming `<home>/b/lnk`
 *     matches neither `<home>/c/proj` (real) nor `<home>/a/lnk/proj` (stored),
 *     yet it cuts the path the project is registered under;
 *   - DRVFS keeps the REQUEST's case in realpath: `/mnt/c/work/proj` never
 *     string-equals the anchor `/mnt/c/work/Proj`, although it is the same
 *     folder.
 *
 * WHAT. For every root (each anchor's realpath, each stored project path, the
 * configured data dir path) this walks the path the way the KERNEL does:
 * component by component from `/`, lstat'ing each entry, and when an entry is a
 * symlink, splicing its target into the walk (absolute: restart from `/`;
 * relative: continue from the directory the link sits in). EVERY entry the
 * walk touches — each ancestor directory, each symlink, each directory a
 * symlink leads to — is recorded by `dev:ino`. Rename and delete then lstat
 * their own entry (NOT followed) and refuse when its identity is in the set.
 * "Contains a protected thing" is covered for free: an entry that contains one
 * is on its walk.
 *
 * A root whose walk hits a missing entry (a stale project, a deleted folder)
 * simply stops there: what it touched so far stays recorded, nothing past it
 * exists to protect.
 *
 * Ancestors OUTSIDE the boundary (`/home`, `/mnt`, `/mnt/c`) land in the set
 * too. Harmless: renaming or deleting one needs its parent inside the
 * boundary, which only happens if the user registered `/` or `/mnt` as a
 * project — and then they ARE ancestors of something protected.
 *
 * ASYNC (lstat, readlink from `node:fs/promises`) and CACHED for
 * PROTECT_TTL_MS per input, like anchorsFor(): the key is the exact list of
 * roots, so a project registered a moment ago is a cache miss, never a stale
 * answer. The window that remains is the documented TOCTOU of fsbrowse.ts.
 *
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import { lstat as fsLstat, readlink as fsReadlink } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { dataDirPath } from './config.ts';

/** What a protected entry is, for the sentence the refusal uses. */
export type ProtectedKind = 'anchor' | 'data';

/** `dev:ino` -> kind. `anchor` wins when an entry is on both kinds of chain. */
export type ProtectedSet = Map<string, ProtectedKind>;

/** The two fs calls the walk makes — injectable so a test can fake a filesystem. */
export interface WalkFs {
  lstat: (p: string) => Promise<{ dev: number | bigint; ino: number | bigint; isSymbolicLink(): boolean }>;
  readlink: (p: string) => Promise<string>;
}

/**
 * BIGINT stats, always: drvfs inode numbers are the NTFS file ID — sequence
 * number << 48 plus record — so past sequence 31 they exceed 2^53 and a JS
 * number ROUNDS them, making two neighbours share an identity (a false
 * refusal). The callers lstat with `{ bigint: true }` for the same reason.
 */
const realFs: WalkFs = {
  lstat: (p) => fsLstat(p, { bigint: true }),
  readlink: fsReadlink,
};

/** The kernel's own limit on symlinks followed in one lookup (Linux MAXSYMLINKS). */
export const MAX_SYMLINK_HOPS = 40;

/** Same window as anchorsFor()'s realpath cache. */
export const PROTECT_TTL_MS = 5_000;

/**
 * How long a request waits for the set. A walk can HANG — an lstat on a dead
 * 9p/drvfs mount under a stored project path never returns — and every rename
 * and delete waits on the same walk. Past this the request is REFUSED (fail
 * safe: no identity check, no change), never let through.
 */
export const PROTECT_TIMEOUT_MS = 3_000;

/** The refusal when the set is not ready in time. A constant: no path, no errno. */
export const FS_PROTECT_UNAVAILABLE = 'The app could not check this folder right now.';

/** Thrown (rejected) when the set did not come in time. */
export class ProtectTimeoutError extends Error {
  constructor() {
    super(FS_PROTECT_UNAVAILABLE);
    this.name = 'ProtectTimeoutError';
  }
}

/** The identity key of one lstat result. Pass BIGINT stats (see realFs). */
export function identityOf(st: { dev: number | bigint; ino: number | bigint }): string {
  return `${String(st.dev)}:${String(st.ino)}`;
}

/**
 * Walk `path` as the kernel would and call `record` for every entry touched.
 * Never throws: a missing or unreadable entry, or too many symlink hops, ends
 * the walk where it is.
 */
export async function walkEntries(
  path: string,
  record: (id: string) => void,
  fs: WalkFs = realFs,
): Promise<void> {
  if (!isAbsolute(path)) return;
  let cur: string = sep;
  const queue = path.split(sep);
  let hops = 0;
  while (queue.length > 0) {
    const part = queue.shift() as string;
    if (part === '' || part === '.') continue;
    if (part === '..') {
      // `cur` is always a PHYSICAL directory here (symlinks are spliced, never
      // stepped into by name), so `..` is its real parent — the kernel's rule.
      cur = resolve(cur, '..');
      continue;
    }
    const next = join(cur, part);
    let st: Awaited<ReturnType<WalkFs['lstat']>>;
    try {
      st = await fs.lstat(next);
    } catch {
      return;
    }
    record(identityOf(st));
    if (st.isSymbolicLink()) {
      hops += 1;
      if (hops > MAX_SYMLINK_HOPS) return;
      let target: string;
      try {
        target = await fs.readlink(next);
      } catch {
        return;
      }
      if (isAbsolute(target)) cur = sep;
      queue.unshift(...target.split(sep));
    } else {
      cur = next;
    }
  }
}

/**
 * Build the set from its roots. `anchorRoots` are walked as `anchor`,
 * `dataRoots` as `data`; an identity reached by both stays `anchor` (the
 * sentence that names home or a project tells the user more).
 */
export async function buildProtectedSet(
  anchorRoots: readonly string[],
  dataRoots: readonly string[],
  fs: WalkFs = realFs,
): Promise<ProtectedSet> {
  const set: ProtectedSet = new Map();
  for (const root of dataRoots) {
    await walkEntries(root, (id) => set.set(id, 'data'), fs);
  }
  for (const root of anchorRoots) {
    await walkEntries(root, (id) => set.set(id, 'anchor'), fs);
  }
  return set;
}

/**
 * One cache entry. `at` is null while the walk is still RUNNING, and the time
 * it finished otherwise — the TTL counts from then.
 */
let cache: { key: string; at: number | null; set: Promise<ProtectedSet> } | null = null;

/** `promise`, or a ProtectTimeoutError after `ms`. The timer never holds the process. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    const timer = setTimeout(() => reject(new ProtectTimeoutError()), ms);
    timer.unref?.();
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolvePromise(v);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * The cached set for these roots, within `timeoutMs` or a ProtectTimeoutError.
 *
 * One entry: every request in a burst asks with the same roots. A FINISHED set
 * is reused for PROTECT_TTL_MS. A walk still RUNNING is reused too — even after
 * a request timed out on it — and raced against a fresh timer: a hung lstat
 * holds a libuv pool thread, and starting a second walk into the same dead
 * mount per request would drain the pool (4 threads) that every other fs call
 * in this process shares. So a timed-out request never CACHES its outcome: the
 * next request waits on the same walk again, and gets the set the moment the
 * mount answers. A rejected build (not expected: the walk swallows its errors)
 * is dropped so the next request starts over.
 *
 * `build` and `timeoutMs` are test seams.
 */
export function protectedSetFor(
  anchorRoots: readonly string[],
  dataRoots: readonly string[],
  opts: { timeoutMs?: number; build?: () => Promise<ProtectedSet> } = {},
): Promise<ProtectedSet> {
  const key = JSON.stringify([anchorRoots, dataRoots]);
  const now = performance.now();
  const reusable =
    cache !== null &&
    cache.key === key &&
    (cache.at === null || now - cache.at < PROTECT_TTL_MS);
  if (!reusable) {
    const set = (opts.build ?? (() => buildProtectedSet(anchorRoots, dataRoots)))();
    const entry: { key: string; at: number | null; set: Promise<ProtectedSet> } = { key, at: null, set };
    cache = entry;
    set.then(
      () => {
        entry.at = performance.now();
      },
      () => {
        if (cache === entry) cache = null;
      },
    );
  }
  return withTimeout((cache as { set: Promise<ProtectedSet> }).set, opts.timeoutMs ?? PROTECT_TIMEOUT_MS);
}

/**
 * The set for one request: `anchors` (anchorsFor(), realpaths — home and every
 * live project) plus every STORED project path as written, and the CONFIGURED
 * data dir path as written (AI_SM_DATA_DIR or the default).
 */
export function protectedSetForRequest(
  projects: readonly string[],
  anchors: readonly string[],
): Promise<ProtectedSet> {
  const stored = projects.filter((p) => typeof p === 'string' && isAbsolute(p));
  let data: string[];
  try {
    data = [dataDirPath()];
  } catch {
    data = []; // A relative AI_SM_DATA_DIR already stopped the boot.
  }
  return protectedSetFor([...anchors, ...stored], data);
}

/** Test seam: forget the cached set. */
export function resetProtectedSetCache(): void {
  cache = null;
}
