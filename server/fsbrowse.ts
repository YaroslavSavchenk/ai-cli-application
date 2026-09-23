/**
 * Directory browsing for the "Add project" picker: directory NAMES only —
 * no files, no file contents — plus one boolean, `empty`, saying whether the
 * directory holds any entry at all. Absolute paths only; defaults to $HOME.
 *
 * Plus the WRITE side (POST /api/fs/mkdir): create a single new subdirectory
 * inside an existing directory, named a single validated path segment.
 *
 * SECOND HALF, added by B2 (2026-09-16): the Files panel's file browser —
 * listEntries() (files AND folders, GET /api/fs/entries) and createEntry()
 * (one empty file or one folder, POST /api/fs/create). Those two are CONFINED
 * TO THE USER'S HOME OR A REGISTERED PROJECT ROOT by resolveUnderAllowed();
 * listDirs() and mkdirIn() above are NOT, and that asymmetry is deliberate —
 * see the comment on resolveUnderAllowed.
 *
 * Erasable TypeScript only; relative imports carry explicit .ts extensions.
 */
import { closeSync, mkdirSync, openSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import type {
  FsCreateResponse,
  FsEntriesResponse,
  FsEntry,
  FsListResponse,
  FsMkdirResponse,
} from '../shared/protocol.ts';
import { dataDirPath, resolveHomeBoundary } from './config.ts';
import { isExistingDirectory } from './projects.ts';

export class FsBrowseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * List subdirectory names of `requestedPath` (or $HOME when omitted).
 *
 * NO BOUNDARY AT ALL, ON PURPOSE (B2, 2026-09-16). This route serves the
 * project picker, whose whole job is choosing a folder ANYWHERE on the machine
 * (it has a `Root` quick zone, and a project you are about to register is by
 * definition not registered yet, so no anchor list could contain it).
 * Narrowing it would break Add-a-project, the GitHub clone destination and
 * their tests — tests/server/fs-entries.test.ts pins that this route still lists a
 * folder the panel's routes refuse. The NEW browser routes below
 * (listEntries/createEntry) are confined to the anchor list instead — read
 * that as a choice, not as an oversight here.
 */
export function listDirs(requestedPath: string | undefined): FsListResponse {
  const target = requestedPath === undefined || requestedPath === '' ? homedir() : requestedPath;
  if (!isAbsolute(target)) {
    throw new FsBrowseError(400, 'path must be absolute');
  }
  const path = normalize(target);
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new FsBrowseError(404, 'not a directory');
    }
    if (code === 'EACCES' || code === 'EPERM') {
      throw new FsBrowseError(403, 'permission denied');
    }
    throw new FsBrowseError(500, 'failed to list directory');
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    } else if (entry.isSymbolicLink()) {
      // Include symlinks that resolve to directories (common in home dirs).
      try {
        if (statSync(join(path, entry.name)).isDirectory()) dirs.push(entry.name);
      } catch {
        // Broken symlink — skip.
      }
    }
  }
  dirs.sort((a, b) => a.localeCompare(b));
  // Every entry type counts (files, hidden files, broken symlinks) — the same
  // test the create path's assertVacant applies, so `empty` means "create
  // would accept this folder".
  return { path, dirs, empty: entries.length === 0 };
}

/**
 * True when `name` is a single safe path segment: 1..255 chars, no `/` or `\`,
 * no NUL or control chars, and not an all-dots name (`.`, `..`, `...`). This is
 * the ONLY vocabulary the mkdir endpoint accepts — it can never escape `parent`.
 */
export function isSafeSegment(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  for (let i = 0; i < name.length; i += 1) {
    if (name.charCodeAt(i) < 0x20) return false; // NUL + control chars
  }
  if (/^\.+$/.test(name)) return false; // '.', '..', '...' — no dots-only names
  return true;
}

