/**
 * The Files panel's repaint: the signature that decides whether anything
 * changed, `render()` (visibility, root sync, which tab is up, the poll),
 * `rebuild()` and `paint()` — the header, the body and WHERE THE KEYBOARD
 * LANDS after a rebuild.
 *
 * Split from `ui/files.ts` (O8, 2026-09-23), code moved as it stood.
 * Siblings: `files.ts` (the panel's shell, header, width grip and the menu
 * gesture), `files-ctx.ts` (the shared context), `files-destinations.ts`,
 * `files-tree.ts`, `files-git.ts`, `files-keys.ts`, `files-menu.ts`,
 * `files-naming.ts`, `files-render.ts`.
 */
import * as st from '../state.ts';
import { afterPanelHidden } from './files-select-model.ts';
import { closeRowMenu } from './context-menu.ts';
import { stemRange } from './rename-model.ts';
import { diffSummary, summaryText } from './files-model.ts';
import { changesToFiles } from './fs-model.ts';
import { commitVersion } from './commit-store.ts';
import type { FilesCtx, RenderPart } from './files-ctx.ts';

/**
 * Why `Changes` and `Commits` are unavailable here: the folder the panel is
 * standing in is not inside a git repository (or has not answered yet). Since
 * B2 this is a REAL probe (`GitChangesResponse.isRepo`), not A11's "the header
 * reads Home" stopgap, so a home folder that IS a repository offers both tabs
 * and a project registered outside one offers neither. A fragment, because it
 * is a tooltip on a control, not a sentence about the app.
 */
function noRepoTitle(name: string): string {
  return `No repository at ${name}`;
}

