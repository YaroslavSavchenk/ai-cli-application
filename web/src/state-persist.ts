/**
 * View constructors and persistence: what a view looks like in localStorage,
 * `saveUi` / `loadUi` (schema v2, the v1 migration, the hostile-bag
 * validators), the run stamp, and the Home view's invariants.
 *
 * Split from `state.ts` (O8, 2026-09-23).
 * Siblings: `state-core.ts` (types, the store, pub/sub), `state-persist.ts`
 * (view constructors, localStorage save/load), `state-views.ts` (slot geometry,
 * view membership, server state, tabs), `state-editor.ts` (files as tabs of an
 * editor pane, unsaved text), `state-chrome.ts` (focus, drawers and the Files
 * panel, the commit view, connection readouts). `state.ts` re-exports them all.
 */
import { diffTabId, fileTabId } from './ui/editor-model.ts';
import {
  MAX_PANES,
  MAX_VIEWS,
  MAX_TABS,
  STORAGE_KEY,
  STORAGE_KEY_V1,
  type EditorTab,
  type PaneSlot,
  type ViewRoot,
  type ViewState,
  FILES_W_DEFAULT,
  clampFilesWidth,
  state,
} from './state-core.ts';
import { reconcileViews } from './state-views.ts';
import { newEditorSlot } from './state-editor.ts';

// --------------------------------------------------------------------------
// View constructors + persistence (client-local UI state only)
// --------------------------------------------------------------------------

/** Divider bounds: no pane may shrink below 15% of the grid. */
export const SPLIT_MIN = 0.15;
export const SPLIT_MAX = 0.85;

function clampSplit(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, v))
    : 0.5;
}

function newView(root: ViewRoot | null, slots: PaneSlot[]): ViewState {
  return {
    id: crypto.randomUUID(),
    root,
    slots,
    focused: 0,
    l3: 'L',
    split: { col: 0.5, row: 0.5 },
  };
}

function newSessionView(sessionId: string): ViewState {
  return newView(null, [{ kind: 'session', id: sessionId }]);
}

/**
 * What one view looks like in storage: its root, its SLOTS — terminals and
 * editor panes alike — and where the focus sat.
 *
 * EDITOR SLOTS PERSIST (user decision D2, 2026-09-22). Until part B4 their
 * tabs' text was never read from disk, so a reload that resurrected them would
 * have resurrected placeholder content; now a file tab is a path the app can
 * read again and a diff tab a commit that cannot change, so both come back.
 * The unsaved TEXT does not (`state.edits` is not persisted): it was never on
 * disk, and a bag of localStorage is not where a user's work is kept.
 *
 * `focused` is no longer remapped away from an editor pane: a tab whose
 * focused pane held files comes back with the focus on those files.
 */
function persistView(v: ViewState): Record<string, unknown> {
  return {
    id: v.id,
    root: v.root,
    slots: v.slots.map((s) =>
      s.kind === 'session'
        ? { kind: 'session', id: s.id }
        : {
            // The slot's own `e:<n>` is NOT written: it is the identity of a
            // pane on THIS page (ui/panes.ts keys its live panes by it), and a
            // reload builds new panes. `newEditorSlot` hands out a fresh one.
            kind: 'editor',
            tabs: s.tabs.slice(0, MAX_TABS).map((t) =>
              t.kind === 'file'
                ? { kind: 'file', path: t.path }
                : { kind: 'diff', root: t.root, hash: t.hash, path: t.path },
            ),
            active: s.active,
          },
    ),
    focused: Math.min(Math.max(0, v.focused), Math.max(0, v.slots.length - 1)),
    l3: v.l3,
    split: v.split,
  };
}

/**
 * The run stamp read out of the stored bag at `loadUi` (Nocturne B6, D3). A
 * boot whose `GET /api/runtime` has not answered — or failed — knows no run of
 * its own; writing `run: null` over a good stamp would turn the next boot's
 * "same run" into "another run" and drop the tabs. So a save with nothing to
 * say keeps what was there.
 */
let lastKnownRun: string | null = null;