/**
 * Create the single subdirectory `name` inside the existing directory `parent`,
 * returning its absolute path. Like listDirs, this one has NO BOUNDARY on
 * purpose: it is the folder picker's "new folder" button, which must work
 * wherever the picker can browse — including the folder the user is about to
 * register as a project. createEntry() below is the confined twin, and
 * tests/server/fs-create.test.ts pins the asymmetry from both sides.
 * `parent` must be an existing directory and
 * `name` a valid single segment; the target must not already exist. Throws
 * FsBrowseError (mapped to an HTTP status by the API layer) on any violation.
 */
export function mkdirIn(parent: string, name: string): FsMkdirResponse {
  if (!isExistingDirectory(parent)) {
    throw new FsBrowseError(400, 'parent must be an absolute path to an existing directory');
  }
  if (!isSafeSegment(name)) {
    throw new FsBrowseError(400, 'name must be a single safe path segment');
  }
  const target = join(parent, name);
  try {
    mkdirSync(target); // Not recursive: fails EEXIST if the target already exists.
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new FsBrowseError(409, 'a file or directory with that name already exists');
    if (code === 'EACCES' || code === 'EPERM') throw new FsBrowseError(403, 'permission denied');
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new FsBrowseError(404, 'parent not found');
    throw new FsBrowseError(500, 'failed to create directory');
  }
  return { path: target };
}

// ---------------------------------------------------------------------------
// The file BROWSER (B2, 2026-09-16): GET /api/fs/entries + POST /api/fs/create
//
// Everything below this line is confined to an ANCHOR LIST: the user's home,
// plus the path of every project registered in projects.json (user decision
// 2026-09-16 — a project registered at /mnt/c/work/app is, from the user's
// view, theirs, and a half-usable project is worse than none). The two
// functions above are confined to nothing (see their comments): the picker
// browses the whole machine, the panel browses what is yours.
// ---------------------------------------------------------------------------

/**
 * The user-facing sentences of the two browser routes. CONSTANTS, every one of
 * them: server/api.ts records a refusal message in `responseReason` for the
 * access log, and that channel's contract is that nothing derived from a body,
 * a query or a path is ever put in it. They are also the copy the panel renders
 * verbatim, so they carry no path, no flag, no command and no key name.
 */
export const FS_PATH_BAD = 'The app cannot open that folder.';
export const FS_OUTSIDE_HOME = 'This folder is outside your home folder.';
export const FS_NO_READ_PERMISSION = 'You do not have permission to read this folder.';
export const FS_NO_CREATE_PERMISSION = 'You do not have permission to create it here.';
export const FS_DATA_DIR_REFUSED = "The app's own folder is not a place to create files.";
export const FS_LIST_GONE = 'This folder is no longer there.';
export const FS_CREATE_PARENT_GONE = 'That folder is no longer there.';
export const FS_NAME_NOT_ALLOWED = 'That name is not allowed.';
export const FS_ALREADY_EXISTS = 'Something with that name already exists here.';
export const FS_READ_FAILED = 'The app could not read this folder.';
export const FS_CREATE_FAILED = 'The app could not create it.';

/** Entries returned for one folder; past this the answer carries `truncated`. */
export const MAX_ENTRIES = 1000;

/**
 * The filesystem's own limit on ONE name, in BYTES (Linux NAME_MAX). Not the
 * same thing as isSafeSegment's 255 CHARACTERS: `é` is one character and two
 * bytes, so a 250-character name can be 500 bytes and ENAMETOOLONG.
 */
export const MAX_NAME_BYTES = 255;

/**
 * The first anchor: the user's home, realpathed. LAZY AND MEMOIZED, not
 * resolved at module load — AI_SM_HOME_OVERRIDE (server/config.ts
 * `resolveHomeBoundary`, the same seam family as AI_SM_WEB_DIST_DIR) can refuse
 * the value, and a module that throws at IMPORT dies before the logger exists
 * and leaves an EMPTY server.log. server/index.ts validates the seam at boot
 * and writes `refusing to start: …` first; by the time a route calls this, the
 * value is known good.
 */
let homeReal: string | undefined;

