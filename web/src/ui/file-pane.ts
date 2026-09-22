/**
 * The BODY of a file pane, and of a read-only diff pane (Nocturne part A10,
 * made real by part B4).
 *
 * WHERE THIS SITS. A10 made a file a PANE: the chrome around it — the card,
 * the 38px header with the name, the dirty dot and the `×` — belongs to
 * `ui/panes.ts`, exactly as a terminal's does. This module builds what is
 * inside the pane body and nothing else, so the same builder serves a file
 * beside a terminal, a file in a 2x2, and a file that is the only pane of the
 * Home tab. It replaces `ui/editor.ts` (the A6 editor column), and it carries
 * that column's lessons forward:
 *
 * 1. THE BODY IS NOT REBUILT PER KEYSTROKE. The textarea holds the caret, the
 *    selection and the scroll position; a rebuild on `input` throws all three
 *    away. Typing updates the gutter in place and asks the chrome for a
 *    redraw only when the DIRTY flag actually FLIPS.
 * 2. A FILE WITH NO TEXT TO SHOW IS A SENTENCE, NOT AN EMPTY FIELD — and it
 *    gets no Save, because there would be nothing to write. Since B4 that
 *    sentence is the SERVER's own (413 too large, 415 not text, 403 no
 *    permission, 404 gone), rendered verbatim, in danger ink for a refusal and
 *    in the quiet ink for a file that is simply not there.
 * 3. CODE SURFACES DRAW PLAIN GLYPHS (`font-variant-ligatures: none`, one
 *    shared rule in app.css): the terminal in the pane beside this one renders
 *    none, and `==` must not be readable as `===`.
 *
 * WHAT PART B4 ADDED, and the three rules behind it:
 *
 * - IT READS ON BUILD, through the gateway `ui/editor-store.ts` owns. No
 *   `../api.ts` import here: that seam is what keeps this module drivable
 *   under `node --test` against a plain object.
 * - THE UNSAVED TEXT WINS OVER DISK, always. A body built for a file that
 *   already has text in `state.edits` (the second pane of the same file, a
 *   tab raised again, a persisted tab) still reads ONCE — for the stamp a
 *   save needs — and then shows what the user typed, not what is on disk.
 * - A SAVE CARRIES THE STAMP IT READ (user decision D4). The server refuses a
 *   write onto a file that changed since (409) or vanished (404), and the pane
 *   then offers the two honest answers — `Overwrite` (my text wins) and
 *   `Load from disk` (my changes go) — in its own bottom bar. The text stays
 *   unsaved until a write actually lands.
 *
 * DESIGN (part B4, the direction in one sentence): everything new lives in the
 * 30px hairline strip the pane already had — the server's sentence in danger
 * ink where the old honesty line sat, two quiet outline buttons beside it,
 * Save unchanged on the right. No banner, no card, no colour that is not
 * already a token: a file that changed under you is a line in your statusline,
 * the way a terminal would tell you.
 *
 * No xterm, no state subscription: the pane owns the lifecycle, this module
 * owns the body.
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { diffBox } from './commit-view.ts';
import { fetchDiff, type Asked } from './commit-store.ts';
import {
  SAVING_TEXT,
  clampCaret,
  gutterText,
  offersChoice,
  saveLabel,
  sentenceTone,
  statusOf,
} from './editor-model.ts';
import { LOADING_TEXT, messageOf } from './fs-model.ts';
import {
  editorRead,
  editorWrite,
  registerBody,
  unregisterBody,
  type FileFollower,
} from './editor-store.ts';
import type {
  FsEol,
  FsWriteRequest,
  GitCommitDiffResponse,
} from '../../../shared/protocol.ts';

/** One pane body: its root node, how to hand it the keyboard, how to refresh it. */
export interface PaneBody {
  root: HTMLElement;
  /** Land the keyboard in the body (the text field of a file). */
  focus(): void;
  /** Redraw the parts that are not the text itself (the Save button). */
  update(): void;
  /** Give up the disk follow and anything else this body registered. */
  dispose(): void;
}

