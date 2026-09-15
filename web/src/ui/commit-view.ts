/**
 * Commit view (Nocturne part A6) — one commit, full width, over the pane area.
 *
 * PLACE IN THE SHELL. It is a flex sibling of the pane grid in the middle row,
 * between the Files panel and the editor column, and while it is up the grid
 * is `hidden` (main.ts owns that flag, see `applyScreenLayout`). Nothing here
 * touches a terminal: the panes are not disposed, only invisible, and
 * `ui/panes.ts` refuses to rebuild against a grid it cannot measure — which is
 * what keeps xterm's WebGL renderer intact across the trip (memory:
 * frontend-terminal-quirks).
 *
 * WHAT IS REAL AND WHAT IS NOT. Nothing. The commit, its files and every diff
 * row come from `ui/files-mock.ts` + `ui/commit-model.ts`'s synthetic diff
 * until part B3 reads `git show`. One quiet line in the header says exactly
 * that, from ONE function with ONE call site, so B3 removes it by deleting
 * both. `Open on GitHub` is deliberately NOT a link: no datum in this app
 * knows a remote yet (part B3), and a `#` href would be a promise the app
 * cannot keep — it is a button that says it is unavailable (`aria-disabled`)
 * and carries the one sentence that says when it will work, in text a screen
 * reader reaches as well as a pointer.
 *
 * STRUCTURE of a file block: a 38px header row holding a toggle button (caret,
 * path, +/-) and two real buttons beside it (`Open file`, `Changes`), then the
 * unified diff on the terminal ground. The block header is a ROW of buttons
 * rather than one big clickable div, because a button inside a button is not a
 * thing and a hover-only affordance is forbidden here.
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { caretLeftIcon } from './icons.ts';
import {
  authorInitial,
  barBlocks,
  blockDomId,
  commitTotals,
  fileName,
  filesChangedText,
  pathSeed,
  syntheticDiff,
  type CommitFileChange,
} from './commit-model.ts';
import {
  MOCK_BRANCH,
  NO_EXAMPLE_CONTENT,
  mockCommitByHash,
  mockFileContent,
} from './files-mock.ts';
import { rootForSubject } from './slots-model.ts';
import { caretGlyph } from './files-model.ts';
import { flash } from './statusline.ts';
import type { CommitEntry } from './files-model.ts';

export interface CommitView {
  render(): void;
}

/** The one thing that can stop a file from opening: the tab is already full. */
const TAB_FULL = 'This tab is full. It can show 4 panes.';

/**
 * WHICH TAB a file from this commit opens in. The view stands over the pane
 * area of the ACTIVE tab, and the Files panel that opened it was reading that
 * same tab — so the root is the tab's own (`Home`, or its project), and for a
 * plain session tab it is the project of the session in the focused pane.
 * A session without a project lands at `Home`; part B2 closes that gap with
 * the real file-browser root (the A10 gap, plan decision 9).
 */
function commitRoot(): st.ViewRoot {
  const v = st.activeView();
  if (v !== null && v.root !== null) return v.root;
  const slot = v === null ? undefined : v.slots[v.focused];
  const info = slot?.kind === 'session' ? st.state.sessions.get(slot.id) : undefined;
  return rootForSubject({ home: info === undefined, projectId: info?.projectId ?? null });
}

/**
 * The view leaves in two directions, and both end in the pane area: `Back to
 * sessions` returns to the panes it covered (`onLeaveScreen`), while
 * `Open file` / `Changes` open a PANE and go there (`onOpenPane`). Since part
 * A10 both are `requestTerminalFocus` — the focused pane is a file, a diff or
 * a terminal and knows how to take the keyboard itself — but they stay two
 * arguments because they are two acts, and main.ts is where that is decided.
 * They are injected, not imported: `ui/panes.ts` pulls in @xterm/xterm and
 * this module has to stay drivable under `node --test`.
 */
