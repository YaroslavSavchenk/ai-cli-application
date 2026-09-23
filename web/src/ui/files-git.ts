/**
 * The Files panel's two WATCHING tabs: `Changes` (the git probe that also
 * decides whether a repository is behind the panel, and its 5 s poll) and
 * `Commits` (paged history pinned to one head, and the selected state while a
 * commit is open) — parts B2 §7 and B3.
 *
 * Split from `ui/files.ts` (O8, 2026-09-23), code moved as it stood.
 * Siblings: `files.ts` (the panel's shell, header, width grip and the menu
 * gesture), `files-ctx.ts` (the shared context), `files-destinations.ts`,
 * `files-tree.ts`, `files-git.ts`, `files-keys.ts`, `files-menu.ts`,
 * `files-naming.ts`, `files-render.ts`.
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { openFileGuarded } from './unsaved.ts';
import { fileName } from './slots-model.ts';
import { caretLeftIcon, folderIcon } from './icons.ts';
import { fileIcon } from './icons-files.ts';
import { buildTree, fileIconFor, commitsHeaderText, rowIndent, treeRows } from './files-model.ts';
import {
  LOADING_TEXT,
  NO_CHANGES_TEXT,
  changesToFiles,
  joinPath,
  messageOf,
  truncatedText,
} from './fs-model.ts';
import {
  NO_COMMITS_TEXT,
  SHOW_MORE_TEXT,
  absoluteDate,
  blockDomId,
  branchLabel,
  filesChangedText,
  fullDateTime,
  moreFilesText,
  relativeTime,
} from './commit-model.ts';
import { commitAsked } from './commit-store.ts';
import type { GitChangesResponse, GitCommitSummary, GitCommitsResponse } from '../../../shared/protocol.ts';
import type { FilesCtx, Tab, GitPart } from './files-ctx.ts';

/**
 * How often a WATCHING tab re-asks git, while it is the VISIBLE tab and the
 * panel is on screen (PLAN-B2 §7, kept by PLAN-B3 for `Commits`). The one poll
 * part B2 added: those two tabs exist to watch a session change files and
 * commit them, so a listing one gesture old — which is right for the tree —
 * would be the wrong promise here. Every other second is slower than a human
 * reads a diff and cheap beside the caps the backend puts on the git call
 * itself. ONE interval serves both tabs; the tick asks whichever is up.
 */
const CHANGES_POLL_MS = 5000;

/**
 * A CHANGED file row's title (the `Changes` tab). It names one thing because
 * the row does one thing: its path belongs to the repository, not to the
 * folder the panel lists, so it is no drag source, answers no chord and opens
 * no menu.
 */
const CHANGED_ROW_TITLE = 'Open in a pane.';

