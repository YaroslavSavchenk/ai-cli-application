/**
 * Files panel (Nocturne part A5) — the left panel: what changed in the active
 * project since its last commit, and the commits before that.
 *
 * PLACE IN THE SHELL. It is a flex sibling of the pane grid, exactly like the
 * two drawers, because that is what makes opening it a REAL layout change:
 * the grid narrows, every TerminalView's ResizeObserver fires, and the
 * existing debounced fit -> ws `resize` chain tells the PTY its new cols/rows.
 * Nothing here talks to a terminal; the seam does the work.
 *
 * WHAT IS REAL AND WHAT IS NOT. The header is the only live datum in this
 * panel: the FOCUSED session's project name, that session's own title when it
 * has no project, and `Home` — the panel's default root until part B2 (user
 * decision 2026-09-15) — when no session is focused or alive.
 * Everything else comes from `ui/files-mock.ts` until parts B2
 * (`git diff --numstat`) and B3 (`git log`). No fake interaction is wired for
 * it beyond what parts A5 and A6 can honestly do: folders open and close, a
 * file row opens that file in the editor (A6, mock text), a commit row opens
 * the full commit view (A6, mock diff).
 *
 * VISIBILITY. `state.leftPanel === 'files'` is the user's wish;
 * `st.filesPanelVisible()` adds "the Projects drawer is not borrowing the left
 * side" and is the only thing main.ts consults. A session is NOT a condition:
 * the panel opens with nothing running and the header then reads `Home` (user
 * decision 2026-09-15, deviates from v3, which also required a live session).
 *
 * WIDTH. 200..520px, dragged on the right edge with pointer capture, nudged
 * with the arrow keys — the same contract the pane split dividers already use,
 * because a control that only exists under a pointer is forbidden here.
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { caretLeftIcon, folderIcon } from './icons.ts';
import type { CommitEntry } from './files-model.ts';
import {
  badgeFor,
  buildTree,
  commitsHeaderText,
  diffSummary,
  summaryText,
  treeRows,
} from './files-model.ts';
import { blockDomId, filesChangedText } from './commit-model.ts';
import {
  MOCK_BRANCH,
  MOCK_COMMITS,
  MOCK_FILES,
  MOCK_OPEN_FOLDERS,
  mockCommitByHash,
} from './files-mock.ts';

type Tab = 'files' | 'commits';

/** Arrow-key step for the width, in px — the keyboard twin of the edge drag. */
const NUDGE_PX = 16;

export interface FilesPanel {
  render(): void;
}

/**
 * `onLeaveScreen` hands the keyboard back to the focused terminal after the
 * panel closed a surface the user was standing in (the commit view's
 * `All commits`). It is INJECTED rather than imported for the same reason
 * ui/panes.ts takes its launch opener that way — and here it also keeps this
 * module free of `ui/panes.ts`, whose import graph reaches @xterm/xterm, so
 * the panel stays drivable under `node --test`.
 */