function homeAnchor(): string {
  if (homeReal === undefined) homeReal = resolveHomeBoundary();
  return homeReal;
}

/**
 * The app's own data dir, realpathed, or null when it cannot be resolved.
 * Cached after the first call: the directory is created at boot and never
 * moves, and a per-request realpath of it would be pure syscall tax.
 */
let dataDirReal: string | null | undefined;

function resolvedDataDir(): string | null {
  if (dataDirReal !== undefined) return dataDirReal;
  try {
    dataDirReal = realpathSync(dataDirPath());
  } catch {
    dataDirReal = null; // Not there (a harness that never booted) — nothing to refuse.
  }
  return dataDirReal;
}

/** `p` is `root` itself or something under it. A string test: callers pass resolved (or real) paths. */
export function isUnder(p: string, root: string): boolean {
  return p === root || p.startsWith(root + sep);
}

/**
 * True when an ALREADY-RESOLVED path is the app's own data dir or under it.
 * Exported for server/fsupload.ts (B10), which applies the same category rule
 * to the parent it builds; createEntry() below is the other caller. NOT a
 * security boundary — see the comment at the call site in createEntry.
 */
export function isUnderDataDir(real: string): boolean {
  const data = resolvedDataDir();
  return data !== null && isUnder(real, data);
}

/**
 * The REVERSE test: the app's own data dir is `real` itself or lies UNDER it.
 *
 * Added by B10a (server/fsdelete.ts). Deleting is the one operation where
 * containment runs both ways: `isUnderDataDir` stops a write INSIDE the data
 * dir, but only this one stops `rm -r` on a FOLDER THAT CONTAINS it. With a
 * custom AI_SM_DATA_DIR nested two levels under home (`<home>/dd/data`),
 * deleting `<home>/dd` would otherwise take the auth token, prefs.json,
 * history.json and runtime.json with it.
 */
export function isDataDirUnder(real: string): boolean {
  const data = resolvedDataDir();
  return data !== null && isUnder(data, real);
}

/**
 * The CONFIGURED data dir (AI_SM_DATA_DIR as written, or the default) is `p`
 * itself or lies UNDER it — a LEXICAL test, the twin of isDataDirUnder.
 *
 * Added by the B13 security review: the realpath tests above miss a data dir
 * configured THROUGH a symlink. With `AI_SM_DATA_DIR=<home>/ddlink/data` and
 * `ddlink -> <home>/real`, renaming or deleting the LINK `<home>/ddlink` is
 * judged on the link's own path, which is not under the real data dir — yet it
 * breaks the path the backend reads its token, prefs and history from.
 * `p` is compared as given: callers pass both the lexical request path and the
 * entry path under the realpath'd parent.
 */
export function holdsConfiguredDataDir(p: string): boolean {
  let configured: string;
  try {
    configured = resolve(dataDirPath());
  } catch {
    return false; // A relative AI_SM_DATA_DIR already stopped the boot.
  }
  return isUnder(configured, p);
}

/**
 * A project path AS STORED in projects.json is `p` itself or lies UNDER it —
 * LEXICAL, the twin of the realpath anchor test (B13 security review). A
 * project registered through a symlink (`<home>/proj-link -> real-proj`, or
 * `<home>/lnk/proj` with `lnk` a link) has a realpath anchor that never equals
 * the link's own path, so without this the link — the name the project is
 * registered under — could be renamed or deleted, orphaning the project.
 * Conservative on purpose: a stored path whose folder is gone still counts.
 */
export function holdsStoredProject(p: string, projectPaths: readonly string[]): boolean {
  return projectPaths.some(
    (raw) => typeof raw === 'string' && isAbsolute(raw) && isUnder(resolve(raw), p),
  );
}

/**
 * How long one project path's realpath answer is reused. The Changes tab polls
 * every 5 s and the panel lists on demand, so a whole burst of requests costs
 * ONE realpath per project instead of one each.
 */
export const ANCHOR_REALPATH_TTL_MS = 5_000;