/** True once `loadUi` has run: before that a save would write an empty bag. */
let uiLoaded = false;

/**
 * Adopt the run a restart/update handed over to (Nocturne B6, D3) and stamp the
 * bag with it, so the `location.reload()` that follows reads the bag as its OWN
 * run and keeps the tabs with `Reopen tabs on start` off. A no-op before
 * `loadUi`: a save then would write `views: []` over the user's arrangement.
 */
export function setRunStamp(startedAt: string): void {
  state.serverStartedAt = startedAt;
  if (!uiLoaded) return;
  saveUi();
}

export function saveUi(): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        views: state.views.map(persistView),
        active: state.activeViewId,
        // The left panel rides in the SAME bag as the pane splits: same chrome,
        // same gesture, so a dragged width survives a reload the way a split
        // fraction does. No version bump — the v2 reader ignores keys it does
        // not know, and a blob written before A5 simply lands on the defaults.
        leftPanel: state.leftPanel,
        filesWidth: state.filesWidth,
        // WHICH BACKEND RUN wrote this arrangement (Nocturne B6, user decision
        // D3): the run's start time, and while this boot does not know it yet
        // the stamp the bag already carried — never a null over a known run.
        // `loadUi` compares it with the run that is booting to
        // tell a reload (same run, the tabs stay) from a new app start (another
        // run, the `Reopen tabs on start` switch decides). No version bump: a
        // bag written before B6 simply has no stamp, which reads as "another
        // run" — the honest answer for a blob from a process that is gone.
        run: state.serverStartedAt ?? lastKnownRun,
      }),
    );
  } catch {
    // Storage full/unavailable — UI still works, arrangement just won't survive reload.
  }
}

/** Load-time bookkeeping shared by every stored view of one blob. */
interface LoadCtx {
  /** Session ids already claimed: a session appears in at most one view. */
  seen: Set<string>;
  /** A Home view was already decoded — there is exactly one. */
  home: boolean;
}

/** Decode a stored root. Anything else (absent, garbage) is a plain session tab. */
function validateRoot(raw: unknown, ctx: LoadCtx): ViewRoot | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.kind === 'home') {
    if (ctx.home) return null; // a second Home is not a Home
    ctx.home = true;
    return { kind: 'home' };
  }
  if (o.kind === 'project' && typeof o.id === 'string' && o.id !== '') {
    return { kind: 'project', id: o.id };
  }
  return null;
}

/**
 * Validate one stored v2 view: its root and its SLOTS — sessions AND editor
 * panes (part B4, user decision D2). A view without slots is dropped unless it
 * is Home, which is the fixed first tab and is allowed to stand empty; a view
 * holding only editor panes is a view with slots and SURVIVES.
 *
 * STORAGE IS HOSTILE, so every value is gated rather than trusted: a file
 * tab's path must be a non-empty ABSOLUTE path with no NUL byte (the shape
 * every path in this app has since part B2 — a relative one would be read
 * against nothing), a diff tab needs the full 40-hex hash and the folder it is
 * read from, an unknown tab kind is dropped, a strip is capped at `MAX_TABS`,
 * and a slot left with no valid tab at all is dropped with them (an editor
 * pane with an empty strip is not a state this model has).
 *
 * This is also the migration for two older shapes under the same v2 key (the
 * reader has always ignored what it does not know): pre-R3 launcher views
 * (kind: 'launcher', zero sessions) simply vanish, and a pre-A10 blob's
 * `sessions: string[]` is read as session slots, so an arrangement made before
 * A10 survives the upgrade. A pre-B4 blob simply carries no editor slot.
 */