/**
 * The body of a FILE pane: the code area (line numbers + the text) on the
 * terminal ground, and one thin bar under it carrying the state of the last
 * save and Save itself — the same strip the session pane puts its status items
 * in, so a file and a terminal are the same object with different contents.
 *
 * `onDirtyFlip` is called when the file goes from clean to unsaved and back;
 * the pane header draws the dot, and it is the only thing a keystroke may
 * cost beyond the gutter.
 */
export function filePaneBody(path: string, onDirtyFlip: () => void): PaneBody {
  const id = st.editorFileId(path);
  const root = el('div', 'pane-file');
  const bar = el('div', 'pane-fbar');

  // What this body knows about the bytes on disk. `stamp` is OPAQUE (the
  // server's hash) and is the whole of the concurrency story: it is sent back
  // with a save and with every follow read, and it is null exactly while this
  // body holds no file — before the first answer, and after a refusal.
  let stamp: string | null = null;
  let eol: FsEol = 'lf';
  let bom = false;
  /** Requests of this body still out (the poll skips a body with any). */
  let outstanding = 0;
  /** A write is out: Save says `Saving…` and answers nothing until it lands. */
  let saving = false;
  /**
   * The request GENERATION of this body. Every act that changes what the body
   * holds — a save, `Load from disk`, a follow read — bumps it, and a follow
   * answer that comes back into a LATER generation is dropped. A read that
   * left before a save landed carries the PRE-save text and the PRE-save
   * stamp: taking either would put stale bytes on screen under a `Saved`
   * label, and the next save would then send an `expect` the server already
   * moved past.
   */
  let gen = 0;

  // The nodes that exist only once there is text: a body showing a sentence
  // has none of them, and every path here asks before it touches one.
  let gutter: HTMLElement | null = null;
  let textarea: HTMLTextAreaElement | null = null;
  let save: HTMLButtonElement | null = null;

  /** The last refusal, and whether it left the user a choice (D4). */
  let barMessage: string | null = null;
  let conflict: string | null = null;

  const follower: FileFollower = {
    root,
    dirty: () => st.editorDirty(id),
    inFlight: () => outstanding > 0,
    stamp: () => stamp,
    follow: () => followNow(),
  };
  registerBody(follower);

  // `Loading…` in the quiet ink, in the slot the sentence will take if the
  // read is refused — never a spinner, never a skeleton of a file nobody has
  // read yet.
  root.append(el('p', 'pane-fempty', LOADING_TEXT));
  outstanding += 1;
  editorRead(path)
    .then((res) => {
      outstanding -= 1;
      stamp = res.stamp;
      if (res.changed) {
        eol = res.eol;
        bom = res.bom;
      }
      const unsaved = st.editText(id);
      if (!res.changed && unsaved === undefined) {
        // A first read sends no `if`, so an answer with no text in it is a
        // server that did not answer the question that was asked. Say the one
        // honest thing rather than draw an empty file.
        showSentence(null);
        return;
      }
      buildField(unsaved ?? (res.changed ? res.text : ''));
    })
    .catch((err: unknown) => {
      outstanding -= 1;
      const unsaved = st.editText(id);
      if (unsaved !== undefined) {
        // THERE IS WORK TO SHOW, so the sentence may not take the field away:
        // this is the last body of a file that was typed into and then went
        // (deleted on disk, and the pane rebuilt by a move or a second pane).
        // The unsaved text is what the user has; the refusal goes in the bar
        // with `Overwrite` — a write with no `expect`, which recreates the
        // file — exactly as a 404 on save does. `Load from disk` retries.
        stamp = null;
        conflict = messageOf(err);
        buildField(unsaved);
        return;
      }
      showSentence(err);
    });

  /**
   * The sentence branch: the server's own line, and nothing else — no field,
   * no numbers, no Save, no bar. `stamp` goes back to null, so the disk follow
   * leaves this body alone instead of re-asking a refused question every 5 s.
   */
  function showSentence(err: unknown): void {
    stamp = null;
    gutter = null;
    textarea = null;
    save = null;
    barMessage = null;
    conflict = null;
    const line = el('p', 'pane-fempty', messageOf(err));
    // Danger ink for a refusal; the quiet ink for a file that is simply not
    // there any more, which is a fact and not a failure.
    if (sentenceTone(statusOf(err)) === 'bad') line.classList.add('is-bad');
    root.replaceChildren(line);
  }

  /** The field, its numbers and the bar under them — the READY state. */
  function buildField(text: string): void {
    const code = el('div', 'pane-code');
    const g = el('div', 'pane-gutter', gutterText(text));
    g.setAttribute('aria-hidden', 'true');
    const ta = el('textarea', 'pane-text');
    ta.value = text;
    ta.spellcheck = false;
    ta.setAttribute('data-k', `ftext:${path}`);
    ta.setAttribute('aria-label', `${path}, editable text`);
    ta.addEventListener('input', () => onEdit(ta.value));
    // The gutter has no scrollbar of its own; it follows the text it numbers.
    ta.addEventListener('scroll', () => {
      if (gutter !== null) gutter.scrollTop = ta.scrollTop;
    });
    // Ctrl+S saves THIS file, and only while the keyboard is in its text
    // (orchestrator default, 2026-09-22). The chord is not taken anywhere
    // else: a terminal keeps it, so a program running in a pane beside this
    // one still receives its XOFF.
    ta.addEventListener('keydown', (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      if (e.getModifierState('AltGraph')) return;
      if (e.key !== 's' && e.key !== 'S') return;
      // Without this the browser opens its own "save this page" dialog.
      e.preventDefault();
      saveNow(true);
    });
    gutter = g;
    textarea = ta;
    code.append(g, ta);

    const btn = button('pane-save', saveLabel(st.editorDirty(id)), () => saveNow(true));
    btn.setAttribute('data-k', `fsave:${path}`);
    btn.title = 'Save this file (ctrl+s)';
    save = btn;
    root.replaceChildren(code, bar);
    update();
    drawBar();
  }

  function onEdit(value: string): void {
    const wasDirty = st.editorDirty(id);
    st.setEdit(id, value);
    if (gutter !== null) gutter.textContent = gutterText(value);
    // Only the FIRST keystroke changes anything else on screen (the amber dot
    // on this header and on the tab chip, and the Save button); after that
    // everything already says "unsaved".
    if (!wasDirty) {
      update();
      onDirtyFlip();
    }
  }

  /**
   * Write the unsaved text back. `withExpect` is the whole of D4: a normal
   * save carries the stamp it read (and is refused when the file changed),
   * `Overwrite` carries none and lands regardless — which is also what
   * recreates a file that was deleted under the tab.
   */
  function saveNow(withExpect: boolean): void {
    if (save === null || saving) return;
    const text = st.editText(id);
    if (text === undefined) return; // nothing to write; `Saved` already says so
    saving = true;
    gen += 1; // a follow answer still out is about the version being replaced
    outstanding += 1;
    barMessage = null;
    conflict = null;
    // READ FIRST, THEN DISABLE. Whoever had the keyboard when the write left
    // gets it back when it lands — and disabling a focused button drops the
    // focus on the floor in a browser, so asking afterwards would always
    // answer "nobody" and leave the keyboard nowhere (the 2026-09-08 lesson).
    // A save that stole focus back from another pane would be worse than one
    // that says nothing, which is why it is this narrow.
    const held =
      document.activeElement === textarea || document.activeElement === save;
    // The control that was pressed is the control that reports.
    save.textContent = SAVING_TEXT;
    save.disabled = true;
    drawBar();
    const body: FsWriteRequest = { path, text, eol, bom };
    if (withExpect && stamp !== null) body.expect = stamp;
    editorWrite(body)
      .then((res) => {
        outstanding -= 1;
        saving = false;
        stamp = res.stamp;
        // FORGET ONLY THE TEXT THAT WAS WRITTEN. The field stays enabled while
        // a write is out, so `state.edits` may by now hold keystrokes NEWER
        // than the bytes that just landed; dropping that entry would mark them
        // clean — no dot, `Saved`, no question at any door, and the next follow
        // tick would overwrite the field from disk. Then the entry goes (and
        // notifies, so the pane header's dot and the tab chip stop saying
        // unsaved); otherwise the tab stays unsaved and Save reads `Save`.
        if (st.editText(id) === text) st.saveEdit(id);
        update();
        drawBar();
        if (held) textarea?.focus();
      })
      .catch((err: unknown) => {
        outstanding -= 1;
        saving = false;
        const message = messageOf(err);
        // 409 / 404 leave a CHOICE; every other refusal is a fact. Either way
        // the text stays unsaved and Save stays pressable.
        if (offersChoice(statusOf(err))) conflict = message;
        else barMessage = message;
        update();
        drawBar();
        // Disabling the pressed button dropped the keyboard on the floor; the
        // text is where the work is, and the two answers are one Tab away.
        if (held) textarea?.focus();
      });
  }

  /** `Load from disk`: the bytes on disk win, and the typed text goes. */
  function loadFromDisk(): void {
    if (textarea === null || outstanding > 0) return;
    gen += 1; // same reason as a save: what this body holds is being replaced
    outstanding += 1;
    editorRead(path)
      .then((res) => {
        outstanding -= 1;
        if (!res.changed) {
          // No text in the answer: nothing to load, and the typed text must
          // not be dropped for a question that was not answered.
          conflict = messageOf(null);
          drawBar();
          return;
        }
        stamp = res.stamp;
        eol = res.eol;
        bom = res.bom;
        // The user chose disk: the unsaved entry goes, which is what makes the
        // tab clean again (and redraws the dot).
        st.saveEdit(id);
        setText(res.text);
        conflict = null;
        barMessage = null;
        update();
        drawBar();
        textarea?.focus();
      })
      .catch((err: unknown) => {
        outstanding -= 1;
        // The read failed, so there is nothing to replace the text WITH. The
        // field and the typed text stay, the reason is stated, and `Overwrite`
        // is still there — which is the answer for a file that is gone.
        conflict = messageOf(err);
        drawBar();
      });
  }

  /**
   * One follow tick for this body (`ui/editor-store.ts` decides WHEN: visible
   * document, attached body, clean, nothing out, a stamp in hand).
   */
  function followNow(): void {
    gen += 1;
    const mine = gen;
    // The stamp this question was ASKED with. A save that landed while it was
    // out moved the body past it, and the answer is then about bytes nobody
    // is looking at any more.
    const sent = stamp;
    outstanding += 1;
    editorRead(path, stamp ?? undefined)
      .then((res) => {
        outstanding -= 1;
        // A save or a `Load from disk` that started after this read — or that
        // landed while it was out — owns the body now: neither its text nor
        // its (older) stamp may replace what is there.
        if (gen !== mine || stamp !== sent) return;
        if (res.changed === false) {
          // Still the same bytes: one small answer, no body, no caret touched.
          stamp = res.stamp;
          return;
        }
        // The user may have typed while the answer was out; unsaved text is
        // never overwritten from disk (D3), and the next tick will skip this
        // body for as long as it stays dirty.
        if (st.editorDirty(id) || textarea === null) return;
        stamp = res.stamp;
        eol = res.eol;
        bom = res.bom;
        setText(res.text);
      })
      .catch((err: unknown) => {
        outstanding -= 1;
        // Stale, exactly as above: a refusal to a question this body has
        // already moved past says nothing about what it holds now.
        if (gen !== mine || stamp !== sent) return;
        // TYPED TEXT KEEPS ITS FIELD. `state.edits` still holds the work, so
        // taking the textarea (and Save) away would leave the dot on with no
        // text on screen and no way to write it. The file being unreadable is
        // the next save's news to deliver.
        if (st.editorDirty(id)) return;
        // The file became unreadable under an open tab (deleted, or its
        // permissions changed): the sentence replaces the field and the TAB
        // STAYS — closing it is the user's move, not the app's.
        showSentence(err);
      });
  }

  /**
   * Put new bytes in the field without losing the reader's place: the caret
   * goes to `min(old, new length)` and the scroll offset is kept.
   */
  function setText(next: string): void {
    const ta = textarea;
    if (ta === null) return;
    const start = clampCaret(ta.selectionStart ?? 0, next.length);
    const end = clampCaret(ta.selectionEnd ?? start, next.length);
    const top = ta.scrollTop ?? 0;
    ta.value = next;
    if (gutter !== null) {
      gutter.textContent = gutterText(next);
      gutter.scrollTop = top;
    }
    ta.scrollTop = top;
    ta.setSelectionRange?.(start, end);
  }

  /**
   * The bar: what the last save has to say on the left, Save on the right.
   *
   * THE CONFLICT BAR IS THIS BAR (part B4, §7) — not a banner over the text
   * and not a dialog: a file that changed under you is a line in the pane's
   * own statusline, with the two answers next to it.
   */
  function drawBar(): void {
    if (save === null) return;
    const left: HTMLElement[] = [];
    if (conflict !== null) {
      left.push(saidOutLoud(conflict));
      const over = button('pane-fact', 'Overwrite', () => {
        // My text wins — the same write with no stamp to check against.
        saveNow(false);
        textarea?.focus();
      });
      over.title = 'Save this text over the file on disk';
      const load = button('pane-fact', 'Load from disk', () => loadFromDisk());
      load.title = 'Replace this text with the file on disk';
      left.push(over, load);
    } else if (barMessage !== null) {
      left.push(saidOutLoud(barMessage));
    }
    bar.replaceChildren(...left, el('span', 'pane-gap'), save);
  }

  /**
   * The bar's sentence. `role=status` because it appears under the user's
   * hands after they pressed Save: a refusal nobody can see is a refusal
   * nobody knows about (the boot overlay's own idiom).
   */
  function saidOutLoud(text: string): HTMLElement {
    const line = el('span', 'pane-fmsg', text);
    line.setAttribute('role', 'status');
    // A narrow pane elides the sentence after `since…`; the tooltip carries
    // the whole of it (seen in the B4 verify run at a 480 px pane).
    line.title = text;
    return line;
  }

  function update(): void {
    if (save === null) return;
    const dirty = st.editorDirty(id);
    if (saving) {
      save.textContent = SAVING_TEXT;
      save.disabled = true;
      return;
    }
    save.textContent = saveLabel(dirty);
    save.classList.toggle('is-dirty', dirty);
    // A clean file has nothing to write: the button says `Saved` and is a real
    // no-op rather than a control that pretends to do something.
    save.disabled = !dirty;
  }

  function focus(): void {
    textarea?.focus();
  }

  function dispose(): void {
    // Without this a pane that was closed (or converted to a terminal) would
    // keep asking the backend about a file nobody has open.
    unregisterBody(follower);
  }

  return { root, focus, update, dispose };
}