/** Realpath answers per project path STRING. `real: null` = "not an anchor". */
const anchorCache = new Map<string, { real: string | null; at: number }>();

/**
 * The folders the panel may reach: the user's home, plus every registered
 * project root (user decision 2026-09-16, plan §2 AMENDED). One whose path has
 * been deleted or cannot be realpathed is simply not an anchor (it can never
 * widen the boundary, only fail to widen it).
 *
 * `projectPaths` is read from the project store by the ROUTE, per request
 * (server/api.ts) — never cached in this module, and never imported from it:
 * a cached anchor LIST is a boundary that disagrees with projects.json, so a
 * project registered or deleted a moment ago counts at once.
 *
 * What IS cached is the realpath of one path STRING, for ANCHOR_REALPATH_TTL_MS
 * (2026-09-16 review): a `realpathSync` per project per request is a synchronous
 * syscall chain on a path the USER chose — a dead network or drvfs mount blocks
 * the whole event loop for its timeout, and the Changes tab asks 12×/min. The
 * NEGATIVE answer is cached too, so a vanished project costs one failed
 * realpath per window rather than one per request. The clock is monotonic
 * (`performance.now()`), never the wall clock: this host's wall clock was
 * MEASURED jumping 1.9 s backward (WSL2 resync), which would stretch the window.
 */
export function anchorsFor(projectPaths: readonly string[]): string[] {
  const anchors = [homeAnchor()];
  const now = performance.now();
  for (const raw of projectPaths) {
    if (typeof raw !== 'string' || !isAbsolute(raw)) continue;
    const hit = anchorCache.get(raw);
    if (hit !== undefined && now - hit.at < ANCHOR_REALPATH_TTL_MS) {
      if (hit.real !== null) anchors.push(hit.real);
      continue;
    }
    let real: string | null;
    try {
      real = realpathSync(raw);
    } catch {
      // Gone, or unreadable: not an anchor. A project whose folder was deleted
      // must not silently authorise the path its name used to occupy.
      real = null;
    }
    // Registering and unregistering projects all day must not grow this map
    // without bound; the window is 5 s, so throwing it away costs one realpath.
    if (anchorCache.size > 256) anchorCache.clear();
    anchorCache.set(raw, { real, at: now });
    if (real !== null) anchors.push(real);
  }
  return anchors;
}

/**
 * Resolve a client path to the one value every consumer below reads, or throw.
 *
 * THE BOUNDARY IS AN ANCHOR LIST — home, plus every registered project root
 * (see anchorsFor). `opts.projects` carries the store's paths, read per
 * request by the route.
 *
 * ORDER IS LOAD-BEARING (memory/knowledge/path-normalization-delete-primitive):
 * `isAbsolute` BEFORE `resolve` — `resolve('x')` silently anchors to the
 * server's own cwd, which would turn a rejected relative path into a real one —
 * and the containment test is on the REALPATH, because `resolve()` is lexical
 * and the kernel is not. `<anchor>evil` is not under `<anchor>`, which is what
 * the `+ sep` in isUnder() is for.
 *
 * SYMLINKS ARE FOLLOWED and judged by where they land: a link inside an anchor
 * that points inside one behaves like a folder; one that points outside every
 * anchor is still LISTED by its parent (hiding it would be a lie about what is
 * in that folder) but answers 403 when you ask for its contents.
 *
 * TOCTOU, ACCEPTED AND SAID OUT LOUD (plan §8 item 2). Between the
 * `realpathSync` below and the `readdirSync`/`openSync` the caller then
 * performs, a component of the path can be swapped for a symlink pointing
 * anywhere — the kernel has no "open exactly this resolved path" primitive
 * this code could use instead. It is accepted because the window is not
 * reachable by anything that does not already have what the window would buy:
 * this is a single-user loopback service, every one of these routes is behind
 * the app token, and a process able to plant a symlink in the user's home at
 * that instant is already running as that user. Widening it would need
 * `openat` + `O_NOFOLLOW` per segment, which Node does not expose.
 *
 * The two sentences differ between reading and creating (§1d of the plan), so
 * the caller passes them; the defaults are the listing's.
 */
