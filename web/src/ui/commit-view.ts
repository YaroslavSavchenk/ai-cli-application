/**
 * Commit view (Nocturne part A6, live since part B3) — one commit, full width,
 * over the pane area.
 *
 * PLACE IN THE SHELL. It is a flex sibling of the pane grid in the middle row,
 * between the Files panel and the pane grid (the A6 editor column it once sat
 * beside is gone: since A10b the files live in an EDITOR PANE of the grid
 * itself), and while it is up the grid
 * is `hidden` (main.ts owns that flag, see `applyScreenLayout`). Nothing here
 * touches a terminal: the panes are not disposed, only invisible, and
 * `ui/panes.ts` refuses to rebuild against a grid it cannot measure — which is
 * what keeps xterm's WebGL renderer intact across the trip (memory:
 * frontend-terminal-quirks). An answer landing while this screen is up
 * notifies `'screen'` and nothing else, so no pane is built, reconciled or
 * measured behind it.
 *
 * WHAT IS REAL (part B3). Everything: the commit, its files and every diff row
 * come from `git show` through `ui/commit-store.ts` — which owns the one
 * request per commit and the one request per file, so this screen and the
 * Files panel's selected state can never disagree. The A6 honesty line is gone
 * with the mock it was about.
 *
 * `Open on GitHub` is rendered ONLY when the repository really has an `origin`
 * on github.com (user decision D2, 2026-09-21): absent otherwise, and absent
 * while the commit is still loading — a control that is there but refuses is a
 * promise the app has not checked yet. It is a BUTTON, never an `<a href>`:
 * the WebView2 host drops a link navigation, and the one call it does hand to
 * the user's browser lives in `ui/open-external.ts`.
 *
 * STRUCTURE of a file block: a 38px header row holding a toggle button (caret,
 * path, +/-) and two real buttons beside it (`Open file`, `Changes`), then the
 * unified diff on the terminal ground. The block header is a ROW of buttons
 * rather than one big clickable div, because a button inside a button is not a
 * thing and a hover-only affordance is forbidden here.
 *
 * THE FIRST TEN BLOCKS ARE OPEN, the rest are folded (orchestrator default,
 * 2026-09-21): a diff is one request per file, and a 200-file merge would
 * otherwise cost 200 of them for a screen nobody has scrolled yet.
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { relativeTime } from './format-model.ts';
import { caretLeftIcon } from './icons.ts';
import {
  BINARY_TEXT,
  TOO_LARGE_TEXT,
  authorInitial,
  barBlocks,
  blockDomId,
  collapseKey,
  committedByText,
  filesChangedText,
  fullDateTime,
  githubCommitUrl,
  moreFilesText,
} from './commit-model.ts';
import {
  askDiff,
  commitAsked,
  commitVersion,
  diffAsked,
  setDiffListener,
  syncCommit,
  type Asked,
} from './commit-store.ts';
import { fileName, rootForSubject } from './slots-model.ts';
import { caretGlyph } from './files-model.ts';
import { LOADING_TEXT, joinPath } from './fs-model.ts';
import { openExternal } from './open-external.ts';
import { flash } from './statusline.ts';
import { openDiffGuarded, openFileGuarded } from './unsaved.ts';
import { log } from '../log.ts';
import type { GitCommitDiffResponse, GitCommitFile, GitCommitResponse } from '../../../shared/protocol.ts';

export interface CommitView {
  render(): void;
}

/** The one thing that can stop a file from opening: the tab is already full. */
const TAB_FULL = 'This tab is full. It can show 4 panes.';

/**
 * Why `Open file` cannot act YET: the repository behind this commit has not
 * answered. It is a sentence and not a shrug because the wait is real and
 * short — the Files panel is asking git for that same root right now.
 */
const REPO_UNKNOWN = 'The app is still reading this repository.';

/** How many file blocks a commit opens with unfolded (orchestrator default). */
export const OPEN_BLOCKS = 10;

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
 *
 * `now` is the clock, injected for the same reason: `committed 3 hours ago` is
 * computed at every render, and a test must be able to say what "now" is.
 */
