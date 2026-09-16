/**
 * The BODY of a file pane, and of a read-only diff pane (Nocturne part A10).
 *
 * WHERE THIS SITS. A10 made a file a PANE: the chrome around it — the card,
 * the 38px header with the name, the dirty dot and the `×` — belongs to
 * `ui/panes.ts`, exactly as a terminal's does. This module builds what is
 * inside the pane body and nothing else, so the same builder serves a file
 * beside a terminal, a file in a 2x2, and a file that is the only pane of the
 * Home tab. It replaces `ui/editor.ts` (the A6 editor column), and it carries
 * that column's four lessons forward:
 *
 * 1. THE BODY IS NOT REBUILT PER KEYSTROKE. The textarea holds the caret, the
 *    selection and the scroll position; a rebuild on `input` throws all three
 *    away. Typing updates the gutter in place and asks the chrome for a
 *    redraw only when the DIRTY flag actually FLIPS.
 * 2. A FILE WITH NO TEXT TO SHOW IS A NOTE, NOT AN EMPTY FIELD — and it gets
 *    no Save, because there would be nothing to write. Since part B2 that is
 *    EVERY file opened from the Files panel: the paths are real and the app
 *    cannot read a file until part B4, which is what the note says. The OTHER
 *    branch (a mock commit path, opened from the commit view) still draws
 *    `ui/files-mock.ts` text, so it keeps its own quiet line saying so.
 * 3. CODE SURFACES DRAW PLAIN GLYPHS (`font-variant-ligatures: none`, one
 *    shared rule in app.css): the terminal in the pane beside this one renders
 *    none, and `==` must not be readable as `===`.
 *
 * No xterm, no state subscription: the pane owns the lifecycle, this module
 * owns the body. That keeps it drivable under `node --test`.
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { diffBody } from './commit-view.ts';
import { gutterText, saveLabel } from './editor-model.ts';
import { mockFileContent, saveMockFile } from './files-mock.ts';

/**
 * What a file pane says instead of a REAL file's text (part B2, §5). Every
 * file opened from the Files panel takes this branch: the path is absolute,
 * the app cannot read a file until part B4, and that is exactly what this
 * says — not "coming soon", which is a promise with no date, and no longer
 * "there is no example content", which promised example content for a file
 * that is now real. It dies in B4 with the module that reads files.
 */
const CANNOT_READ = 'The app cannot read this file yet.';

/**
 * PLACEHOLDER MARKER — DELETE WITH THE MOCK (part B4). The OTHER branch is
 * still fiction: a commit view's `Open file` hands over a mock commit path,
 * `ui/files-mock.ts` has text for it, and the pane then shows a textarea with
 * a Save that writes into that same map. A field full of invented source with
 * nothing saying so is the one thing placeholder data must not do, so the
 * line the real-file branch no longer needs is still owed here. One function,
 * one call site.
 */
function placeholderNote(): HTMLElement {
  return el('span', 'pane-fnote', 'Example content until the app reads your files.');
}

/** One pane body: its root node, how to hand it the keyboard, how to refresh it. */
export interface PaneBody {
  root: HTMLElement;
  /** Land the keyboard in the body (the text field of a file). */
  focus(): void;
  /** Redraw the parts that are not the text itself (the Save button). */
  update(): void;
}

/**
 * The body of a FILE pane: the code area (line numbers + the text) on the
 * terminal ground, and one thin bar under it carrying the honesty line and
 * Save — the same strip the session pane puts its status items in, so a file
 * and a terminal are the same object with different contents.
 *
 * `onDirtyFlip` is called when the file goes from clean to unsaved and back;
 * the pane header draws the dot, and it is the only thing a keystroke may
 * cost beyond the gutter.
 */
export function filePaneBody(path: string, onDirtyFlip: () => void): PaneBody {
  const id = st.editorFileId(path);
  const root = el('div', 'pane-file');
  const bar = el('div', 'pane-fbar');
  let gutter: HTMLElement | null = null;
  let textarea: HTMLTextAreaElement | null = null;
  let save: HTMLButtonElement | null = null;

  const text = st.editText(id) ?? mockFileContent(path);
  if (text === null) {
    // Nothing to edit: one sentence, no field, no numbers beside it — and no
    // Save, which would write a sentence into a file. Part B4 replaces this
    // whole branch with a real read error.
    root.append(el('p', 'pane-fempty', CANNOT_READ));
  } else {
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
    gutter = g;
    textarea = ta;
    code.append(g, ta);
    root.append(code);

    const btn = button('pane-save', saveLabel(st.editorDirty(id)), () => saveNow());
    btn.setAttribute('data-k', `fsave:${path}`);
    save = btn;
    bar.append(placeholderNote(), el('span', 'pane-gap'), btn);
    update();
  }
  // A bar with nothing in it is a strip of chrome that says nothing: the REAL
  // file has no Save to put there and nothing to warn about.
  if (bar.children.length > 0) root.append(bar);

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

  function saveNow(): void {
    const written = st.saveEdit(id);
    if (written === null) return; // nothing to write; `Saved` already says so
    // A10 writes into the mock map and nowhere else. Part B4 replaces this ONE
    // line with the backend write (and `ui/files-mock.ts` goes with it).
    saveMockFile(path, written);
    // `saveEdit` notified, so the header and the tab chip are already being
    // redrawn; keep the caret where the user left it.
    update();
    textarea?.focus();
  }

  function update(): void {
    if (save === null) return;
    const dirty = st.editorDirty(id);
    save.textContent = saveLabel(dirty);
    save.classList.toggle('is-dirty', dirty);
    // A clean file has nothing to write: the button says `Saved` and is a real
    // no-op rather than a control that pretends to do something.
    save.disabled = !dirty;
  }

  function focus(): void {
    textarea?.focus();
  }

  return { root, focus, update };
}

/**
 * The body of a DIFF pane: the A6 unified diff, read-only. No field, no Save
 * and no dirty state — the changes in a commit are not something to type into.
 * `diffBody` is the commit view's own renderer, so the pane and the screen it
 * came from can never disagree about what a commit changed.
 */
export function diffPaneBody(hash: string, path: string): PaneBody {
  const root = el('div', 'pane-diff');
  root.append(diffBody(hash, path));
  return {
    root,
    // The keyboard lands on the header chip instead (ui/panes.ts): there is
    // nothing in a read-only body to type into.
    focus: () => {},
    update: () => {},
  };
}