export function initFilesPanel(host: HTMLElement, onLeaveScreen: () => void): FilesPanel {
  // Local to the panel instance: which tab is up and which folders are open.
  // Neither is server state and neither survives a reload — the tree itself is
  // still mocked, so persisting a set of folder names would persist fiction.
  let tab: Tab = 'files';
  const openFolders = new Set<string>(MOCK_OPEN_FOLDERS);

  const root = el('section', 'files-view');

  // ---- header: the two tabs, then the name of what we are looking at -------
  const hd = el('header', 'files-hd');
  const tabsRow = el('div', 'files-tabs');
  tabsRow.setAttribute('role', 'group');
  tabsRow.setAttribute('aria-label', 'files or commits');
  const tabBtns = new Map<Tab, HTMLButtonElement>();
  for (const t of [
    { k: 'files' as const, label: 'Files' },
    { k: 'commits' as const, label: 'Commits' },
  ]) {
    const b = button('files-tab', t.label, () => setTab(t.k));
    b.setAttribute('data-k', `ftab:${t.k}`);
    tabBtns.set(t.k, b);
    tabsRow.append(b);
  }
  const projName = el('span', 'files-proj');
  hd.append(tabsRow, el('span', 'drawer-gap'), projName);

  // ---- files tab: summary hairline + the tree ------------------------------
  const summary = el('div', 'files-sum');
  const sumAdd = el('span', 'files-num is-add');
  const sumDel = el('span', 'files-num is-del');
  const sumText = el('span', 'files-sum-text');
  summary.append(sumAdd, sumDel, sumText);

  const body = el('div', 'files-body');

  // The Commits tab's SELECTED state (a commit is open): a back control, the
  // message and the commit's meta line, above the per-file rows in the body.
  const selHd = el('div', 'files-selhd');
  selHd.hidden = true;

  root.append(hd, summary, selHd, body);

  // ---- the drag edge --------------------------------------------------------
  const grip = el('div', 'files-grip');
  grip.tabIndex = 0;
  grip.setAttribute('role', 'separator');
  grip.setAttribute('aria-orientation', 'vertical');
  grip.setAttribute('aria-label', 'files panel width');
  grip.setAttribute('aria-valuemin', String(st.FILES_W_MIN));
  grip.setAttribute('aria-valuemax', String(st.FILES_W_MAX));
  grip.title = 'Drag to resize. Arrow keys nudge it, home, enter or double-click resets it.';
  root.append(grip);

  host.append(root);

  function applyWidth(px: number): void {
    host.style.width = `${px}px`;
    grip.setAttribute('aria-valuenow', String(px));
  }
  applyWidth(st.state.filesWidth);

  // Pointer drag: capture on the grip so the pointer may leave the 6px strip,
  // and a body class kills text selection for the duration (dragging over a
  // tree otherwise paints half of it blue).
  let dragFrom = 0;
  let dragWidth = 0;
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('is-dragging');
    document.body.classList.add('is-resizing-col');
    dragFrom = e.clientX;
    dragWidth = st.state.filesWidth;
  });
  grip.addEventListener('pointermove', (e) => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    // Live: width + state only, no notify — the ResizeObservers in the panes
    // do the rest, and a notify per move would rebuild chrome at 60Hz.
    applyWidth(st.setFilesWidth(dragWidth + e.clientX - dragFrom, false));
  });
  const endDrag = (e: PointerEvent): void => {
    if (!grip.hasPointerCapture(e.pointerId)) return;
    grip.releasePointerCapture(e.pointerId);
    grip.classList.remove('is-dragging');
    document.body.classList.remove('is-resizing-col');
    applyWidth(st.setFilesWidth(st.state.filesWidth, true));
  };
  grip.addEventListener('pointerup', endDrag);
  grip.addEventListener('pointercancel', endDrag);
  grip.addEventListener('keydown', (e) => {
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = st.state.filesWidth - NUDGE_PX;
    else if (e.key === 'ArrowRight') next = st.state.filesWidth + NUDGE_PX;
    // Home and Enter both reset, and the title names both — the same contract
    // the pane dividers already promise (ui/panes.ts).
    else if (e.key === 'Home' || e.key === 'Enter') next = st.FILES_W_DEFAULT;
    if (next === null) return;
    e.preventDefault();
    applyWidth(st.setFilesWidth(next, true));
  });
  grip.addEventListener('dblclick', () => {
    applyWidth(st.setFilesWidth(st.FILES_W_DEFAULT, true));
  });

  // ---- what the header says -------------------------------------------------

  /**
   * The session the panel is about: the focused pane of the active tab. Its
   * PROJECT NAME is the header (never a path); a session without a project has
   * nothing else honest to show there, so the session's own name stands in.
   */
  function headerName(): string {
    const v = st.activeView();
    const id = v === null ? undefined : v.sessions[v.focused];
    const info = id === undefined ? undefined : st.state.sessions.get(id);
    if (info !== undefined && info.status !== 'exited') {
      return st.projectName(info.projectId) ?? info.title;
    }
    // The focused pane's session is gone (absent from state, or kept there
    // with `status === 'exited'` — state.ts markExited flips it in place and
    // reconcileViews keeps the dead pane on purpose), so this is a normal
    // state, not an impossible one. A headerless tree says nothing about
    // nothing — fall back to the first session still alive.
    for (const s of st.state.sessions.values()) {
      if (s.status !== 'exited') return st.projectName(s.projectId) ?? s.title;
    }
    // Nothing is running: the panel's default root, the user's home directory,
    // said as a NAME (the header rule forbids `~` and `/home/...`) until part
    // B2 makes the panel live.
    return 'Home';
  }

  function setTab(next: Tab): void {
    if (tab === next) return;
    tab = next;
    lastSig = '';
    render();
  }

  // ---- rendering -------------------------------------------------------------

  let lastSig = '';

  function sig(): string {
    if (!st.filesPanelVisible()) return 'hidden';
    // The panel also reacts to the two A6 screens: an open commit turns the
    // Commits tab into its selected state (with the same collapse set the
    // view uses), and the editor's active tab highlights its row in the tree.
    const collapsed = Array.from(st.state.commitCollapsed).sort().join(',');
    return [
      tab,
      headerName(),
      Array.from(openFolders).sort().join(','),
      st.state.openCommit ?? '',
      collapsed,
      st.state.editor.active ?? '',
    ].join('|');
  }

  function render(): void {
    if (!st.filesPanelVisible()) {
      lastSig = 'hidden';
      return;
    }
    const s = sig();
    if (s === lastSig) return;
    lastSig = s;
    rebuild();
  }

  function rebuild(): void {
    const focusKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute('data-k')
        : null;

    for (const [k, b] of tabBtns) {
      const on = k === tab;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
    projName.textContent = headerName();

    if (tab === 'files') {
      const totals = diffSummary(MOCK_FILES);
      sumAdd.textContent = `+${totals.add}`;
      sumDel.textContent = `-${totals.del}`;
      sumText.textContent = summaryText(totals.files);
      summary.hidden = false;
    } else {
      summary.hidden = true;
    }
    // ONE render site for the placeholder line, so B2/B3 remove it by deleting
    // `placeholderNote` and this one argument.
    body.replaceChildren(placeholderNote(), ...(tab === 'files' ? fileRows() : commitRows()));
    // The selected state has its own header block above the body (the back
    // control, the message and the meta line); it is the same commit the full
    // view shows, so the two can never disagree.
    selHd.replaceChildren(...selectedHeader());
    selHd.hidden = selHd.children.length === 0;

    if (focusKey !== null) {
      root.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  /**
   * PLACEHOLDER MARKER — DELETE WITH THE MOCK. Everything below the header is
   * `ui/files-mock.ts`, and it carries the user's real project name, so without
   * this line the panel reads as a report about their repository. Part B2 (the
   * file list) and B3 (the commits) each remove their own sentence, and when
   * both are gone this function and its single call site go with them.
   */
  function placeholderNote(): HTMLElement {
    return el(
      'p',
      'files-note',
      tab === 'files'
        ? 'Example data until the panel reads your files.'
        : 'Example data until the panel reads your commits.',
    );
  }

  /** The tree: folder rows toggle, file rows open that file in the editor (A6). */
  function fileRows(): HTMLElement[] {
    const rows: HTMLElement[] = [];
    for (const r of treeRows(buildTree(MOCK_FILES), openFolders)) {
      let row: HTMLElement;
      if (r.dir) {
        const b = button('files-row is-dir', '', () => {
          if (openFolders.has(r.path)) openFolders.delete(r.path);
          else openFolders.add(r.path);
          lastSig = '';
          render();
        });
        b.setAttribute('data-k', `fdir:${r.path}`);
        b.setAttribute('aria-expanded', r.open ? 'true' : 'false');
        row = b;
      } else {
        // A6: a file row opens that file in the editor column. The text it
        // shows is still `ui/files-mock.ts` until part B4 — the editor says so
        // in its own quiet line.
        const b = button('files-row is-file', '', () => {
          st.openEditorTab(st.editorFileId(r.path), r.name, r.path);
        });
        b.setAttribute('data-k', `ffile:${r.path}`);
        // The row of the file the editor is showing keeps a ground, so the
        // tree says where the editor is (v3: `editorActive === 'f:' + path`).
        b.classList.toggle('is-open', st.state.editor.active === st.editorFileId(r.path));
        row = b;
      }
      row.style.paddingLeft = `${r.indent}px`;
      row.classList.toggle('is-busy', r.busy);

      const caret = el('span', 'files-caret', r.caret);
      caret.setAttribute('aria-hidden', 'true');
      row.append(caret);

      if (r.dir) {
        const ic = folderIcon();
        ic.classList.add('files-folder');
        if (r.open) ic.classList.add('is-open');
        row.append(ic);
      } else {
        const b = badgeFor(r.name);
        const badge = el('span', 'files-badge', b.label);
        badge.dataset.kind = b.kind;
        badge.setAttribute('aria-hidden', 'true');
        row.append(badge);
      }

      const name = el('span', 'files-name', r.name);
      if (!r.dir) name.classList.toggle('has-diff', r.hasDiff);
      row.append(name);

      if (r.hasDiff) {
        row.append(
          el('span', 'files-num is-add', `+${r.add}`),
          el('span', 'files-num is-del', `-${r.del}`),
        );
      }
      rows.push(row);
    }
    return rows;
  }

  /**
   * The Commits tab's SELECTED state (A6): the header block above the body.
   * Empty — and hidden — unless a commit is open. `All commits` closes the
   * whole view, exactly like the view's own `Back to sessions`: one commit is
   * open or none is, and the panel and the view are two windows on that one
   * fact.
   */
  function selectedHeader(): HTMLElement[] {
    const c = openCommit();
    // Only the Commits tab turns into the selected state. Switching to Files
    // while a commit is open leaves the VIEW open and shows the tree — the
    // reference gates the panel on the tab, never the view (and the view's own
    // `Back to sessions` is always there).
    if (c === null || tab !== 'commits') return [];
    const back = button('files-back', '', () => {
      st.closeCommitView();
      onLeaveScreen();
    });
    back.setAttribute('data-k', 'commit:all');
    back.append(caretLeftIcon(), el('span', '', 'All commits'));

    const meta = el('div', 'commit-meta');
    meta.append(
      el('span', 'commit-hash', c.hash),
      el('span', '', c.author),
      el('span', '', c.when),
    );
    return [back, el('div', 'files-selmsg', c.message), meta];
  }

  /** The open commit, when the mock knows it. */
  function openCommit(): CommitEntry | null {
    return mockCommitByHash(st.state.openCommit);
  }

  /**
   * The Commits tab's body: the list, or — while a commit is open — that
   * commit's files, each row folding its own diff block in the view.
   */
  function commitRows(): HTMLElement[] {
    const open = openCommit();
    if (open !== null) {
      const rows: HTMLElement[] = [
        el('div', 'files-branch', filesChangedText(open.files.length)),
      ];
      for (const f of open.files) {
        const collapsed = st.commitFileCollapsed(open.hash, f.path);
        const row = button('commit-file', '', () => st.toggleCommitFile(open.hash, f.path));
        row.setAttribute('data-k', `cfile:${f.path}`);
        row.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        // The block it expands lives in the commit VIEW, a different region of
        // the screen — so the row names it by id instead of leaving
        // `aria-expanded` pointing at nothing.
        row.setAttribute('aria-controls', blockDomId(open.hash, f.path));
        row.classList.toggle('is-collapsed', collapsed);
        // The PATH is the row (a commit's files are not a tree), so it is mono
        // and it truncates at its FRONT — the file name is what identifies it.
        row.append(
          el('span', 'commit-fpath', f.path),
          el('span', 'files-num is-add', `+${f.add}`),
          el('span', 'files-num is-del', `-${f.del}`),
        );
        rows.push(row);
      }
      return rows;
    }
    const rows: HTMLElement[] = [
      el('div', 'files-branch', commitsHeaderText(MOCK_BRANCH, MOCK_COMMITS.length)),
    ];
    for (const c of MOCK_COMMITS) {
      const row = button('commit-row', '', () => st.openCommitView(c.hash));
      row.setAttribute('data-k', `commit:${c.hash}`);
      row.append(el('span', 'commit-msg', c.message));
      const meta = el('div', 'commit-meta');
      meta.append(
        el('span', 'commit-hash', c.hash),
        el('span', '', c.author),
        el('span', '', c.when),
        el('span', 'drawer-gap'),
        el('span', 'files-num is-add', `+${c.add}`),
        el('span', 'files-num is-del', `-${c.del}`),
      );
      row.append(meta);
      rows.push(row);
    }
    return rows;
  }

  return { render };
}