function validateView(raw: unknown, ctx: LoadCtx): ViewState | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const root = validateRoot(o.root, ctx);
  const slots: PaneSlot[] = [];
  const addSession = (id: unknown): void => {
    if (typeof id !== 'string' || id === '' || ctx.seen.has(id)) return;
    if (slots.length >= MAX_PANES) return;
    ctx.seen.add(id);
    slots.push({ kind: 'session', id });
  };
  if (Array.isArray(o.slots)) {
    for (const s of o.slots) {
      if (s === null || typeof s !== 'object') continue;
      const slot = s as Record<string, unknown>;
      if (slot.kind === 'session') {
        addSession(slot.id);
        continue;
      }
      if (slot.kind !== 'editor' || slots.length >= MAX_PANES) continue;
      const tabs = validateTabs(slot.tabs);
      // No tab survived the gates: there is no pane to build. The strip is
      // never empty while the slot lives, so an empty one cannot be loaded.
      if (tabs.length === 0) continue;
      const made = newEditorSlot(tabs);
      const activeRaw = typeof slot.active === 'number' ? Math.trunc(slot.active) : 0;
      made.active = Math.min(Math.max(0, activeRaw), tabs.length - 1);
      slots.push(made);
    }
  } else if (Array.isArray(o.sessions)) {
    for (const s of o.sessions) addSession(s);
  }
  if (slots.length === 0 && root?.kind !== 'home') return null;
  const focusedRaw = typeof o.focused === 'number' ? Math.trunc(o.focused) : 0;
  const focused = Math.min(Math.max(0, focusedRaw), Math.max(0, slots.length - 1));
  const id = typeof o.id === 'string' && o.id !== '' ? o.id : crypto.randomUUID();
  const splitRaw = (o.split ?? null) as Record<string, unknown> | null;
  return {
    id,
    root,
    slots,
    focused,
    l3: o.l3 === 'R' ? 'R' : 'L',
    split: { col: clampSplit(splitRaw?.col), row: clampSplit(splitRaw?.row) },
  };
}

/** How long a stored path may be. Past this it is not a path any OS has. */
const MAX_STORED_PATH = 4096;

/**
 * A stored path: a non-empty string, no NUL byte, and no longer than a real
 * path can be. The cap is the reader's: a blob is hand-editable, and a
 * megabyte-long "path" would be carried into every chip label and every
 * request this tab makes.
 */
function storedPath(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  if (raw.length > MAX_STORED_PATH) return null;
  return raw.includes('\0') ? null : raw;
}

/**
 * The tabs of one stored editor slot, in order, gated one by one. Anything the
 * reader cannot make sense of is DROPPED rather than repaired: a tab about a
 * path that is not a path names no file, and a chip nobody can open is worse
 * than a chip that is not there.
 */
function validateTabs(raw: unknown): EditorTab[] {
  if (!Array.isArray(raw)) return [];
  const out: EditorTab[] = [];
  const seen = new Set<string>();
  for (const t of raw) {
    if (out.length >= MAX_TABS) break;
    if (t === null || typeof t !== 'object') continue;
    const tab = t as Record<string, unknown>;
    if (tab.kind === 'file') {
      const path = storedPath(tab.path);
      // ABSOLUTE only: every path the app opens a file by is absolute (part
      // B2), and a relative one would be read against a folder nobody named.
      if (path === null || !path.startsWith('/')) continue;
      const id = fileTabId(path);
      if (seen.has(id)) continue; // one strip never shows one file twice
      seen.add(id);
      out.push({ kind: 'file', path });
      continue;
    }
    if (tab.kind === 'diff') {
      const hash = typeof tab.hash === 'string' ? tab.hash : '';
      // The full 40 hex, as every hash in this app is (PLAN-B3): an
      // abbreviation is not an identity.
      if (!/^[0-9a-f]{40}$/.test(hash)) continue;
      // A diff path is REPOSITORY-relative (git's own spelling), so it is not
      // asked to be absolute; the root it is read from is.
      const path = storedPath(tab.path);
      const diffRoot = storedPath(tab.root);
      // The ROOT is absolute, like every other folder the app reads git in: a
      // relative one would be resolved against a folder nobody named.
      if (path === null || diffRoot === null || !diffRoot.startsWith('/')) continue;
      const id = diffTabId(hash, path);
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ kind: 'diff', hash, path, root: diffRoot });
      continue;
    }
    // An unknown kind is a future build's blob or a hand-edit: dropped.
  }
  return out;
}