export function createRender(ctx: FilesCtx): RenderPart {
  // ---- rendering -------------------------------------------------------------

  let lastSig = '';

  function sig(): string {
    if (!st.filesPanelVisible()) return 'hidden';
    // The panel also reacts to what is on the other screens: an open commit
    // turns the Commits tab into its selected state (with the same collapse set
    // the view uses), and the open files ground their rows.
    const collapsed = Array.from(st.state.commitCollapsed).sort().join(',');
    // Every file that is a TAB somewhere keeps its row grounded (A10b: the
    // question moved from the pane's key to the strip's contents, and a diff
    // tab paints no row, so only `f:` ids are part of this picture).
    const openFiles = st.state.views
      .flatMap((v) => v.slots.flatMap((slot) => st.slotTabIds(slot)))
      .filter((k) => k.startsWith('f:'))
      .sort()
      .join(',');
    return [
      ctx.tab,
      ctx.headerName(),
      // The tab's own availability is a rendered state, so it belongs in the
      // signature: without it the last session exiting would leave an enabled
      // Commits tab on a panel headed `Home`.
      ctx.repoKnown() ? 'repo' : 'home',
      // The data itself: every listing and every git answer bumps this, which
      // is the only way a repaint can know that a folder it is already showing
      // has just answered.
      String(ctx.dataVersion),
      ctx.currentPath ?? '',
      Array.from(ctx.openFolders).sort().join(','),
      Array.from(ctx.changesOpen).sort().join(','),
      // A9b, widened by B10a: every chosen row is drawn (`is-sel`,
      // `aria-current`) and the ANCHOR is spoken (the copy strip), so a change
      // to either has to repaint the panel like any other. Sorted, because a
      // set has no order and the signature must not depend on one.
      [...ctx.selected.keys].sort().join(','),
      ctx.selected.anchor ?? '',
      // The rows of a delete in flight wear `is-busy`, and the guard that
      // refuses a second one is this same value.
      ctx.deleting === null ? '' : [...ctx.deleting].sort().join(','),
      // A9c: the name row, its kind, its folder, its refusal and whether the
      // request is out. The TEXT is deliberately not here — it lives in the
      // input between repaints, and a signature that changed on every
      // keystroke would rebuild the tree under the cursor.
      ctx.creating === null ? '' : `${ctx.creating.kind}:${ctx.creating.dir}:${ctx.creating.error ?? ''}`,
      ctx.createBusy ? 'busy' : '',
      // B13: the rename row, the same way — and whether D4's note is up, which
      // a session starting or ending while the row is open changes.
      ctx.renaming === null
        ? ''
        : `${ctx.renaming.path}:${ctx.renaming.error ?? ''}:${ctx.renameNote(ctx.renaming.path, ctx.renaming.dir) ?? ''}`,
      ctx.renameBusy ? 'rbusy' : '',
      st.state.openCommit ?? '',
      collapsed,
      openFiles,
      // B3: the history itself, and the OPEN commit's own answer — which this
      // panel reads (`ui/commit-store.ts`) and the commit view fetches, so a
      // commit landing has to repaint the selected state here too.
      ctx.commits === null ? '' : String(ctx.commits.length),
      ctx.commitsHead ?? '',
      ctx.commitsError ?? '',
      String(commitVersion()),
    ].join('|');
  }

  /**
   * An open commit belongs to the folder it was opened from. When the panel's
   * subject moves away from that folder — the session was ended, it exited, its
   * project was removed — the commit view would otherwise keep showing a
   * repository nothing on screen stands for any more (user report 2026-09-21:
   * "als ik sessie sluit met commitscherm open, blijft het commitscherm open").
   * Checked on EVERY render, a hidden panel included: hiding the panel does not
   * make the view any less stale. Closed in a microtask — `closeCommitView()`
   * notifies, and this runs inside a render.
   */
  function closeOrphanedCommit(): void {
    const at = st.state.openCommitAt;
    if (st.state.openCommit === null || at === null) return;
    const want = ctx.rootPath();
    if (want === null || want === at.root) return;
    queueMicrotask(() => {
      const now = st.state.openCommitAt;
      const root = ctx.rootPath();
      if (now !== null && root !== null && root !== now.root) st.closeCommitView();
    });
  }

  function render(): void {
    closeOrphanedCommit();
    if (!st.filesPanelVisible()) {
      lastSig = 'hidden';
      ctx.wasVisible = false;
      // The panel left the screen (the Files toggle, or the Projects drawer
      // borrowing the left column): the chosen folder goes with it. A9b lets a
      // selection take a paste away from a focused TERMINAL, and a destination
      // nobody can see must never do that. The menu goes with it for the same
      // reason: this branch returns BEFORE `rebuild()`, which is where the only
      // other `closeRowMenu()` lives, so an open card would float over a panel
      // that is no longer on screen.
      closeRowMenu();
      // And the name row with it (A9c, §6b): a half-typed name over a panel
      // nobody can see would come back on the next toggle as a question the
      // user has long stopped asking.
      ctx.dropNaming('hidden');
      ctx.selected = afterPanelHidden(ctx.selected);
      // …and with it the promise about where a delete would put the keyboard:
      // it is about rows on a screen nobody is looking at any more.
      ctx.focusAfterDelete = null;
      // A panel nobody can see may not hold a timer: the poll is dropped here
      // and armed again by the render that brings the panel back.
      ctx.syncPoll();
      return;
    }
    // Back on screen: re-read the root (cache-then-revalidate, so the rows that
    // are already there stay put) and re-ask git. A home folder we never
    // learned is asked for again — that probe is the only one with no second
    // chance of its own. A root that MOVED in the same pass has just been
    // fetched by `setRoot`, so it is not asked for twice.
    const returning = !ctx.wasVisible;
    ctx.wasVisible = true;
    if (returning && ctx.homePath === null) ctx.homeAsked = false;
    const moved = ctx.syncRoot();
    if (returning && !moved && ctx.currentPath !== null) {
      ctx.fetchFolder(ctx.currentPath);
      ctx.fetchChanges(ctx.currentPath);
    }
    // Which tab is on screen is decided here, on every pass: `Files` while the
    // wished one has no repository behind it (a DEFINITE no — see
    // `visibleTab`), the wished one again the moment one answers. The wish
    // itself is never touched by this, so a root change cannot spend it.
    ctx.tab = ctx.visibleTab();
    // The history the Commits tab is about, if nothing has asked for it yet:
    // the tab was opened before its repository answered, the root moved under
    // it, or the panel came back on screen. A failed attempt is NOT retried
    // here — the sentence stays until the user changes tab or root, or the
    // poll's next tick asks again.
    const nothingAsked = ctx.commits === null && ctx.commitsError === null && ctx.pageFlight === null;
    if (ctx.tab === 'commits' && ctx.currentPath !== null && (returning || nothingAsked)) {
      ctx.fetchCommits(ctx.currentPath, 0);
    }
    ctx.syncPoll();
    const s = sig();
    if (s === lastSig) return;
    lastSig = s;
    rebuild();
  }

  function rebuild(): void {
    // The menu is anchored to a row that is about to be replaced, so it goes
    // first — every other state here survives the rebuild, this one may not.
    // (The SELECTION does survive it: it is painted from the path.)
    closeRowMenu();
    ctx.rebuilding = true;
    try {
      paint();
    } finally {
      ctx.rebuilding = false;
    }
  }

  /**
   * May this panel move the keyboard right now (A9c)?
   *
   * Yes when nothing holds it (`<body>`, or nothing at all), when it is
   * already inside this panel, or when it is inside the EDITOR pane a created
   * file just opened — the app moved it there itself, so following the new row
   * is still one gesture. No when anything else has it, a terminal above all:
   * a pane hosting a PTY (`.term-host`) is the one place a stolen focus costs
   * keystrokes.
   */
  function keyboardIsOurs(): boolean {
    const a = document.activeElement;
    if (a === null || a === document.body) return true;
    if (!(a instanceof HTMLElement)) return false;
    // A node that is no longer in the document is the name row's OWN input,
    // which this very repaint removed: nobody is typing into it, and a browser
    // that has already dropped the focus to `<body>` would answer above.
    if (!a.isConnected) return true;
    if (a.closest('.files-view') !== null) return true;
    return a.closest('.pane') !== null && a.closest('.term-host') === null;
  }

  /**
   * The rebuild itself. Split out so `rebuilding` is raised for every path out
   * of it — the name row's `blur` handler reads that flag, and a repaint that
   * threw halfway would otherwise leave it raised for good, which is a create
   * that can never be cancelled by clicking away from it again.
   */
  function paint(): void {
    // A9c: the typed name lives in the element that is about to be replaced.
    // It is read out BEFORE anything is removed, so a repaint (a listing
    // landing, a refusal being drawn) never costs the user their text.
    if (ctx.creating !== null && ctx.nameInput !== null && ctx.nameInput.isConnected) {
      ctx.createText = ctx.nameInput.value;
    }
    // B13: the same for a rename — and where the caret or the selection was,
    // so a repaint never re-selects over what the user placed.
    if (ctx.renaming !== null && ctx.nameInput !== null && ctx.nameInput.isConnected) {
      ctx.renameText = ctx.nameInput.value;
      ctx.renameRange = { start: ctx.nameInput.selectionStart ?? 0, end: ctx.nameInput.selectionEnd ?? 0 };
    }
    const hadName =
      document.activeElement instanceof HTMLElement &&
      document.activeElement.classList.contains('files-newname');
    ctx.nameInput = null;
    const focusKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute('data-k')
        : null;

    const title = noRepoTitle(ctx.headerName());
    for (const [k, b] of ctx.tabBtns) {
      const on = k === ctx.tab;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      // A tab with no repository behind it is not a poorer view, it is no
      // view: the control is really disabled (not just dimmed) and says why on
      // hover and to a screen reader. The same title covers "there is no
      // repository here" and "we have not been told yet" on purpose — a third,
      // transient tooltip would be noise for the second it takes to ask.
      const off = !ctx.tabAvailable(k);
      // Disabling the focused element drops the keyboard on <body> (the
      // browser blurs it, and a disabled button cannot be refocused below), so
      // the Files tab takes the focus first: always enabled, always visible.
      if (off && document.activeElement === b) ctx.tabBtns.get('files')?.focus();
      b.disabled = off;
      if (off) {
        b.setAttribute('aria-disabled', 'true');
        b.title = title;
      } else {
        b.removeAttribute('aria-disabled');
        b.title = '';
      }
    }
    ctx.projName.textContent = ctx.headerName();
    ctx.syncCopyStrip();

    // The summary belongs to the repository, so it is drawn for the Changes
    // tab only — and not for a clean tree, where `+0 -0 … in 0 files` would
    // say the same thing as the sentence under it, twice.
    const files = ctx.changes !== null && ctx.changes.isRepo ? ctx.changes.files : [];
    if (ctx.tab === 'changes' && files.length > 0) {
      const totals = diffSummary(changesToFiles(files));
      ctx.sumAdd.textContent = `+${totals.add}`;
      ctx.sumDel.textContent = `-${totals.del}`;
      // Every changed file counts, not only the ones carrying numbers: an
      // untracked file has no diff to count and is still one of the files
      // this repository has changed.
      ctx.sumText.textContent = summaryText(files.length);
      ctx.summary.hidden = false;
    } else {
      ctx.summary.hidden = true;
    }
    ctx.body.replaceChildren(
      ...(ctx.tab === 'commits' ? ctx.commitRows() : []),
      ...(ctx.tab === 'files' ? ctx.fileRows() : []),
      ...(ctx.tab === 'changes' ? ctx.changeRows() : []),
    );
    // The selected state has its own header block above the body (the back
    // control, the message and the meta line); it is the same commit the full
    // view shows, so the two can never disagree.
    ctx.selHd.replaceChildren(...ctx.selectedHeader());
    ctx.selHd.hidden = ctx.selHd.children.length === 0;

    // WHERE THE KEYBOARD LANDS, in the order the gestures happened (A9c).
    //
    // 1. the row a create just made, as soon as its folder has answered with
    //    it. Until that answer lands there is no such row, so the promise is
    //    carried across repaints — and dropped the moment the refetch is over
    //    without it, so it can never steal the keyboard later.
    if (ctx.focusCreated !== null) {
      const made = ctx.root.querySelector<HTMLElement>(`[data-k="${CSS.escape(ctx.focusCreated.key)}"]`);
      const dir = ctx.focusCreated.dir;
      if (made !== null) {
        ctx.focusCreated = null;
        // ONLY IF THE KEYBOARD IS STILL OURS. The listing lands a moment after
        // the create, and in that moment the user may have clicked into a
        // terminal: moving the focus onto a tree row then would take the next
        // keystrokes away from a PTY.
        if (keyboardIsOurs()) {
          made.focus();
          return;
        }
      } else if (!ctx.inFlight.has(dir)) {
        ctx.focusCreated = null;
      }
    }
    // 2. the name row: on the repaint that created it, and on every repaint
    //    that replaced it while it had the keyboard (a refusal being drawn).
    const fresh = ctx.liveNameInput();
    if (fresh !== null && (ctx.focusName || hadName)) {
      ctx.focusName = false;
      fresh.focus();
      const r = ctx.renaming;
      if (r !== null) {
        // A rename selects the STEM on its first focus only (a folder: the
        // whole name), so typing replaces the name and keeps the extension;
        // every later repaint puts back what the user had.
        if (!ctx.renameStemDone) {
          ctx.renameStemDone = true;
          const stem = stemRange(fresh.value, r.dir);
          fresh.setSelectionRange(stem.start, stem.end);
        } else if (ctx.renameRange !== null) {
          fresh.setSelectionRange(ctx.renameRange.start, ctx.renameRange.end);
        }
      }
      return;
    }
    // 3. whatever had it before this rebuild, by key.
    if (focusKey !== null) {
      const back = ctx.root.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`);
      if (back !== null) {
        // The keyboard is standing on a row that is still here, so a pending
        // delete promise is about some other row and is dropped: it may never
        // move the focus away from a row the user walked to themselves.
        if (ctx.focusAfterDelete !== null && !ctx.focusAfterDelete.gone.has(focusKey)) {
          ctx.focusAfterDelete = null;
        }
        back.focus();
        return;
      }
      // 4. the row the keyboard was on is GONE, and this delete promised where
      //    to go next (B10a): the nearest surviving row, else the Files tab —
      //    always a real control, never `<body>`, where no key reaches
      //    anything until the next window activation.
      const promise = ctx.focusAfterDelete;
      if (promise !== null && promise.gone.has(focusKey)) {
        ctx.focusAfterDelete = null;
        for (const key of promise.candidates) {
          const row = ctx.root.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`);
          if (row !== null) {
            row.focus();
            return;
          }
        }
        // An empty tree has no row to stand on; the tab that is always there
        // takes the keyboard instead.
        ctx.tabBtns.get('files')?.focus();
      }
    }
  }

  return {
    get lastSig() { return lastSig; },
    set lastSig(v) { lastSig = v; },
    render,
  };
}