export function initCommitView(
  host: HTMLElement,
  onLeaveScreen: () => void,
  onOpenPane: () => void,
): CommitView {
  const root = el('section', 'commit-view');
  const card = el('div', 'commit-card');
  const hd = el('header', 'commit-vhd');
  const body = el('div', 'commit-vbody');
  card.append(hd, body);
  root.append(card);
  host.append(root);

  let backBtn: HTMLButtonElement | null = null;
  let lastSig = '';
  /** The hash the view last opened ON, so focus is handed over exactly once. */
  let focusedFor: string | null = null;

  function sig(): string {
    const open = st.state.openCommit;
    if (open === null) return 'closed';
    const c = mockCommitByHash(open);
    // A hash nobody can resolve is its OWN state, not the closed one: the pane
    // grid is hidden on `openCommit !== null`, so this screen still has to
    // render something with a way out of it.
    if (c === null) return `missing|${open}`;
    const collapsed = Array.from(st.state.commitCollapsed).sort().join(',');
    return `${c.hash}|${collapsed}`;
  }

  function render(): void {
    const s = sig();
    if (s === lastSig) return;
    lastSig = s;
    const open = st.state.openCommit;
    if (open === null) {
      focusedFor = null;
      backBtn = null;
      hd.replaceChildren();
      body.replaceChildren();
      return;
    }
    const c = mockCommitByHash(open);
    if (c === null) {
      // Nothing to draw and nothing to blame the user for — but never an empty
      // pane area: the back control is the whole point of this branch.
      rebuildMissing();
    } else {
      rebuild(c);
    }
    if (focusedFor !== open) {
      focusedFor = open;
      // The screen just changed under the keyboard; land it on the way out.
      backBtn?.focus();
    }
  }

  /** The one control every state of this screen shares: the way back. */
  function backControl(): HTMLButtonElement {
    const b = button('commit-back', '', () => {
      // main.ts unhides the grid on the same `'screen'` notification; without
      // the hand-back the focus would fall to <body> and typing would reach
      // nothing until the next window activation (the rule the drawers and the
      // Files panel already follow).
      st.closeCommitView();
      onLeaveScreen();
    });
    b.setAttribute('data-k', 'commit:back');
    b.append(caretLeftIcon(), el('span', '', 'Back to sessions'));
    return b;
  }

  /**
   * A commit the view cannot resolve (B3: a hash that is no longer in the log,
   * a rewritten history). It says so in one sentence and keeps the exit.
   */
  function rebuildMissing(): void {
    backBtn = backControl();
    const top = el('div', 'commit-vtop');
    top.append(backBtn);
    hd.replaceChildren(top);
    body.replaceChildren(el('p', 'commit-missing', 'This commit is not available.'));
  }

  function rebuild(c: CommitEntry): void {
    const focusKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute('data-k')
        : null;
    const totals = commitTotals(c.files);

    backBtn = backControl();

    const title = el('div', 'commit-vtitle');
    title.append(el('div', 'commit-vmsg', c.message));
    const meta = el('div', 'commit-vmeta');
    const avatar = el('span', 'commit-avatar', authorInitial(c.author));
    avatar.setAttribute('aria-hidden', 'true');
    meta.append(
      avatar,
      el('span', 'commit-vauthor', c.author),
      el('span', '', `committed ${c.when}`),
      el('span', 'commit-branch', MOCK_BRANCH),
    );
    title.append(meta);

    const right = el('div', 'commit-vright');
    right.append(el('span', 'commit-vhash', c.hash));
    // NOT a link: see the module note. A real BUTTON, so the keyboard reaches
    // it and can be told why it does nothing — `aria-disabled` rather than
    // `disabled`, because a disabled control is skipped by the very reader the
    // sentence is for. The explanation is a visually-hidden span it points at
    // (`title` alone is a pointer-only affordance), and the same words are the
    // hover tooltip.
    const why = el('span', 'sr-only', 'Available when the view reads your repository');
    why.id = 'commit-gh-why';
    const gh = button('commit-gh', 'Open on GitHub');
    gh.setAttribute('aria-disabled', 'true');
    gh.setAttribute('aria-describedby', why.id);
    gh.title = 'Available when the view reads your repository';
    right.append(gh, why);

    const top = el('div', 'commit-vtop');
    top.append(backBtn, title, right);

    const sum = el('div', 'commit-vsum');
    sum.append(
      el('span', '', filesChangedText(c.files.length)),
      el('span', 'files-num is-add', `+${totals.add}`),
      el('span', 'files-num is-del', `-${totals.del}`),
    );
    const bar = el('span', 'commit-bar');
    bar.setAttribute('aria-hidden', 'true');
    for (const kind of barBlocks(totals.add, totals.del)) {
      const block = el('span', 'commit-bar-b');
      block.dataset.kind = kind;
      bar.append(block);
    }
    sum.append(bar);

    hd.replaceChildren(top, placeholderNote(), sum);
    body.replaceChildren(...c.files.map((f) => fileBlock(c, f)));

    if (focusKey !== null) {
      root.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  /**
   * PLACEHOLDER MARKER — DELETE WITH THE MOCK (part B3). Everything under this
   * header is `ui/files-mock.ts` and a synthetic diff, shown inside an app that
   * is otherwise about the user's own repository. One function, one call site.
   */
  function placeholderNote(): HTMLElement {
    return el('p', 'commit-note', 'Example commit until the view reads your repository.');
  }

  function fileBlock(c: CommitEntry, f: CommitFileChange): HTMLElement {
    const open = !st.commitFileCollapsed(c.hash, f.path);
    const block = el('section', 'diff-block');
    // The Files panel's row for this file folds this block from another
    // region, so the block carries the id that row's `aria-controls` names.
    block.id = blockDomId(c.hash, f.path);
    const row = el('div', 'diff-hd');

    const toggle = button('diff-toggle', '', () => st.toggleCommitFile(c.hash, f.path));
    toggle.setAttribute('data-k', `diff:${c.hash}:${f.path}`);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    const caret = el('span', 'files-caret', caretGlyph(open));
    caret.setAttribute('aria-hidden', 'true');
    toggle.append(
      caret,
      el('span', 'diff-path', f.path),
      el('span', 'files-num is-add', `+${f.add}`),
      el('span', 'files-num is-del', `-${f.del}`),
    );

    const openFile = button('diff-act', 'Open file', () => {
      // Open FIRST, close second. Both orders end in the same screen, but this
      // one costs ONE layout pass: the pane area is still covered while the
      // pane is added, so `ui/panes.ts` refuses to build anything; closing the
      // view then unhides the grid and the deferred render draws the new
      // layout once. The other order builds the panes twice.
      if (st.openFile(commitRoot(), f.path, fileName(f.path)) !== 'ok') {
        // The tab has no room: say so and stay, rather than closing this
        // screen for a pane that was never opened.
        flash(TAB_FULL);
        return;
      }
      st.closeCommitView();
      // This button went away with the view that held it; without the
      // hand-over the keyboard falls to <body>.
      onOpenPane();
    });
    openFile.setAttribute('data-k', `diffopen:${f.path}`);
    openFile.setAttribute('aria-label', `Open file ${f.path}`);

    // The v3 reference has no opener for a `d:` (diff) editor tab at all,
    // though its editor renders one — so this button is the honest affordance
    // that reaches that state: the same changes, in a tab, beside the file.
    const changes = button('diff-act', 'Changes', () => {
      // Same order, same reason as `Open file` above.
      if (st.openDiff(commitRoot(), c.hash, f.path) !== 'ok') {
        flash(TAB_FULL);
        return;
      }
      st.closeCommitView();
      onOpenPane();
    });
    changes.setAttribute('data-k', `diffchanges:${c.hash}:${f.path}`);
    changes.setAttribute('aria-label', `Changes to ${f.path} in this commit`);

    row.append(toggle, openFile, changes);
    block.append(row);
    if (open) block.append(diffBody(c.hash, f.path));
    return block;
  }

  return { render };
}

/**
 * The unified diff itself — the one renderer the editor's diff tab reuses.
 *
 * THE HASH IS PART OF WHAT A DIFF IS: `server/ws.ts` is in two of the mock's
 * commits, and B3's `git show <hash> -- <path>` answers differently for each.
 * The mock has one example diff per path until then, so these rows AND the
 * counted numbers are the same under both headers — the SIGNATURE is what B3
 * fills in, and no caller has to change when it does.
 *
 * A path the mock knows nothing about draws ONE note row. Not a numbered `+`
 * line: a sentence with a line number beside it reads as content of the file.
 */
export function diffBody(hash: string, path: string): HTMLElement {
  const box = el('div', 'diff-body');
  const text = mockFileContent(path);
  if (text === null) {
    box.append(el('p', 'diff-note', NO_EXAMPLE_CONTENT));
    return box;
  }
  // The SAME seed the mock counted its numbers with (files-mock.ts
  // `counted()`), or the header states an add/del the rows below contradict.
  for (const line of syntheticDiff(text, pathSeed(path))) {
    const row = el('div', 'diff-line');
    row.dataset.kind = line.kind;
    const n = el('span', 'diff-n', String(line.n));
    n.setAttribute('aria-hidden', 'true');
    const sign = el('span', 'diff-sign', line.sign);
    sign.setAttribute('aria-hidden', 'true');
    row.append(n, sign, el('span', 'diff-t', line.text));
    box.append(row);
  }
  return box;
}
