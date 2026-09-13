/**
 * Editor column (Nocturne part A6) — open files beside the panes.
 *
 * PLACE IN THE SHELL. A flex sibling of the pane grid, BEFORE it (v3's own DOM
 * order: Files panel, commit view, editor, panes), so the panes keep the right
 * edge of the window. While it has tabs the grid takes `flex: 0 0 46%` — a
 * real layout change, which means every pane's ResizeObserver fires and the
 * existing debounced fit -> ws `resize` chain tells each PTY its new cols and
 * rows. That seam is the only one; nothing here talks to a terminal.
 *
 * WHAT IS REAL AND WHAT IS NOT. Nothing yet: the text comes from
 * `ui/files-mock.ts` and Save writes back into that same map — no file is read
 * from disk and none is written to it until part B4. One quiet line above the
 * body says so, from ONE function with ONE call site.
 *
 * WHY THE BODY IS NOT REBUILT ON EVERY KEYSTROKE. The textarea is a real
 * `<textarea>` holding the caret, the selection and the scroll position; a
 * rebuild per input event would throw all three away. So typing updates the
 * gutter and (only when the DIRTY flag actually flips) the tab strip in place,
 * and the body is rebuilt exactly when the ACTIVE TAB changes.
 *
 * KEYBOARD. Tabs and their close buttons are buttons; the text is a textarea,
 * which `ui/keys.ts` already counts as an editable target — so the window
 * activation refocus never steals the keyboard out of it, and the app's
 * Ctrl+Alt chords still work from inside it (main.ts handles them on window,
 * and the textarea sends none of them anywhere).
 */
import * as st from '../state.ts';
import { el, button } from './util.ts';
import { diffBody } from './commit-view.ts';
import { gutterText, saveLabel, tabKind, type EditorTab } from './editor-model.ts';
import { NO_EXAMPLE_CONTENT, mockFileContent, saveMockFile } from './files-mock.ts';

export interface Editor {
  render(): void;
  /**
   * Hand the keyboard to the body of the active tab — the textarea of a file,
   * the tab chip of a read-only diff (its body holds nothing focusable). Used
   * by the commit view's `Open file` / `Changes`: the button that was clicked
   * goes away with the screen it stood on.
   */
  focusBody(): void;
}