/**
 * v1 -> v2 migration: each v1 tab (fixed layout, 4 pane slots) becomes a
 * rootless view whose slots are the tab's visible occupied sessions in order;
 * empty v1 tabs are dropped (there is no launcher view kind anymore). Ids are
 * kept so `active` maps across. A v1 blob predates roots entirely, so every
 * migrated view is a plain session tab and `Home` is added afterwards by
 * `ensureHomeView()`.
 */
function migrateV1(parsed: unknown, seen: Set<string>): { views: ViewState[]; active: unknown } {
  const views: ViewState[] = [];
  let active: unknown = null;
  if (parsed !== null && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    active = o.activeTabId;
    if (Array.isArray(o.tabs)) {
      for (const t of o.tabs) {
        if (views.length >= MAX_VIEWS) break;
        if (t === null || typeof t !== 'object') continue;
        const tab = t as Record<string, unknown>;
        const layout =
          tab.layout === 2 || tab.layout === 3 || tab.layout === 4 ? (tab.layout as number) : 1;
        const sessions: string[] = [];
        let focusedSession: string | null = null;
        if (Array.isArray(tab.panes)) {
          for (let i = 0; i < layout; i++) {
            const p = tab.panes[i];
            if (typeof p === 'string' && p !== '' && !seen.has(p)) {
              seen.add(p);
              sessions.push(p);
              if (tab.focused === i) focusedSession = p;
            }
          }
        }
        if (sessions.length === 0) continue;
        const splitRaw = (tab.split ?? null) as Record<string, unknown> | null;
        views.push({
          id: typeof tab.id === 'string' && tab.id !== '' ? tab.id : crypto.randomUUID(),
          root: null,
          slots: sessions.map((id) => ({ kind: 'session', id })),
          focused: Math.max(0, focusedSession !== null ? sessions.indexOf(focusedSession) : 0),
          l3: 'L',
          split: { col: clampSplit(splitRaw?.col), row: clampSplit(splitRaw?.row) },
        });
      }
    }
  }
  return { views, active };
}

/** What the boot has to tell `loadUi` about this run (Nocturne B6, D3). */
export interface LoadUiOpts {
  /**
   * The `Reopen tabs on start` preference (ui/prefs-model.ts). False = the
   * stored tabs are for the PREVIOUS app start only: a new backend run opens
   * on Home instead of restoring them.
   */
  reopen: boolean;
  /**
   * This backend run's start time (`state.serverStartedAt`), or null when the
   * runtime answer has not landed yet. It is the identity a stored bag is
   * compared against — never a clock reading, because the question is "is this
   * the same backend process", not "how long ago".
   */
  run: string | null;
}

/**
 * Rehydrate views from v2 storage; when only a v1 blob exists, migrate it
 * (then drop the v1 key). Prunes against the server's sessions and ensures
 * every server session has a view.
 *
 * With `reopen: false` the views are read only when the bag belongs to the run
 * that is booting — the reload inside one run (F5, the reload after `Restart
 * service` or an update) keeps the arrangement, a NEW app start drops it and
 * opens on Home (user decision D3, .claude/plans/nocturne/PLAN-B6.md). The
 * Files panel's open state and width are panel wishes, not tabs: restored
 * either way.
 */
