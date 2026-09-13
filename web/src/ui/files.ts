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
 * WHAT IS REAL AND WHAT IS NOT. The only live datum in this panel is the
 * project name in its header — the project of the FOCUSED pane's session (and
 * that session's own name when it has no project: the panel always says what
 * it is about). Everything else comes from `ui/files-mock.ts` until parts B2
 * (`git diff --numstat`) and B3 (`git log`). No fake interaction is wired for
 * it: folders open and close (a real, local decision), file rows and commit
 * rows are inert until the editor (A6) and the commit view (A6) exist.
 *
 * VISIBILITY. `state.leftPanel === 'files'` is the user's wish and survives a
 * session-less moment; `st.filesPanelVisible()` adds "there is a live session"
 * and is the only thing main.ts consults.
 *
 * WIDTH. 200..520px, dragged on the right edge with pointer capture, nudged
 * with the arrow keys — the same contract the pane split dividers already use,
 * because a control that only exists under a pointer is forbidden here.
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { folderIcon } from './icons.ts';
import {
  badgeFor,
  buildTree,
  commitsHeaderText,
  diffSummary,
  summaryText,
  treeRows,
} from './files-model.ts';
import { MOCK_BRANCH, MOCK_COMMITS, MOCK_FILES, MOCK_OPEN_FOLDERS } from './files-mock.ts';

type Tab = 'files' | 'commits';

/** Arrow-key step for the width, in px — the keyboard twin of the edge drag. */
const NUDGE_PX = 16;

export interface FilesPanel {
  render(): void;
}

export function initFilesPanel(host: HTMLElement): FilesPanel {
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

  root.append(hd, summary, body);

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
    if (info !== undefined) return st.projectName(info.projectId) ?? info.title;
    // The focused pane's session is gone while the panel is still up: the
    // ACTIVE view keeps its dead pane on purpose (state.ts reconcileViews), so
    // this is a normal state, not an impossible one. A headerless tree says
    // nothing about nothing — fall back to the first session still alive, and
    // failing that say plainly that there is none.
    for (const s of st.state.sessions.values()) {
      if (s.status !== 'exited') return st.projectName(s.projectId) ?? s.title;
    }
    return 'No session';
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
    return `${tab}|${headerName()}|${Array.from(openFolders).sort().join(',')}`;
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
        ? 'Example data until the panel reads your project.'
        : 'Example data until the panel reads your commits.',
    );
  }

  /** The tree: folder rows toggle, file rows are inert until the editor (A6). */
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
        // A5 renders files, it does not open them: clicking one does nothing
        // until the editor lands in part A6. A dead button would be a lie to
        // the keyboard, so a file row is a plain row with a hover.
        row = el('div', 'files-row is-file');
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
   * The commits list. Rows are INERT in A5 on purpose: clicking a commit opens
   * the full-screen commit view, and that view is part A6 — a row that lit up
   * and did nothing would be worse than a row that does not invite the click.
   */
  function commitRows(): HTMLElement[] {
    const rows: HTMLElement[] = [
      el('div', 'files-branch', commitsHeaderText(MOCK_BRANCH, MOCK_COMMITS.length)),
    ];
    for (const c of MOCK_COMMITS) {
      const row = el('div', 'commit-row');
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