export function initCommitView(
  host: HTMLElement,
  onLeaveScreen: () => void,
  onOpenPane: () => void,
  now: () => number = () => Date.now(),
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
  /** The commit whose file list has already been folded past the tenth block. */
  let seededFor: string | null = null;
  /**
   * The drawn blocks, by path: the section and its header ROW (which holds the
   * three controls, so it is never rebuilt by a diff landing). One diff
   * answering repaints exactly one of these — see `paintDiff`.
   */
  const blocks = new Map<string, { block: HTMLElement; row: HTMLElement }>();

  /**
   * ONE block, repainted where its answer landed (scope review, part B3). The
   * whole body used to be torn down per diff: ten parallel answers meant ten
   * rebuilds of up to ten times two thousand rows, and the keyboard was
   * handed back by key each time. The header row is kept, so whatever the user
   * is standing on inside it never moves.
   */
  function paintDiff(path: string): void {
    const hash = st.state.openCommit;
    const found = blocks.get(path);
    // No block drawn (another commit, a closed view), or the user folded this
    // one while its answer was in flight: nothing to paint, and the fold must
    // not be undone by an answer arriving.
    if (hash === null || found === undefined || st.commitFileCollapsed(hash, path)) {
      lastSig = sig();
      return;
    }
    found.block.replaceChildren(found.row, diffBox(diffAsked(path)));
    // The store's version moved with that answer; the next render must not
    // read it as "something else changed" and rebuild the whole body.
    lastSig = sig();
  }
  setDiffListener(paintDiff);

  function sig(): string {
    const open = st.state.openCommit;
    if (open === null) return 'closed';
    const collapsed = Array.from(st.state.commitCollapsed).sort().join(',');
    // The store's version is what makes an ANSWER a repaint: the hash and the
    // fold set are both unchanged when a diff lands behind a block. And
    // whether the REPOSITORY is known yet is a rendered state of its own —
    // it decides whether `Open file` is a control or a sentence.
    const repo = st.state.openCommitAt?.repoRoot === null ? 'waiting' : 'repo';
    return `${open}|${commitVersion()}|${repo}|${collapsed}`;
  }

  function render(): void {
    const open = st.state.openCommit;
    const at = st.state.openCommitAt;
    // FIRST, before the signature: the store is what the signature reads, and
    // a commit nobody has asked for yet would otherwise never be asked for.
    syncCommit(open, at === null ? null : at.root);
    if (sig() === lastSig) return;
    if (open === null) {
      lastSig = sig();
      focusedFor = null;
      seededFor = null;
      backBtn = null;
      blocks.clear();
      hd.replaceChildren();
      body.replaceChildren();
      return;
    }
    const asked = commitAsked();
    if (asked === null || asked.k === 'loading') rebuildState(LOADING_TEXT, false);
    // A commit git cannot answer for (a rewritten history, a pruned object, a
    // dead backend) is its OWN state, not the closed one: the pane grid is
    // hidden on `openCommit !== null`, so this screen still has to render
    // something with a way out of it.
    else if (asked.k === 'error') rebuildState(asked.message, true);
    else rebuild(open, asked.value);
    // AFTER the build: drawing a commit for the first time folds everything
    // past the tenth block, which is part of what the signature is about.
    lastSig = sig();
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
   * A commit that is still loading, or one the view cannot resolve. One line —
   * the server's own sentence when there is one — and the exit, which is the
   * whole point of this branch.
   */
  function rebuildState(text: string, danger: boolean): void {
    // `Loading…` becomes an answer (or a refusal) under the user's hands, and
    // the control they are standing on is REPLACED by that repaint — so the
    // keyboard is handed back by key, exactly as a fold does it below. Without
    // this the focus falls to a detached node and the next key reaches nothing.
    const focusKey = focusedKey();
    backBtn = backControl();
    const top = el('div', 'commit-vtop');
    top.append(backBtn);
    hd.replaceChildren(top);
    const note = el('p', 'commit-missing', text);
    if (danger) note.classList.add('is-bad');
    body.replaceChildren(note);
    restoreFocus(focusKey);
  }

  /** The `data-k` of whatever holds the keyboard, or null. */
  function focusedKey(): string | null {
    return document.activeElement instanceof HTMLElement
      ? document.activeElement.getAttribute('data-k')
      : null;
  }

  /** Put the keyboard back on the control with this key, if it is still drawn. */
  function restoreFocus(key: string | null): void {
    if (key === null) return;
    root.querySelector<HTMLElement>(`[data-k="${CSS.escape(key)}"]`)?.focus();
  }

  function rebuild(hash: string, c: GitCommitResponse): void {
    const focusKey = focusedKey();

    // Everything past the tenth block starts folded — once per commit, and
    // BEFORE the blocks below are drawn from that same set.
    if (seededFor !== hash) {
      seededFor = hash;
      st.seedCommitCollapsed(c.files.slice(OPEN_BLOCKS).map((f) => collapseKey(hash, f.path)));
    }

    backBtn = backControl();

    const title = el('div', 'commit-vtitle');
    title.append(el('div', 'commit-vmsg', c.commit.subject));
    const meta = el('div', 'commit-vmeta');
    const avatar = el('span', 'commit-avatar', authorInitial(c.commit.author));
    avatar.setAttribute('aria-hidden', 'true');
    meta.append(avatar, el('span', 'commit-vauthor', c.commit.author));
    // The server hands over an EMPTY timestamp when git's own date failed its
    // strict ISO check. Two empty spans (or a `committed ` with nothing after
    // it) would read as facts that went missing, so the line simply has one
    // fewer item — the app says what it knows and nothing it does not.
    const ago = relativeTime(c.commit.authoredAt, now());
    if (ago !== '') meta.append(el('span', '', `committed ${ago}`));
    const full = fullDateTime(c.commit.authoredAt);
    if (full !== '') meta.append(el('span', 'commit-vwhen', full));
    // Only when it is somebody else: the server sends null when the committer
    // IS the author, and "Committed by Sava" under "Sava" says nothing.
    if (c.committer !== null) {
      meta.append(el('span', 'commit-vby', committedByText(c.committer)));
    }
    // A detached head has no branch to name, so the chip is absent rather than
    // filled with a word that is not a branch.
    if (c.branch !== null) meta.append(el('span', 'commit-branch', c.branch));
    title.append(meta);

    const right = el('div', 'commit-vright');
    right.append(el('span', 'commit-vhash', c.commit.shortHash));
    const gh = githubButton(c);
    if (gh !== null) right.append(gh);

    const top = el('div', 'commit-vtop');
    top.append(backBtn, title, right);

    const sum = el('div', 'commit-vsum');
    sum.append(
      el('span', '', filesChangedText(c.commit.files)),
      el('span', 'files-num is-add', `+${c.commit.add}`),
      el('span', 'files-num is-del', `-${c.commit.del}`),
    );
    const bar = el('span', 'commit-bar');
    bar.setAttribute('aria-hidden', 'true');
    for (const kind of barBlocks(c.commit.add, c.commit.del)) {
      const block = el('span', 'commit-bar-b');
      block.dataset.kind = kind;
      bar.append(block);
    }
    sum.append(bar);

    hd.replaceChildren(top, sum);
    blocks.clear();
    const drawn: HTMLElement[] = [];
    // The message BODY is the first thing in the SCROLLER, never in the fixed
    // header: a long message there took the card's whole height, left the file
    // blocks no room and nothing to scroll (user report 2026-09-21, a 40-line
    // commit message). Here it scrolls away with the files it describes.
    if (c.body !== '') drawn.push(el('pre', 'commit-vtext', c.body));
    for (const f of c.files) drawn.push(fileBlock(hash, f));
    // The server capped the file list: say how many are missing, in the body
    // where the blocks it is about would have been.
    if (c.truncated > 0) drawn.push(el('p', 'commit-more', moreFilesText(c.truncated)));
    body.replaceChildren(...drawn);

    restoreFocus(focusKey);
  }

  /**
   * `Open on GitHub`, or NOTHING (user decision D2). The server answers
   * `github: null` for every remote that is not `origin` on github.com, and
   * this page re-checks the two names and the hash against the same patterns
   * before it builds an address — the string came out of the user's own
   * repository config, and it is about to be handed to the one call that can
   * leave this window.
   */
  function githubButton(c: GitCommitResponse): HTMLButtonElement | null {
    const gh = c.github;
    if (gh === null) return null;
    const url = githubCommitUrl(gh.owner, gh.repo, c.commit.hash);
    if (url === null) return null;
    const b = button('commit-gh', 'Open on GitHub', () => {
      // The SHAPE of the act, never the address: a log line is not a place to
      // put the name of somebody's repository.
      log.debug('open commit on github');
      openExternal(url);
    });
    b.setAttribute('data-k', 'commit:gh');
    b.title = 'Open this commit in your browser';
    return b;
  }

  function fileBlock(hash: string, f: GitCommitFile): HTMLElement {
    const open = !st.commitFileCollapsed(hash, f.path);
    const block = el('section', 'diff-block');
    // The Files panel's row for this file folds this block from another
    // region, so the block carries the id that row's `aria-controls` names.
    block.id = blockDomId(hash, f.path);
    const row = el('div', 'diff-hd');

    const toggle = button('diff-toggle', '', () => st.toggleCommitFile(hash, f.path));
    toggle.setAttribute('data-k', `diff:${hash}:${f.path}`);
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    const caret = el('span', 'files-caret', caretGlyph(open));
    caret.setAttribute('aria-hidden', 'true');
    toggle.append(caret, el('span', 'diff-path', f.path));
    // A binary file has no lines to count, so it states nothing rather than
    // `+0 -0`, which would read as "this commit changed nothing in it".
    if (f.add !== null && f.del !== null) {
      toggle.append(
        el('span', 'files-num is-add', `+${f.add}`),
        el('span', 'files-num is-del', `-${f.del}`),
      );
    }

    // WHERE THE REPOSITORY IS may not be known yet: the history and the
    // Changes answer are two requests and the history can win. A commit is
    // fully readable meanwhile — only this one control waits, and it SAYS so
    // instead of being a dead click (scope review, part B3).
    const repo = st.state.openCommitAt?.repoRoot ?? null;
    const openFile = button('diff-act', 'Open file', () => {
      if (repo === null) {
        // `aria-disabled`, not `disabled`: a reader must still reach the
        // reason, and a pointer user gets it in the statusline.
        flash(REPO_UNKNOWN);
        return;
      }
      // Open FIRST, close second. Both orders end in the same screen, but this
      // one costs ONE layout pass: the pane area is still covered while the
      // tab is added, so `ui/panes.ts` refuses to build anything; closing the
      // view then unhides the grid and the deferred render draws the new
      // layout once. The other order builds the panes twice.
      //
      // Since A10b this ADDS A TAB to the tab's editor pane (and raises it
      // when the file is already open there) instead of taking a pane of its
      // own — `st.openFile` decides that, and this call did not change.
      //
      // THE PATH IS ABSOLUTE, exactly like the one a `Changes` row hands over
      // (ui/files.ts): a commit names its files relative to the REPOSITORY, so
      // it is joined onto the repository this view was opened from. Part B3
      // reads the working-tree file; nothing checks HERE that it still exists
      // — since B4 the pane answers for that itself: its read draws the
      // server's own sentence, and a save onto a file that is gone offers
      // `Overwrite`.
      //
      // THROUGH THE B4 GUARD (amendment 2026-09-22): a strip holds four files,
      // and a fifth evicts the last chip — so this open can drop unsaved text
      // and has to ask first. `done` runs only when the open really happened,
      // so `Keep editing` leaves this screen exactly as it is, which is the
      // same "stay" a full tab gets below. It is SYNCHRONOUS whenever nothing
      // would be lost (the common case), so the one-layout-pass order above
      // still holds.
      openFileGuarded(commitRoot(), joinPath(repo, f.path), fileName(f.path), {
        returnFocus: openFile,
        done: (r) => {
          if (r !== 'ok') {
            // The tab has no room for a new PANE and no editor pane to add a
            // tab to: say so and stay, rather than closing this screen for a
            // file that was never opened.
            flash(TAB_FULL);
            return;
          }
          st.closeCommitView();
          // This button went away with the view that held it; without the
          // hand-over the keyboard falls to <body>.
          onOpenPane();
        },
      });
    });
    openFile.setAttribute('data-k', `diffopen:${f.path}`);
    openFile.setAttribute('aria-label', `Open file ${f.path}`);
    if (repo === null) {
      openFile.setAttribute('aria-disabled', 'true');
      openFile.title = REPO_UNKNOWN;
    }

    // The v3 reference has no opener for a `d:` (diff) editor tab at all,
    // though its editor renders one — so this button is the honest affordance
    // that reaches that state: the same changes, in a tab, beside the file.
    const changes = button('diff-act', 'Changes', () => {
      // Same order, same reason as `Open file` above. The tab carries the root
      // it is read from, because it outlives this screen.
      // Guarded like `Open file`: a diff owns no text of its own, but the
      // chip it evicts may.
      openDiffGuarded(commitRoot(), hash, f.path, readRoot(), {
        returnFocus: changes,
        done: (r) => {
          if (r !== 'ok') {
            flash(TAB_FULL);
            return;
          }
          st.closeCommitView();
          onOpenPane();
        },
      });
    });
    changes.setAttribute('data-k', `diffchanges:${hash}:${f.path}`);
    changes.setAttribute('aria-label', `Changes to ${f.path} in this commit`);

    row.append(toggle, openFile, changes);
    block.append(row);
    blocks.set(f.path, { block, row });
    if (open) {
      // The request goes out on the FIRST unfold and never again while this
      // commit is open — the store keeps the answer (and a refusal) for as
      // long as the view does.
      askDiff(f.path);
      block.append(diffBox(diffAsked(f.path)));
    }
    return block;
  }

  /** The folder every request of this screen is made from. */
  function readRoot(): string {
    return st.state.openCommitAt?.root ?? '';
  }

  return { render };
}

/**
 * The unified diff itself — the one renderer a DIFF TAB of an editor pane
 * reuses (ui/file-pane.ts `diffPaneBody`), so this screen and that pane can
 * never disagree about what a commit changed. It takes the ANSWER, not a
 * question: the commit view holds one per unfolded block in `ui/commit-store.ts`,
 * a diff pane holds its own, and both hand it here.
 *
 * A FILE WITH NO ROWS SAYS WHY. `binary` and `tooLarge` are two different
 * facts, and neither is an empty block: a diff body with nothing in it reads
 * as "this commit did not touch it".
 */
export function diffBox(asked: Asked<GitCommitDiffResponse>): HTMLElement {
  const box = el('div', 'diff-body');
  if (asked.k === 'loading') {
    box.append(el('p', 'diff-note', LOADING_TEXT));
    return box;
  }
  if (asked.k === 'error') {
    const note = el('p', 'diff-note is-bad', asked.message);
    box.append(note);
    return box;
  }
  const res = asked.value;
  if (res.binary) {
    box.append(el('p', 'diff-note', BINARY_TEXT));
    return box;
  }
  if (res.tooLarge) {
    box.append(el('p', 'diff-note', TOO_LARGE_TEXT));
    return box;
  }
  for (const line of res.lines) {
    const row = el('div', 'diff-line');
    row.dataset.kind = line.kind;
    // TWO gutters, because a unified diff numbers the OLD file and the NEW one
    // side by side and a single running counter numbers neither. The side a
    // row does not exist on stays blank; a hunk header has no number at all.
    const oldNo = el('span', 'diff-n', line.oldNo === null ? '' : String(line.oldNo));
    const newNo = el('span', 'diff-n', line.newNo === null ? '' : String(line.newNo));
    oldNo.setAttribute('aria-hidden', 'true');
    newNo.setAttribute('aria-hidden', 'true');
    const sign = el('span', 'diff-sign', SIGN[line.kind]);
    sign.setAttribute('aria-hidden', 'true');
    // `textContent` only, always: a diff row is the user's own source, and the
    // one thing it may never be is markup.
    row.append(oldNo, newNo, sign, el('span', 'diff-t', line.text));
    box.append(row);
  }
  return box;
}

/** The one-column mark beside a row. Geometry: the ground already says it too. */
const SIGN: Record<string, string> = { add: '+', del: '-', ctx: ' ', hunk: ' ' };