export function loadUi(opts: LoadUiOpts): void {
  const ctx: LoadCtx = { seen: new Set<string>(), home: false };
  let views: ViewState[] = [];
  let active: unknown = null;

  // Defaults first, so a missing key, a garbage value and a pre-A5 blob all
  // land in the same place: the panel open at FILES_W_DEFAULT.
  state.leftPanel = 'files';
  state.filesWidth = FILES_W_DEFAULT;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    parsed = null;
  }
  // Which run wrote what is stored. Anything that is not a string — absent (a
  // pre-B6 bag, or a v1 blob), a number, a hand-edited object — reads as null,
  // which equals only a boot that does not know its own run either.
  const bag =
    parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const bagRun = typeof bag?.run === 'string' ? bag.run : null;
  lastKnownRun = bagRun;
  // The D3 gate, BEFORE anything is validated: with the switch off, a bag from
  // another run is not this window's arrangement at all. Sessions never survive
  // a backend run anyway, so what is dropped here is the editor tabs, the
  // folder tabs, the empty views, their names, their order and which one was
  // active — nothing that is running.
  // A boot that does not know its own run (the runtime read has not landed,
  // or failed) knows nothing AGAINST this bag either: unknown keeps the tabs.
  const keepViews = opts.reopen || opts.run === null || bagRun === opts.run;
  if (bag !== null) {
    const o = bag;
    if (keepViews) {
      if (Array.isArray(o.views)) {
        for (const v of o.views) {
          const vv = validateView(v, ctx);
          if (vv !== null && views.length < MAX_VIEWS) views.push(vv);
        }
      }
      active = o.active;
    }
    // The left panel is a PANEL wish, not a tab: it is restored whether or not
    // the tabs are (user decision D3). Only a literal null means "the user
    // closed it"; anything else (absent, a stale string, a number) is the
    // default wish.
    if (o.leftPanel === null) state.leftPanel = null;
    if (typeof o.filesWidth === 'number') state.filesWidth = clampFilesWidth(o.filesWidth);
  } else {
    // No v2 state: try migrating v1 (malformed v1 degrades to a clean start).
    // A v1 blob carries no run stamp, so with the switch off it is another
    // run's arrangement by definition — the same gate applies to it.
    let v1: unknown = null;
    try {
      v1 = JSON.parse(localStorage.getItem(STORAGE_KEY_V1) ?? 'null');
    } catch {
      v1 = null;
    }
    if (v1 !== null && keepViews) {
      const m = migrateV1(v1, ctx.seen);
      views = m.views;
      active = m.active;
    }
  }
  try {
    localStorage.removeItem(STORAGE_KEY_V1);
  } catch {
    // Ignore.
  }

  state.views = views;
  state.activeViewId =
    typeof active === 'string' && views.some((v) => v.id === active)
      ? active
      : (views[0]?.id ?? '');
  reconcileViews();
  // Zero SLOTS is the legal empty state (the handoff's): the launch dialog
  // opens on demand instead of a launcher tab being ever-present. Zero VIEWS
  // is not a state anymore — Home is always there, possibly empty.
  ensureHomeView();
  normalizeActive();
  uiLoaded = true;
  saveUi();
}

/** Keep activeViewId pointing at a real view ('' when none exist). */
function normalizeActive(): void {
  if (state.views.length === 0) {
    state.activeViewId = '';
  } else if (!state.views.some((v) => v.id === state.activeViewId)) {
    state.activeViewId = (state.views[0] as ViewState).id;
  }
}

/** Is this the fixed Home tab — the one that is never closed, dissolved or moved? */
function isHome(v: ViewState): boolean {
  return v.root?.kind === 'home';
}

/**
 * `Home` exists and is `state.views[0]` (user decision 2026-09-15, decision 4:
 * always present, always first, never draggable, never closable, never
 * dissolved — it may stand empty). Called at the top of `reconcileViews()` and
 * again in `loadUi()`; idempotent, and it never notifies — the callers own
 * their one save + notify.
 *
 * Returns whether it had to change anything.
 */
export function ensureHomeView(): boolean {
  const idx = state.views.findIndex(isHome);
  if (idx === 0) return false;
  if (idx > 0) {
    const [home] = state.views.splice(idx, 1);
    state.views.unshift(home as ViewState);
    return true;
  }
  state.views.unshift(newView({ kind: 'home' }, []));
  return true;
}

/**
 * The lowest strip position anything may be inserted at or dropped at:
 * nothing is ever placed before `Home` (`state.views[0]`, never moves — user
 * decision 4, 2026-09-15). `ui/dnd.ts` asks the same question.
 */
export function firstMovableIndex(): number {
  return state.views.length > 0 && isHome(state.views[0] as ViewState) ? 1 : 0;
}

// Shared with the sibling pieces (O8 split glue); not part of the public face.
export { clampSplit, newView, newSessionView, normalizeActive, isHome };