export function initEditor(host: HTMLElement): Editor {
  const root = el('section', 'editor-view');
  const card = el('div', 'editor-card');
  const tabRow = el('div', 'editor-tabs');
  tabRow.setAttribute('role', 'group');
  tabRow.setAttribute('aria-label', 'open files');
  const bodyWrap = el('div', 'editor-body');
  card.append(tabRow, placeholderNote(), bodyWrap);
  root.append(card);
  host.append(root);

  /** Live parts of a FILE body, so typing can update them without a rebuild. */
  let gutter: HTMLElement | null = null;
  let textarea: HTMLTextAreaElement | null = null;
  let lastTabsSig = '';
  let lastBodySig = '';

  function tabsSig(): string {
    const s = st.state.editor;
    return s.tabs
      .map((t) => `${t.id}~${t.label}~${t.id === s.active ? 1 : 0}~${st.editorDirty(t.id) ? 1 : 0}`)
      .join('|');
  }

  function render(): void {
    if (!st.editorVisible()) {
      // Nothing is LEFT drawn for a hidden column: main.ts hides the host, and
      // a stale tab strip behind it would flash on the way back (and a stale
      // textarea would keep an edit alive in the DOM that state.ts has
      // already dropped).
      if (lastTabsSig !== '' || lastBodySig !== '') {
        tabRow.replaceChildren();
        rebuildBody(null);
      }
      lastTabsSig = '';
      lastBodySig = '';
      return;
    }
    const ts = tabsSig();
    if (ts !== lastTabsSig) {
      lastTabsSig = ts;
      rebuildTabs();
    }
    const active = st.activeEditorTab();
    const bs = active === null ? '' : active.id;
    if (bs !== lastBodySig) {
      lastBodySig = bs;
      rebuildBody(active);
    }
  }

  /**
   * PLACEHOLDER MARKER — DELETE WITH THE MOCK (part B4). The editor shows text
   * that was never read from the user's disk, and Save never reaches it. One
   * function, one call site.
   */
  function placeholderNote(): HTMLElement {
    return el('p', 'editor-note', 'Example content until the editor reads your files.');
  }

  // ---- the 38px tab strip ---------------------------------------------------

  function rebuildTabs(): void {
    const focusKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.getAttribute('data-k')
        : null;
    const active = st.activeEditorTab();
    const nodes: HTMLElement[] = [];

    for (const t of st.state.editor.tabs) {
      const on = t.id === active?.id;
      const tab = el('div', 'editor-tab');
      tab.classList.toggle('is-on', on);

      const pick = button('editor-tab-pick', t.label, () => st.setEditorActive(t.id));
      pick.setAttribute('data-k', `etab:${t.id}`);
      pick.setAttribute('aria-pressed', on ? 'true' : 'false');
      tab.append(pick);

      if (st.editorDirty(t.id)) {
        const dot = el('span', 'editor-dirty');
        dot.setAttribute('aria-hidden', 'true');
        // The dot is decoration; the state is in the button's own name, so a
        // screen reader hears it instead of a shape it cannot see.
        pick.setAttribute('aria-label', `${t.label}, unsaved`);
        tab.append(dot);
      }

      // `×` is the app's existing close mark (drawer, dialogs, tab strip); the
      // accessible name is the words beside it.
      const x = button('editor-x', '×');
      x.setAttribute('aria-label', `Close ${t.label}`);
      x.setAttribute('data-k', `eclose:${t.id}`);
      x.addEventListener('click', (e) => {
        // The whole chip is a picker; the × must not raise the tab it closes.
        e.stopPropagation();
        st.closeEditorTab(t.id);
      });
      tab.append(x);
      nodes.push(tab);
    }

    nodes.push(el('span', 'drawer-gap'));

    if (active !== null && tabKind(active.id) === 'diff') {
      nodes.push(el('span', 'editor-meta', `Changes in ${active.hash ?? ''}`));
    } else if (active !== null) {
      nodes.push(el('span', 'editor-path', active.path));
      // A file the mock has no text for renders a note instead of a field:
      // there is no body to write back, so there is no Save button either.
      const editable = st.editText(active.id) !== undefined || mockFileContent(active.path) !== null;
      const dirty = st.editorDirty(active.id);
      if (editable) {
        const save = button('editor-save', saveLabel(dirty), () => saveActive());
        save.classList.toggle('is-dirty', dirty);
        save.setAttribute('data-k', 'esave');
        // A clean file has nothing to write: the button says `Saved` and is a
        // real no-op rather than a control that pretends to do something.
        save.disabled = !dirty;
        nodes.push(save);
      }
    }

    tabRow.replaceChildren(...nodes);
    if (focusKey !== null) {
      tabRow.querySelector<HTMLElement>(`[data-k="${CSS.escape(focusKey)}"]`)?.focus();
    }
  }

  // ---- the body: a file, or a read-only diff --------------------------------

  function rebuildBody(active: EditorTab | null): void {
    gutter = null;
    textarea = null;
    if (active === null) {
      bodyWrap.replaceChildren();
      return;
    }
    if (tabKind(active.id) === 'diff') {
      bodyWrap.replaceChildren(diffBody(active.hash ?? '', active.path));
      return;
    }
    const text = st.editText(active.id) ?? mockFileContent(active.path);
    if (text === null) {
      // No example text for this path, so there is nothing to edit: one note,
      // no field, no gutter — and `rebuildTabs` leaves out Save for the same
      // reason. Part B4 replaces the whole branch with a real read error.
      bodyWrap.replaceChildren(el('p', 'editor-empty', NO_EXAMPLE_CONTENT));
      return;
    }
    gutter = el('div', 'editor-gutter', gutterText(text));
    gutter.setAttribute('aria-hidden', 'true');
    const ta = el('textarea', 'editor-text');
    ta.value = text;
    ta.spellcheck = false;
    ta.setAttribute('data-k', 'etext');
    ta.setAttribute('aria-label', `${active.label}, editable text`);
    ta.addEventListener('input', () => onEdit(active.id, ta.value));
    // The gutter has no scrollbar of its own; it follows the text it numbers.
    ta.addEventListener('scroll', () => {
      if (gutter !== null) gutter.scrollTop = ta.scrollTop;
    });
    textarea = ta;
    bodyWrap.replaceChildren(gutter, ta);
  }

  function focusBody(): void {
    if (textarea !== null) {
      textarea.focus();
      return;
    }
    const active = st.activeEditorTab();
    if (active === null) return;
    tabRow.querySelector<HTMLElement>(`[data-k="${CSS.escape(`etab:${active.id}`)}"]`)?.focus();
  }

  function onEdit(id: string, value: string): void {
    const wasDirty = st.editorDirty(id);
    st.setEdit(id, value);
    if (gutter !== null) gutter.textContent = gutterText(value);
    // Only the FIRST keystroke changes anything else on screen (the amber dot
    // and the Save button); after that the strip is already right.
    if (!wasDirty) {
      lastTabsSig = tabsSig();
      rebuildTabs();
    }
  }

  function saveActive(): void {
    const active = st.activeEditorTab();
    if (active === null) return;
    const text = st.saveEdit(active.id);
    if (text === null) return; // nothing to write; `Saved` already says so
    // A6 writes into the mock map and nowhere else. Part B4 replaces this ONE
    // line with the backend write (and `ui/files-mock.ts` goes with it).
    saveMockFile(active.path, text);
    // `saveEdit` notified, so the strip is already being rebuilt; keep the
    // caret where the user left it by leaving the body alone.
    if (textarea !== null) textarea.focus();
  }

  return { render, focusBody };
}