/**
 * The body of a DIFF pane: the unified diff of one file in one commit,
 * read-only. No field, no Save and no dirty state — the changes in a commit
 * are not something to type into. `diffBox` is the commit view's own renderer,
 * so the pane and the screen it came from can never disagree about what a
 * commit changed.
 *
 * IT HOLDS ITS OWN ANSWER (part B3). A commit is immutable and this tab
 * outlives the view it was opened from, so it asks once, through the injected
 * gateway `ui/commit-store.ts` owns, and paints ITS OWN NODE when the answer
 * lands. No notification: a diff arriving may not put the pane grid through a
 * render — that is the path that rebuilds terminals nobody asked to rebuild.
 *
 * `root` is the folder the diff is read from, carried on the tab itself
 * (`EditorTab`), because a pane may never guess where a repository is.
 */
export function diffPaneBody(root: string, hash: string, path: string): PaneBody {
  const host = el('div', 'pane-diff');
  let asked: Asked<GitCommitDiffResponse> = { k: 'loading' };
  const draw = (): void => {
    host.replaceChildren(diffBox(asked));
  };
  draw();
  fetchDiff(root, hash, path)
    .then((res) => {
      asked = { k: 'ready', value: res };
      draw();
    })
    .catch((err: unknown) => {
      asked = { k: 'error', message: messageOf(err) };
      draw();
    });
  return {
    root: host,
    // The keyboard lands on the header chip instead (ui/panes.ts): there is
    // nothing in a read-only body to type into.
    focus: () => {},
    update: () => {},
    // An immutable commit has nothing to follow and nothing to give up.
    dispose: () => {},
  };
}