export function resolveUnderAllowed(
  raw: string,
  opts: { projects?: readonly string[]; gone?: string; denied?: string } = {},
): string {
  const gone = opts.gone ?? FS_LIST_GONE;
  const denied = opts.denied ?? FS_NO_READ_PERMISSION;
  // A NUL cannot travel through a syscall path argument, and Node throws a
  // TypeError for it rather than an errno — refuse it here so it is a plain 400
  // like every other malformed path.
  if (typeof raw !== 'string' || raw === '' || !isAbsolute(raw) || raw.includes('\0')) {
    throw new FsBrowseError(400, FS_PATH_BAD);
  }
  const lex = resolve(raw);
  let real: string;
  try {
    real = realpathSync(lex);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'ELOOP') {
      throw new FsBrowseError(404, gone);
    }
    if (code === 'EACCES' || code === 'EPERM') throw new FsBrowseError(403, denied);
    throw new FsBrowseError(500, FS_READ_FAILED);
  }
  // ANY anchor is enough. The sentence stays `…outside your home folder.`: a
  // project the user registered is, from their view, theirs, and a second
  // sentence about anchors would be the app explaining its own bookkeeping.
  const anchors = anchorsFor(opts.projects ?? []);
  if (!anchors.some((anchor) => isUnder(real, anchor))) {
    throw new FsBrowseError(403, FS_OUTSIDE_HOME);
  }
  return real;
}