export function createGit(ctx: FilesCtx): GitPart {
  // ---- changes -------------------------------------------------------------
  //
  // The `Changes` tab (§7): `git diff --numstat` plus the untracked set, for
  // the REPOSITORY the root sits in — which may be an ancestor of the root
  // (a project registered at `web/` inside a repository), so the tab's own
  // line names that repository rather than pretending the two are the same
  // folder.
  //
  // It is also the PROBE. `isRepo` decides whether `Changes` and `Commits`
  // exist at all, so one request goes out per root whatever tab is up; the 5 s
  // poll is armed only while this tab is the visible one.

  /** The last answer for the current root, or null while none has arrived. */
  let changes: GitChangesResponse | null = null;
  /** The sentence the last attempt failed with, or null. */
  let changesError: string | null = null;
  /** The root that answer belongs to (never rendered — a path is not a label). */
  let changesRoot: string | null = null;
  /** The generation whose changes request is in flight, or null. */
  let changesFlight: number | null = null;
  /** The Changes tree's OWN open set: repo-relative paths, not the Files tab's. */
  const changesOpen = new Set<string>();
  /** The poll, armed only while this tab is visible. */
  let pollId: number | null = null;

  function fetchChanges(root: string): void {
    // Dedupe WITHIN a generation — a poll tick over a slow git call is
    // skipped — but never across one: a root change must always get its own
    // answer, or the tab that asks "is this a repository" is never told.
    const gen = ctx.generation;
    if (changesFlight === gen) return;
    changesFlight = gen;
    ctx.fs.changes(root)
      .then((res) => {
        if (gen !== ctx.generation) return;
        changes = res;
        changesError = null;
        changesRoot = root;
        // An open commit view may be waiting for exactly this: the repository
        // its file paths are relative to (part B3, scope review).
        if (res.repoRoot !== null) st.noteCommitRepoRoot(root, res.repoRoot);
      })
      .catch((err: unknown) => {
        if (gen !== ctx.generation) return;
        changes = null;
        changesError = messageOf(err);
        changesRoot = root;
      })
      .finally(() => {
        if (changesFlight === gen) changesFlight = null;
        if (gen !== ctx.generation) return;
        ctx.bump();
      });
  }

  /**
   * Arm or drop the poll. The timer exists only while a WATCHING tab is the
   * visible one AND the panel is on screen, so a hidden panel and the Files
   * tab cost nothing at all; a tick while a request is still in flight is
   * skipped by the fetch itself. ONE timer serves both watching tabs: which
   * question it asks is decided when it FIRES, so switching between them costs
   * no timer churn and can never leave two running.
   */
  function syncPoll(): void {
    const watching = ctx.tab === 'changes' || ctx.tab === 'commits';
    const want = st.filesPanelVisible() && watching && ctx.currentPath !== null;
    if (want && pollId === null) {
      pollId = window.setInterval(() => {
        const root = ctx.currentPath;
        if (root === null) return;
        if (ctx.tab === 'changes') fetchChanges(root);
        else if (ctx.tab === 'commits') fetchCommits(root, 0);
      }, CHANGES_POLL_MS);
      return;
    }
    if (!want && pollId !== null) {
      window.clearInterval(pollId);
      pollId = null;
    }
  }

  // ---- commits (part B3) -----------------------------------------------------
  //
  // The `Commits` tab: the history of HEAD, newest first, ten rows a page
  // (user decision D1, 2026-09-21), through the same injected gateway and the
  // same root the Changes tab sends — one boundary check covers both.
  //
  // PAGING IS PINNED. Page one answers a `head`; every `Show more` after it
  // sends `from=<that head>`, so a commit landing mid-browse cannot shift a
  // row into the next page or repeat one already on screen. The 5 s poll asks
  // for PAGE ONE only: the same head means nothing changed and the loaded
  // pages (and the scroll position) stay exactly as they are; a different head
  // means the history moved and the list goes back to page one, which is the
  // only honest thing to show when the rows under a pinned page are no longer
  // reachable from it.

  /** How many rows a page holds — the first one and every `Show more` (D1). */
  const COMMITS_PAGE = 10;

  /** The pages loaded so far, newest first, or null while none has arrived. */
  let commits: GitCommitSummary[] | null = null;
  /**
   * Was the last answer about a repository at all? A root can stop being one
   * between two ticks (a folder moved, a project re-registered); the Changes
   * probe is what takes the tab away on the next render, and until it does
   * this tab draws NOTHING rather than `No commits yet.`, which would be a
   * sentence about a repository that is not there.
   */
  let commitsRepo = true;
  /** The head every page after the first is pinned to; null on an empty repository. */
  let commitsHead: string | null = null;
  /** The branch and the total, as page one answered them. */
  let commitsBranch: string | null = null;
  let commitsTotal = 0;
  /** Is there an older commit past the last row. */
  let commitsMore = false;
  /** The sentence the last attempt failed with, or null. */
  let commitsError: string | null = null;
  /**
   * The generation whose PAGE-ONE request is in flight (the tab opening, the
   * poll), or null — and, separately, the one whose `Show more` is. They are
   * two markers because they are two questions: a `Show more` pressed while a
   * poll tick is out must go, not be swallowed (scope review, part B3), and a
   * poll tick while an older page is loading is what the skip is for.
   */
  let pageFlight: number | null = null;
  let moreFlight: number | null = null;

  /**
   * One page. `skip` 0 is page one (and the poll's question); anything else is
   * a `Show more`, pinned to the head page one answered.
   */
  function fetchCommits(root: string, skip: number): void {
    // Dedupe WITHIN a generation, exactly like `fetchChanges`: a poll tick over
    // a slow `git log` is skipped, and so is a second `Show more` while the
    // first is still out.
    const gen = ctx.generation;
    const first = skip === 0;
    if ((first ? pageFlight : moreFlight) === gen) return;
    const from = first ? undefined : (commitsHead ?? undefined);
    if (first) pageFlight = gen;
    else moreFlight = gen;
    ctx.fs.commits(root, COMMITS_PAGE, skip, from)
      .then((res) => {
        if (gen !== ctx.generation) return;
        commitsError = null;
        takePage(res, skip);
      })
      .catch((err: unknown) => {
        if (gen !== ctx.generation) return;
        // The rows that are already on screen are not wrong because the NEXT
        // page failed: a `Show more` that could not answer says so under the
        // list it did load, and only page one clears it.
        if (skip === 0) commits = null;
        commitsError = messageOf(err);
      })
      .finally(() => {
        if (first && pageFlight === gen) pageFlight = null;
        if (!first && moreFlight === gen) moreFlight = null;
        if (gen !== ctx.generation) return;
        ctx.bump();
      });
  }

  /** Fold one answer into the list, by the pinning rules above. */
  function takePage(res: GitCommitsResponse, skip: number): void {
    commitsRepo = res.isRepo;
    if (!res.isRepo) {
      // Not a repository (any more): hold an EMPTY answer, so the render draws
      // nothing and asks nothing, and let the probe move the tab.
      commits = [];
      commitsHead = null;
      commitsMore = false;
      return;
    }
    if (skip === 0) {
      // Same head, same history: keep every page the user has loaded and the
      // place they had scrolled to.
      if (commits !== null && res.head === commitsHead) return;
      commits = [...res.commits];
    } else {
      // A `Show more` whose answer belongs to a head that has since moved is
      // dropped: page one is already being re-read.
      if (commits === null || res.head !== commitsHead) return;
      commits = [...commits, ...res.commits];
    }
    commitsHead = res.head;
    commitsBranch = res.branch;
    commitsTotal = res.total;
    commitsMore = res.more;
  }

  /** Forget the history: the root moved, or the panel left the screen. */
  function dropCommits(): void {
    commits = null;
    commitsRepo = true;
    // THE MARKERS GO WITH IT (scope review, part B3). They belong to the root
    // we just left; leaving one set would make the render below think a
    // request for the NEW root is already out, and the new history would wait
    // for the next poll tick — five seconds, or forever with the panel hidden.
    pageFlight = null;
    moreFlight = null;
    commitsHead = null;
    commitsBranch = null;
    commitsTotal = 0;
    commitsMore = false;
    commitsError = null;
  }

  /**
   * Is there a repository behind this panel? The REAL probe since B2: the last
   * git answer for this root — `true`, `false`, or NULL while no answer for
   * this root has arrived. The third value is the whole point (see `tab` /
   * `wish` above): the two are not the same fact.
   */
  function isRepo(): boolean | null {
    return changes === null ? null : changes.isRepo;
  }

  /**
   * Is there a repository, as far as anyone can say right now? Unknown reads
   * as no HERE, because this answers whether a tab can be CHOSEN, and a tab
   * that leads to `Loading…` is not a choice yet. While it is unknown the two
   * tabs stay disabled with the same title they carry when the answer is "no"
   * — a third, transient tooltip for the second it takes to ask would be noise.
   */
  function repoKnown(): boolean {
    return isRepo() === true;
  }

  /** Is this tab reachable at all? `Files` always; the other two need a repository. */
  function tabAvailable(t: Tab): boolean {
    return t === 'files' || repoKnown();
  }

  /**
   * Which tab is ON SCREEN, given what the user wished for and what git has
   * said. The fallback to `Files` needs a DEFINITE `isRepo: false`: a root
   * change nulls the answer, and falling back on "not yet" would take the
   * Changes tab away from anyone moving between two repositories — the tab
   * they are watching, lost for the width of one git call.
   */
  function visibleTab(): Tab {
    if (ctx.wish === 'files') return 'files';
    return isRepo() === false ? 'files' : ctx.wish;
  }

  /**
   * The Changes tab's own header line: the REPOSITORY's name and the branch it
   * is on. The name, never the path — and it is said out loud precisely
   * because the repository can be an ancestor of the folder the Files tab
   * lists, which is the one place this panel would otherwise have two
   * different subjects on one screen. A detached head has no branch to name,
   * so the line is just the repository.
   */
  function changesHeaderText(): string {
    const root = changes === null ? null : changes.repoRoot;
    const repo = root === null ? '' : fileName(root);
    const branch = changes === null ? null : changes.branch;
    if (repo === '') return branch ?? '';
    return branch === null ? repo : `${repo}, ${branch}`;
  }

  /**
   * The Changes tab's body: the same `buildTree` + `treeRows` renderer the A5
   * tree has always used, over `changesToFiles()` — one tree vocabulary in
   * this panel, not two. Rows carry their own `gdir:`/`gfile:` keys — `g` for
   * git, and deliberately NOT `c…`, which the Commits tab already spends on
   * its per-file rows: `rebuild()` restores the keyboard by `data-k`, so two
   * tabs sharing a key would land the focus on the other tab's row. The drop
   * layer (which resolves a folder row by its `fdir:` path) can never mistake
   * a repo-relative path for a real one either.
   */
  function changeRows(): HTMLElement[] {
    if (changesError !== null) return [ctx.stateRow(changesError, rowIndent(0), true)];
    if (changes === null) return [ctx.stateRow(LOADING_TEXT, rowIndent(0), false)];
    if (!changes.isRepo) return [];
    const out: HTMLElement[] = [el('div', 'files-branch', changesHeaderText())];
    if (changes.files.length === 0) {
      out.push(ctx.stateRow(NO_CHANGES_TEXT, rowIndent(0), false));
      return out;
    }
    const repoRoot = changes.repoRoot;
    for (const r of treeRows(buildTree(changesToFiles(changes.files)), changesOpen)) {
      let row: HTMLElement;
      if (r.dir) {
        const b = button('files-row is-dir', '', () => {
          if (changesOpen.has(r.path)) changesOpen.delete(r.path);
          else changesOpen.add(r.path);
          ctx.lastSig = '';
          ctx.render();
        });
        b.setAttribute('data-k', `gdir:${r.path}`);
        b.setAttribute('aria-expanded', r.open ? 'true' : 'false');
        row = b;
      } else {
        // A changed file opens exactly like a file in the tree beside it: the
        // path is repo-relative, so it is made absolute against the repository
        // it belongs to and never against the panel's own root.
        const b = button('files-row is-file', '', () => {
          if (repoRoot === null) return;
          // Guarded since the B4 amendment: a fifth file evicts the strip's
          // last chip, and an evicted chip carrying unsaved text asks first.
          openFileGuarded(ctx.currentRoot(), joinPath(repoRoot, r.path), r.name);
        });
        b.setAttribute('data-k', `gfile:${r.path}`);
        // Its OWN title, naming only what it does. A changed file row is not a
        // drag source, has no ctrl+alt+enter and opens no menu (its path is
        // repo-relative — nothing in the drop layer or the row menu can act on
        // it), so promising the tree row's three affordances would be three
        // lies on one control.
        b.title = CHANGED_ROW_TITLE;
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
        row.append(fileIcon(fileIconFor(r.name)));
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
      out.push(row);
    }
    if (changes.truncated > 0) {
      out.push(ctx.stateRow(truncatedText(changes.truncated), rowIndent(0), false));
    }
    return out;
  }

  /**
   * The Commits tab's SELECTED state (A6): the header block above the body.
   * Empty — and hidden — unless a commit is open. `All commits` closes the
   * whole view, exactly like the view's own `Back to sessions`: one commit is
   * open or none is, and the panel and the view are two windows on that one
   * fact.
   *
   * A commit view that is ALREADY open when the repository goes away (the last
   * session exits) is left standing: it is a full screen with its own
   * `Back to sessions`, closing it under the user would take away the thing
   * they are reading. What the disabled tab removes is the way to open the
   * NEXT one — the panel flips to Files and the commit list is out of reach.
   */
  function selectedHeader(): HTMLElement[] {
    const asked = commitAsked();
    // Only the Commits tab turns into the selected state. Switching to Files
    // while a commit is open leaves the VIEW open and shows the tree — the
    // reference gates the panel on the tab, never the view (and the view's own
    // `Back to sessions` is always there).
    if (asked === null || ctx.tab !== 'commits') return [];
    const back = button('files-back', '', () => {
      st.closeCommitView();
      ctx.onLeaveScreen();
    });
    back.setAttribute('data-k', 'commit:all');
    back.append(caretLeftIcon(), el('span', '', 'All commits'));
    // The way back comes FIRST and alone while the commit is still loading, or
    // when it cannot be read at all: the view beside this panel is saying what
    // happened, and one sentence on two surfaces is one sentence too many.
    if (asked.k !== 'ready') return [back];

    const c = asked.value.commit;
    const meta = el('div', 'commit-meta');
    meta.append(el('span', 'commit-hash', c.shortHash), el('span', 'commit-author', c.author));
    // Empty when git's own date failed the server's strict ISO check; an empty
    // span would be a gap the user reads as a missing fact.
    const ago = relativeTime(c.authoredAt, ctx.now());
    if (ago !== '') meta.append(el('span', '', ago));
    return [back, el('div', 'files-selmsg', c.subject), meta];
  }

  /**
   * The Commits tab's body: the list, or — while a commit is open — that
   * commit's files, each row folding its own diff block in the view.
   *
   * THE OPEN COMMIT IS NOT FETCHED HERE. `ui/commit-store.ts` holds the one
   * answer the view already asked for, so this panel and that screen can never
   * list different files, and a commit costs ONE request between them.
   */
  function commitRows(): HTMLElement[] {
    const hash = st.state.openCommit;
    if (hash !== null) return openCommitRows(hash);
    if (commitsError !== null && commits === null) {
      return [ctx.stateRow(commitsError, rowIndent(0), true)];
    }
    if (commits === null) return [ctx.stateRow(LOADING_TEXT, rowIndent(0), false)];
    if (!commitsRepo) return [];
    const branch = branchLabel(commitsBranch);
    // A repository with no commit in it names its branch and says so; there is
    // no count to give, because `0 commits` reads as a number that was counted
    // wrong rather than as a repository nobody has committed to.
    if (commitsHead === null) {
      return [el('div', 'files-branch', branch), ctx.stateRow(NO_COMMITS_TEXT, rowIndent(0), false)];
    }
    const rows: HTMLElement[] = [
      el('div', 'files-branch', commitsHeaderText(branch, commitsTotal)),
    ];
    for (const c of commits) rows.push(commitRow(c));
    if (commitsMore) rows.push(showMoreRow());
    // A `Show more` that failed says so UNDER the rows it could not extend;
    // the rows themselves are still true.
    if (commitsError !== null) rows.push(ctx.stateRow(commitsError, rowIndent(0), true));
    return rows;
  }

  /**
   * ONE commit, in three lines (design, part B3): the subject, then the facts
   * that identify it (short hash, author, `+a -d`), then the two answers about
   * time — the absolute date and how long ago that was.
   *
   * WHY THREE LINES AND NOT TWO. This panel is 200..520px wide and every pixel
   * of it is a PTY resize: a row may never widen the panel, and a meta line
   * carrying six items would either clip its numbers at 200px or push. So the
   * numbers, which are the only coloured thing in the list, keep a line where
   * they always fit, and the quietest pair gets the last line.
   */
  function commitRow(c: GitCommitSummary): HTMLElement {
    const row = button('commit-row', '', () => {
      const root = ctx.currentPath;
      // A row is never a dead control. The history and the Changes answer are
      // two requests and the history can win (a root change nulls the Changes
      // answer while these rows are still on screen), so the view opens with
      // what IS known — the root it was read from — and the repository is
      // filled in when its answer lands (`noteCommitRepoRoot`). Only
      // `Open file` waits for it, and it says so.
      if (root === null) return;
      st.openCommitView(c.hash, { root, repoRoot: changes?.repoRoot ?? null });
    });
    row.setAttribute('data-k', `commit:${c.hash}`);
    row.append(el('span', 'commit-msg', c.subject));

    const meta = el('div', 'commit-meta');
    meta.append(
      el('span', 'commit-hash', c.shortHash),
      el('span', 'commit-author', c.author),
      el('span', 'files-num is-add', `+${c.add}`),
      el('span', 'files-num is-del', `-${c.del}`),
    );
    row.append(meta);
    // A timestamp git could not hand over as strict ISO arrives EMPTY, and an
    // empty line is not a fact: the row then simply has two lines instead of
    // three, rather than a blank one, an `Invalid Date` or a NaN.
    const date = absoluteDate(c.authoredAt);
    if (date !== '') {
      const when = el('div', 'commit-when');
      when.append(
        el('span', 'commit-date', date),
        el('span', '', relativeTime(c.authoredAt, ctx.now())),
      );
      // The full date and time is the tooltip, not a fourth line: it answers a
      // question the two lines above only answer roughly, and only sometimes.
      when.title = fullDateTime(c.authoredAt);
      row.append(when);
    }
    return row;
  }

  /** The quiet row that loads ten more, and nothing else about paging. */
  function showMoreRow(): HTMLElement {
    // Only an older PAGE makes this row busy: a poll tick behind it is about
    // page one and must not disable the only way to see more.
    const busy = moreFlight !== null;
    const b = button('commit-more-btn', busy ? LOADING_TEXT : SHOW_MORE_TEXT, () => {
      const root = ctx.currentPath;
      if (root === null || commits === null) return;
      fetchCommits(root, commits.length);
      // Say so NOW: the press is the moment to answer, and nothing else
      // repaints this row until the page lands.
      ctx.bump();
    });
    b.setAttribute('data-k', 'commit:more');
    b.disabled = busy;
    return b;
  }

  /** The selected state's body: one row per file of the commit that is open. */
  function openCommitRows(hash: string): HTMLElement[] {
    const asked = commitAsked();
    if (asked === null || asked.k === 'loading') {
      return [ctx.stateRow(LOADING_TEXT, rowIndent(0), false)];
    }
    if (asked.k === 'error') return [ctx.stateRow(asked.message, rowIndent(0), true)];
    const c = asked.value;
    // The SERVER's count, not the number of rows below it: a capped commit
    // draws 12 blocks and changed 15 files, and the two surfaces about one
    // commit (this panel and the view) may never state different sizes.
    const rows: HTMLElement[] = [el('div', 'files-branch', filesChangedText(c.commit.files))];
    for (const f of c.files) {
      const collapsed = st.commitFileCollapsed(hash, f.path);
      const row = button('commit-file', '', () => st.toggleCommitFile(hash, f.path));
      row.setAttribute('data-k', `cfile:${f.path}`);
      row.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      // The block it expands lives in the commit VIEW, a different region of
      // the screen — so the row names it by id instead of leaving
      // `aria-expanded` pointing at nothing.
      row.setAttribute('aria-controls', blockDomId(hash, f.path));
      row.classList.toggle('is-collapsed', collapsed);
      // The PATH is the row (a commit's files are not a tree), so it is mono
      // and it truncates at its FRONT — the file name is what identifies it.
      // The text sits in a span of its OWN so the box can stay right-to-left
      // (which is what truncates at the front) while the path itself is drawn
      // left-to-right, in the order it is stored: `.commit-fpath-t` in app.css
      // carries the why.
      const pathBox = el('span', 'commit-fpath');
      pathBox.append(el('span', 'commit-fpath-t', f.path));
      row.append(pathBox);
      // A binary file has no lines to count and says nothing rather than +0 -0.
      if (f.add !== null && f.del !== null) {
        row.append(
          el('span', 'files-num is-add', `+${f.add}`),
          el('span', 'files-num is-del', `-${f.del}`),
        );
      }
      rows.push(row);
    }
    if (c.truncated > 0) rows.push(ctx.stateRow(moreFilesText(c.truncated), rowIndent(0), false));
    return rows;
  }

  return {
    get changes() { return changes; },
    set changes(v) { changes = v; },
    get changesError() { return changesError; },
    set changesError(v) { changesError = v; },
    get changesRoot() { return changesRoot; },
    set changesRoot(v) { changesRoot = v; },
    get changesOpen() { return changesOpen; },
    fetchChanges,
    syncPoll,
    get commits() { return commits; },
    get commitsHead() { return commitsHead; },
    get commitsError() { return commitsError; },
    get pageFlight() { return pageFlight; },
    fetchCommits,
    dropCommits,
    repoKnown,
    tabAvailable,
    visibleTab,
    changeRows,
    selectedHeader,
    commitRows,
  };
}