/**
 * Total, stable order for one folder: folders before files, then
 * case-insensitive natural order (so `img9` sits before `img10` and `Apple`
 * before `banana`), ties broken by raw code units.
 *
 * SERVER-SIDE because the truncation is: the window the client gets must be the
 * FIRST N of the final order, or `truncated` is a lie about which names are
 * missing.
 */
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareEntries(a: FsEntry, b: FsEntry): number {
  if (a.dir !== b.dir) return a.dir ? -1 : 1;
  const byName = collator.compare(a.name, b.name);
  if (byName !== 0) return byName;
  // `sensitivity: 'base'` calls `a` and `A` equal — without this the order of
  // two names that differ only in case would depend on readdir's order.
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * List one folder's entries — files AND folders, dotfiles included, `.git` and
 * `node_modules` included (they are real folders; the cap is what makes them
 * cheap, and a blocklist is a lie with a maintenance cost).
 *
 * `requested` OMITTED = the user's home, so the panel's very first request both
 * resolves home and lists it. An explicitly EMPTY `?path=` is a malformed path,
 * not home: the client omits the parameter when it has no path, so an empty one
 * is a hand-built URL and deserves the 400 every other bad path gets.
 *
 * `projectPaths` is the registered project roots, read per request by the route
 * (they are anchors beside home — see anchorsFor).
 *
 * Per entry exactly two fields, `name` and `dir`: a field no row renders is a
 * field that leaks for free.
 */
export function listEntries(
  requested: string | undefined,
  projectPaths: readonly string[],
): FsEntriesResponse {
  const path =
    requested === undefined ? homeAnchor() : resolveUnderAllowed(requested, { projects: projectPaths });
  if (!isExistingDirectory(path)) {
    // A file, or a socket: the same sentence a vanished folder gets. Nothing
    // about the target is echoed back.
    throw new FsBrowseError(404, FS_LIST_GONE);
  }
  let raw;
  try {
    raw = readdirSync(path, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new FsBrowseError(404, FS_LIST_GONE);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new FsBrowseError(403, FS_NO_READ_PERMISSION);
    }
    throw new FsBrowseError(500, FS_READ_FAILED);
  }
  const entries: FsEntry[] = [];
  for (const entry of raw) {
    if (entry.isSymbolicLink()) {
      // A symlink counts as what it RESOLVES to, exactly like the picker's
      // listing. A broken one is skipped: it has no kind to report, and a row
      // that opens nothing is worse than a row that is not there.
      try {
        entries.push({ name: entry.name, dir: statSync(join(path, entry.name)).isDirectory() });
      } catch {
        continue;
      }
    } else {
      entries.push({ name: entry.name, dir: entry.isDirectory() });
    }
  }
  entries.sort(compareEntries);
  const truncated = entries.length > MAX_ENTRIES ? entries.length - MAX_ENTRIES : 0;
  return {
    path,
    entries: truncated > 0 ? entries.slice(0, MAX_ENTRIES) : entries,
    truncated,
  };
}

/**
 * Create ONE empty file or ONE directory named `name` inside the existing
 * directory `dir`, and return its absolute path.
 *
 * `dir` passes the same boundary as a listing; `name` passes isSafeSegment
 * UNCHANGED — that function is the whole vocabulary, and it is the reason the
 * target can never escape `dir` (no `/`, no `\`, no control char, no all-dots
 * name, 1..255 chars). Hidden names ARE allowed: `.env`, `.gitignore` and
 * `.claude` are things people create.
 */
export function createEntry(
  dir: string,
  name: string,
  kind: 'file' | 'folder',
  projectPaths: readonly string[],
): FsCreateResponse {
  const parent = resolveUnderAllowed(dir, {
    projects: projectPaths,
    gone: FS_CREATE_PARENT_GONE,
    denied: FS_NO_CREATE_PERMISSION,
  });
  if (!isExistingDirectory(parent)) throw new FsBrowseError(404, FS_CREATE_PARENT_GONE);
  if (!isSafeSegment(name)) throw new FsBrowseError(400, FS_NAME_NOT_ALLOWED);
  // isSafeSegment counts UTF-16 CODE UNITS; the filesystem's limit is 255
  // BYTES. A 250-character `é` name passes that check and costs 500 bytes, so
  // without this line the kernel answers ENAMETOOLONG and the user gets a 500
  // for what is plainly a name problem. Measured, not assumed.
  if (Buffer.byteLength(name, 'utf8') > MAX_NAME_BYTES) {
    throw new FsBrowseError(400, FS_NAME_NOT_ALLOWED);
  }
  if (isUnderDataDir(parent)) {
    // NOT a security boundary — a caller holding the token can already POST
    // /api/fs/mkdir anywhere. It is a category rule: the folder that holds the
    // auth token, prefs.json and history.json is not a scratch pad, and an
    // accidental `New file` in it is a support case nobody wants. It is still
    // LISTED, because it is a real folder in your home.
    throw new FsBrowseError(403, FS_DATA_DIR_REFUSED);
  }
  const target = join(parent, name);
  try {
    if (kind === 'folder') {
      mkdirSync(target); // Not recursive: EEXIST rather than a silent success.
    } else {
      // 'wx' is O_CREAT|O_EXCL|O_WRONLY. O_EXCL is the point: it fails EEXIST
      // instead of truncating, and it refuses to FOLLOW A SYMLINK at the final
      // component — so a pre-planted `~/notes/x -> /etc/passwd` cannot be
      // written through by "create an empty file".
      closeSync(openSync(target, 'wx'));
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') throw new FsBrowseError(409, FS_ALREADY_EXISTS);
    if (code === 'EACCES' || code === 'EPERM') {
      throw new FsBrowseError(403, FS_NO_CREATE_PERMISSION);
    }
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new FsBrowseError(404, FS_CREATE_PARENT_GONE);
    }
    // The byte check above is the one that normally answers this, but the
    // limit is per COMPONENT on some filesystems and per PATH on others: a
    // legal name at the end of a very deep parent still ends here, and it is
    // still a name problem, not a server fault.
    if (code === 'ENAMETOOLONG') throw new FsBrowseError(400, FS_NAME_NOT_ALLOWED);
    throw new FsBrowseError(500, FS_CREATE_FAILED);
  }
  return { path: target };
}
