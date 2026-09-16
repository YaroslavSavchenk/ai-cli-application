/**
 * `web/src/ui/drop-dialog.ts` — the drop dialog (Nocturne A9, `fd-`) driven
 * through the REAL module on the DOM double in `tests/fake-dom.ts`, plus the
 * source-level guards its stylesheet block needs.
 *
 * WHY THIS FILE EXISTS. The rules behind the words are pinned DOM-free next
 * door (`tests/ui-drop-model.test.ts`) and the drag that opens this card is
 * brief 2's (`tests/ui-filedrop.test.ts`). What sits between them is the card
 * itself, and every one of its promises is a DOM fact a regex cannot see:
 *
 *   1. it opens on the question ONLY when something clashes, and otherwise is
 *      already copying;
 *   2. each of the three answers leads to the outcomes `planResults` plans for
 *      it, row by row, and then to one result sentence;
 *   3. Escape and the `×` are Skip while it asks, Close when it is over, and
 *      NOTHING while it copies — a copy in flight is not cancelled by a key;
 *   4. every state carries an honesty line, each saying what THAT state is
 *      pretending — example conflicts while it asks, nothing written while it
 *      copies — because none of it is real until part B10;
 *   5. the keyboard: the safe answer holds it, the busy card still holds it
 *      (no focus behind an aria-modal scrim), and the opener gets it back;
 *   6. `.modal-scrim` stays on the scrim — `ui/keys.ts` finds an open dialog
 *      by that class, and a dialog that dropped it would keep its looks and
 *      silently break the focus handover.
 *
 * Plus the block guards every Nocturne section carries: class parity for
 * `fd-` (no class without a rule, no rule without a setter), tokens only, no
 * colour literal, and no path, no byte count and no decorative dash in
 * anything the card renders.
 *
 * `../log.ts` is stubbed (it would open a real client-log channel); the REAL
 * `ui/util.ts` and `ui/drop-model.ts` take part. Layout, hit-testing and
 * screen-reader output stay manual (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { byClass, installDom, dispatch, type FakeElement } from './fake-dom.ts';
import { APP_CSS, declaredTokens, frontendFiles, mySections, stripComments, usedTokens } from './tokens-helpers.ts';
import { MAX_ITEM_BYTES, type DropItem } from '../web/src/ui/drop-model.ts';

const dom = installDom();

// ===========================================================================
// Harness
// ===========================================================================

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL ?? '').endsWith('/web/src/ui/drop-dialog.ts') && specifier === '../log.ts') {
      return { url: 'fd-stub:log', shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'fd-stub:log') {
      return {
        format: 'module',
        source: `const noop = () => {};
          export const log = { debug: noop, info: noop, warn: noop, error: noop, hold: noop, resume: noop };
          export function formatError(e) { return String(e); }`,
        shortCircuit: true,
      };
    }
    return nextLoad(url, context);
  },
});

interface DialogModule {
  openDropDialog(req: {
    dest: string;
    items: DropItem[];
    listing: readonly string[];
    returnFocus: unknown;
  }): void;
  isDropDialogOpen(): boolean;
  dropDialogEscape(): void;
}

const FD = (await import(new URL('../web/src/ui/drop-dialog.ts', import.meta.url).href)) as DialogModule;

/** The shell's dialog host: the module appends its scrim to this, like every dialog. */
const modalHost = dom.doc.createElement('div');
modalHost.className = 'modal-host';
dom.body.append(modalHost);

/** The element a drop came from, which must get the keyboard back. */
const opener = dom.doc.createElement('button');
dom.body.append(opener);

const file = (name: string, bytes = 1024): DropItem => ({ name, dir: false, bytes });
const folder = (name: string): DropItem => ({ name, dir: true, bytes: null });

/** The open dialog's scrim and card, or a failed assertion. */
function card(): { scrim: FakeElement; modal: FakeElement } {
  const scrim = modalHost.children[modalHost.children.length - 1] as FakeElement;
  assert.ok(scrim !== undefined && scrim.classList.contains('fd-scrim'), 'no open drop dialog');
  return { scrim, modal: scrim.children[0] as FakeElement };
}

const one = (cls: string): FakeElement => {
  const hit = byClass(card().modal, cls)[0];
  assert.ok(hit !== undefined, `no .${cls}`);
  return hit;
};
const texts = (cls: string): string[] => byClass(card().modal, cls).map((n) => n.textContent);

/** The footer button with this label, whatever its state. */
const btn = (label: string): FakeElement => {
  const hit = byClass(one('fd-ft'), 'btn-quiet')
    .concat(byClass(one('fd-ft'), 'btn-accent'))
    .find((b) => b.textContent === label);
  assert.ok(hit !== undefined, `no footer button labelled ${label}`);
  return hit;
};

/**
 * Fire every recorded timer, in order, until none is left. The mock stagger
 * arms the NEXT row from inside the one that just fired, so this walks the
 * whole copy; the bound is a runaway guard, never a real limit.
 */
function flush(): number {
  let fired = 0;
  while (dom.win.timers.length > 0) {
    const t = dom.win.timers.shift();
    assert.ok(fired < 500, 'a timer chain that never ends');
    t?.fn();
    fired += 1;
  }
  return fired;
}

/** Open one drop, with the opener as the element focus must return to. */
function open(dest: string, items: DropItem[], listing: readonly string[]): void {
  opener.focus();
  FD.openDropDialog({ dest, items, listing, returnFocus: opener });
}

/** Whatever the last test left: close the card, drop every pending tick. */
function reset(): void {
  // Escape is an ANSWER on the question (Skip), so a card left mid-question
  // needs the whole walk: Skip, let the mock finish, Close.
  for (let i = 0; i < 4 && FD.isDropDialogOpen(); i += 1) {
    flush();
    FD.dropDialogEscape();
  }
  dom.win.timers.length = 0;
  assert.equal(FD.isDropDialogOpen(), false, 'reset must leave no dialog open');
}

/** Everything the card says right now, as one string. */
const rendered = (): string => card().modal.textContent;

const HONEST = 'Nothing is copied yet. This is what the copy will look like until the app can write files.';
/**
 * The sentence state 1 used to carry, GONE since part B2: the conflicts are
 * the destination folder's real top-level names now (`ui/filedrop.ts` reads
 * them at drop time), so the question has nothing left to apologise for. Kept
 * as a constant because the tests below assert it is nowhere any more.
 */
const HONEST_ASKING = 'Example conflicts until the app reads your folder.';

// ===========================================================================
// 1. The question
// ===========================================================================

test('non-vacuity: the module is loaded and nothing is open yet', () => {
  assert.equal(FD.isDropDialogOpen(), false);
  assert.equal(modalHost.children.length, 0, 'a dialog is created on open, never at import');
});

test('one conflict: the name, no scope line, and the three Explorer verbs', () => {
  reset();
  open('src', [file('README.md'), file('notes.txt')], ['README.md']);
  assert.equal(FD.isDropDialogOpen(), true);
  assert.deepEqual(texts('fd-title'), ['README.md already exists in src']);
  assert.equal(one('fd-sub').hidden, true, 'one conflict needs no sentence about scope');
  assert.equal(btn('Replace').hidden, false);
  assert.equal(btn('Keep both').hidden, false);
  assert.equal(btn('Skip').hidden, false);
  assert.equal(btn('Close').hidden, true, 'nothing is over yet');
  assert.equal(one('fd-list').hidden, true, 'no list before an answer');
  assert.equal(one('fd-progress').hidden, true);
  assert.equal(dom.doc.activeElement, btn('Keep both'), 'the answer that can lose no file holds the keyboard');
});

test('more than one conflict: the count, and the sentence that says how far the answer reaches', () => {
  reset();
  open('src', [file('a.md'), file('b.md'), file('c.md')], ['a.md', 'b.md', 'c.md']);
  assert.deepEqual(texts('fd-title'), ['3 items already exist in src']);
  assert.equal(one('fd-sub').hidden, false);
  assert.deepEqual(texts('fd-sub'), ['The choice applies to all 3.']);
  // The question does NOT pretend any more (part B2): `a.md already exists in
  // src` is read out of the REAL folder, so the card carries no line about it
  // — and an empty paragraph would still take its margin, so it is hidden.
  assert.equal(one('fd-honest').hidden, true, 'a real conflict needs no apology');
  assert.deepEqual(texts('fd-honest'), ['']);
});

test('the card is a dialog, on the scrim ui/keys.ts finds an open one by', () => {
  const { scrim, modal } = card();
  assert.equal(scrim.className, 'modal-scrim fd-scrim');
  assert.equal(modal.className, 'fd-modal');
  assert.equal(modal.getAttribute('role'), 'dialog');
  assert.equal(modal.getAttribute('aria-modal'), 'true');
  assert.equal(modal.getAttribute('aria-labelledby'), 'fd-title');
  assert.equal(one('fd-title').id, 'fd-title');
});

// ===========================================================================
// 2. The three answers
// ===========================================================================

test('Keep both: the conflict is copied under a new name, the rest untouched', () => {
  reset();
  open('src', [file('README.md'), file('notes.txt')], ['README.md']);
  btn('Keep both').click();

  // Copying: the header names the destination, every row is still pending.
  assert.deepEqual(texts('fd-title'), ['Copying 2 items into src']);
  assert.equal(one('fd-list').hidden, false);
  assert.deepEqual(texts('fd-name'), ['README.md', 'notes.txt']);
  assert.deepEqual(texts('fd-state'), ['', ''], 'a row says nothing before its turn');
  assert.equal(byClass(card().modal, 'is-pending').length, 2);
  assert.deepEqual(texts('fd-step'), ['0 of 2']);
  assert.equal(one('fd-honest').hidden, false, 'the copying state carries the promise');
  assert.deepEqual(texts('fd-honest'), [HONEST]);
  assert.equal(btn('Keep both').hidden, true, 'the question is answered');
  assert.equal(one('fd-ft').hidden, true, 'there is nothing to decide while it copies');
  assert.equal(one('fd-x').hidden, true);
  assert.equal(dom.doc.activeElement, one('fd-step'), 'the busy card keeps the keyboard inside itself');

  // One row at a time, 60 ms apart.
  assert.equal(dom.win.timers.length, 1);
  assert.equal(dom.win.timers[0]?.ms, 60);
  dom.win.timers.shift()?.fn();
  assert.deepEqual(texts('fd-state'), ['Copied', '']);
  assert.deepEqual(texts('fd-step'), ['1 of 2']);
  assert.equal(byClass(card().modal, 'is-pending').length, 1);
  flush();

  // Result: one sentence, the list still readable, Close focused.
  assert.deepEqual(texts('fd-title'), ['Copied 2 files into src.']);
  assert.deepEqual(texts('fd-state'), ['Copied', 'Copied']);
  assert.deepEqual(texts('fd-note'), ['saved as README (2).md'], 'the name it landed under stays with its row');
  assert.deepEqual(texts('fd-step'), ['2 of 2']);
  assert.equal(one('fd-progress').hidden, true, 'the count is only news while it counts');
  assert.equal(one('fd-honest').hidden, false, 'the result state carries the promise too');
  assert.deepEqual(texts('fd-honest'), [HONEST], 'the same sentence the copy made');
  assert.equal(one('fd-ft').hidden, false);
  assert.equal(btn('Close').hidden, false);
  assert.equal(dom.doc.activeElement, btn('Close'), 'the one remaining action holds the keyboard');
});

test('Replace: every item is copied and no row grows a note', () => {
  reset();
  open('src', [file('README.md'), folder('web')], ['README.md']);
  btn('Replace').click();
  assert.deepEqual(texts('fd-title'), ['Copying 2 items into src']);
  flush();
  assert.deepEqual(texts('fd-state'), ['Copied', 'Copied']);
  assert.deepEqual(texts('fd-note'), []);
  assert.deepEqual(texts('fd-title'), ['Copied 1 file and 1 folder into src.']);
});

test('Skip: the conflict is left alone, the rest is copied, and the sentence counts both', () => {
  reset();
  open('src', [file('README.md'), file('notes.txt')], ['README.md']);
  btn('Skip').click();
  flush();
  assert.deepEqual(texts('fd-state'), ['Skipped', 'Copied']);
  assert.equal(one('fd-state').getAttribute('data-state'), 'skipped', 'the outcome is a value, not a colour');
  assert.deepEqual(texts('fd-title'), ['Copied 1 file into src. 1 skipped.']);
});

test('a file over the copy limit fails with its reason under its name', () => {
  reset();
  open('Home', [file('huge.bin', MAX_ITEM_BYTES + 1), file('small.txt')], []);
  // No conflict, so no question: the card opens already copying.
  assert.deepEqual(texts('fd-title'), ['Copying 2 items into Home']);
  flush();
  assert.deepEqual(texts('fd-state'), ['Failed', 'Copied']);
  assert.deepEqual(texts('fd-note'), ['larger than the copy limit']);
  assert.equal(byClass(card().modal, 'fd-state')[0]?.getAttribute('data-state'), 'failed');
  assert.deepEqual(texts('fd-title'), ['Copied 1 file into Home. 1 failed.']);
});

test('no conflict: the card never asks a question it has no reason to ask', () => {
  reset();
  open('Home', [file('notes.txt')], ['other.txt']);
  assert.equal(FD.isDropDialogOpen(), true);
  assert.deepEqual(texts('fd-title'), ['Copying 1 item into Home']);
  assert.equal(one('fd-ft').hidden, true);
  assert.equal(one('fd-honest').hidden, false);
  flush();
  assert.deepEqual(texts('fd-title'), ['Copied 1 file into Home.']);
});

// ===========================================================================
// 3. Dismissal: Escape, the ×, the backdrop
// ===========================================================================

test('Escape on the question is Skip: the copy still runs for everything that does not clash', () => {
  reset();
  open('src', [file('README.md'), file('notes.txt')], ['README.md']);
  FD.dropDialogEscape();
  assert.equal(FD.isDropDialogOpen(), true, 'Skip is an answer, not a way out of the whole drop');
  assert.deepEqual(texts('fd-title'), ['Copying 2 items into src']);
  flush();
  assert.deepEqual(texts('fd-state'), ['Skipped', 'Copied']);
});

test('the × on the question is Skip, and it says so to a screen reader', () => {
  reset();
  open('src', [file('README.md')], ['README.md']);
  assert.equal(one('fd-x').getAttribute('aria-label'), 'skip');
  one('fd-x').click();
  flush();
  assert.deepEqual(texts('fd-state'), ['Skipped']);
  assert.deepEqual(texts('fd-title'), ['Nothing copied into src. 1 skipped.']);
});

test('a press on the backdrop is the same decision as the ×; a press in the card is none', () => {
  reset();
  open('src', [file('README.md')], ['README.md']);
  dispatch(one('fd-title'), 'mousedown');
  assert.deepEqual(texts('fd-title'), ['README.md already exists in src'], 'the card is not a dismissal');
  dispatch(card().scrim, 'mousedown');
  assert.deepEqual(texts('fd-title'), ['Copying 1 item into src'], 'the backdrop is Skip, like the ×');
});

test('Escape while it copies does nothing at all: a copy in flight is not cancelled by a key', () => {
  reset();
  open('Home', [file('a.txt'), file('b.txt'), file('c.txt')], []);
  const before = dom.win.timers.length;
  FD.dropDialogEscape();
  assert.equal(FD.isDropDialogOpen(), true);
  assert.deepEqual(texts('fd-title'), ['Copying 3 items into Home']);
  assert.equal(dom.win.timers.length, before, 'nothing was cancelled and nothing was re-armed');
  flush();
  assert.deepEqual(texts('fd-title'), ['Copied 3 files into Home.']);
});

test('Escape on the result closes, and the keyboard goes back to what the drop came from', () => {
  assert.equal(FD.isDropDialogOpen(), true, 'the previous test left the result up');
  FD.dropDialogEscape();
  assert.equal(FD.isDropDialogOpen(), false);
  assert.equal(modalHost.children.length, 0, 'created on open, removed on close');
  assert.equal(dom.doc.activeElement, opener, 'focus returns to the element the drop came from');
});

test('Close hands the keyboard back to the folder row the files were dropped on', () => {
  // The drag layer hands over the element that had the focus when the drop
  // landed (`tests/ui-filedrop.test.ts`), which for a drop on the Files panel
  // is the folder row itself — not the button this file otherwise opens from.
  reset();
  const row = dom.doc.createElement('button');
  row.className = 'files-row is-dir';
  row.setAttribute('data-k', 'fdir:web/src');
  dom.body.append(row);
  row.focus();
  FD.openDropDialog({ dest: 'src', items: [file('a.txt')], listing: [], returnFocus: row });
  assert.notEqual(dom.doc.activeElement, row, 'non-vacuity: the card took the keyboard first');
  flush();
  btn('Close').click();
  assert.equal(FD.isDropDialogOpen(), false);
  assert.equal(dom.doc.activeElement, row);
  row.remove();
});

test('Close is the same as Escape on the result', () => {
  reset();
  open('Home', [file('a.txt')], []);
  flush();
  btn('Close').click();
  assert.equal(FD.isDropDialogOpen(), false);
  assert.equal(dom.doc.activeElement, opener);
});

// ===========================================================================
// 4. isDropDialogOpen, and the two drops that open nothing
// ===========================================================================

test('isDropDialogOpen: false, true from the first paint, false again after close', () => {
  reset();
  assert.equal(FD.isDropDialogOpen(), false);
  open('Home', [file('a.txt')], []);
  assert.equal(FD.isDropDialogOpen(), true, 'true while it copies');
  flush();
  assert.equal(FD.isDropDialogOpen(), true, 'true while the result stands');
  btn('Close').click();
  assert.equal(FD.isDropDialogOpen(), false);
});

test('one dialog per drop: a second drop while one is up is ignored', () => {
  reset();
  open('src', [file('README.md')], ['README.md']);
  FD.openDropDialog({ dest: 'web', items: [file('other.txt')], listing: [], returnFocus: null });
  assert.equal(modalHost.children.length, 1, 'one card, not two');
  assert.deepEqual(texts('fd-title'), ['README.md already exists in src'], 'the first drop still owns the card');
});

test('a drop carrying nothing opens no dialog', () => {
  reset();
  open('Home', [], []);
  assert.equal(FD.isDropDialogOpen(), false);
  assert.equal(modalHost.children.length, 0);
});

// ===========================================================================
// 5. The copy rules, read off what the card really rendered
// ===========================================================================

test('nothing the card renders carries a path, a byte count or a decorative dash', () => {
  reset();
  const said: string[] = [];
  open('src', [file('README.md'), file('huge.bin', MAX_ITEM_BYTES + 1), folder('web')], ['README.md']);
  said.push(rendered());
  btn('Keep both').click();
  said.push(rendered());
  flush();
  said.push(rendered());
  btn('Close').click();

  assert.ok(said.length === 3 && said.every((s) => s.length > 40), 'non-vacuity: three states were really read');
  for (const s of said) {
    assert.equal(/[/\\]/.test(s.replace(/README\.md|huge\.bin/g, '')), false, `a path reached the card: ${s}`);
    assert.equal(s.includes(' — '), false, `a decorative dash reached the card: ${s}`);
    assert.equal(s.includes(' · '), false, `a decorative separator reached the card: ${s}`);
    assert.equal(s.includes(String(MAX_ITEM_BYTES)), false, `a byte count reached the card: ${s}`);
    assert.equal(/\d+ (?:bytes|KB|MB|MiB)/.test(s), false, `a size reached the card: ${s}`);
  }
});

// ===========================================================================
// 6. The block: class parity, tokens only, no colour literal
// ===========================================================================

const MODULE = frontendFiles(['.ts']).find((f) => f.name === 'web/src/ui/drop-dialog.ts');
const MODULE_SRC = MODULE?.src ?? '';

/** Class names a module really ASSIGNS (the `ui-a8-dialogs.test.ts` scanner). */
function assignedClasses(src: string): string[] {
  const out: string[] = [];
  const push = (s: string): void => {
    for (const c of s.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/)) if (c !== '') out.push(c);
  };
  for (const re of [
    /\bel\(\s*'[a-zA-Z0-9]+'\s*,\s*'([^']*)'/g,
    /\bbutton\(\s*'([^']*)'/g,
    /\.className\s*=\s*'([^']*)'/g,
    /classList\.(?:add|remove|toggle)\(\s*'([^']*)'/g,
  ]) {
    for (const m of src.matchAll(re)) push(m[1] as string);
  }
  return out;
}

/**
 * The `fd-` section's own rules. `mySections` ends a section at the next
 * `/* ---- ` header, and the one after this block is the A6 commit view's
 * `═══` banner, which is not one — so the body is cut at that banner. Anything
 * below it belongs to another part and is guarded by that part's own test.
 */
function fdSection(): string {
  const body = mySections(['drop dialog (Nocturne A9)'])[0]?.body ?? '';
  const end = body.indexOf('/* ═');
  return end === -1 ? body : body.slice(0, end);
}

test('non-vacuity: the module and its stylesheet section are really read', () => {
  assert.ok(MODULE_SRC.length > 2_000, `drop-dialog.ts looks empty: ${MODULE_SRC.length} chars`);
  const block = fdSection();
  assert.ok(block.length > 1_000, `the fd- section looks empty: ${block.length} chars`);
  assert.equal(block.includes('.screen-commit'), false, 'the section was cut at the next block');
  assert.ok(assignedClasses(MODULE_SRC).includes('fd-modal'), 'the card must be found');
});

test('class parity for fd-: no class without a rule, no rule without a setter, one owner', () => {
  const rules = stripComments(APP_CSS);
  const inTs = new Map<string, string[]>();
  for (const f of frontendFiles(['.ts'])) {
    for (const c of assignedClasses(f.src)) {
      if (!/^fd-[a-z0-9-]+$/.test(c)) continue;
      const owners = inTs.get(c) ?? [];
      if (!owners.includes(f.name)) owners.push(f.name);
      inTs.set(c, owners);
    }
  }
  const inCss = new Set<string>();
  for (const m of rules.matchAll(/\.(fd-[a-z0-9-]+)/g)) inCss.add(m[1] as string);
  assert.ok(inTs.size >= 15 && inCss.size >= 15, `non-vacuity: ts ${inTs.size}, css ${inCss.size}`);

  const unstyled = [...inTs.keys()].filter((c) => !inCss.has(c));
  assert.deepEqual(unstyled, [], `classes no rule styles: ${unstyled.join('; ')}`);
  const dead = [...inCss].filter((c) => !inTs.has(c));
  assert.deepEqual(dead, [], `rules no module sets: ${dead.join('; ')}`);

  // A prefix is a block's name: the dialog is the only module that paints it.
  const owners = new Set<string>();
  for (const files of inTs.values()) for (const f of files) owners.add(f);
  assert.deepEqual([...owners], ['web/src/ui/drop-dialog.ts']);

  // The one state class the list needs, styled where it is set.
  assert.ok(assignedClasses(MODULE_SRC).includes('is-pending'));
  assert.match(rules, /\.fd-row\.is-pending\b/);
});

test('tokens only: every var() in the fd- section is declared in tokens.css', () => {
  const declared = declaredTokens();
  assert.ok(declared.size >= 100, `non-vacuity: ${declared.size} tokens declared`);
  const used = usedTokens(stripComments(fdSection()));
  assert.ok(used.length >= 20, `non-vacuity: only ${used.length} token reads in the section`);
  const offenders = [...new Set(used)].filter((t) => !declared.has(t));
  assert.deepEqual(offenders, [], `a rule reads a token that is declared nowhere: ${offenders.join(', ')}`);
  // No new custom property was invented for this block either.
  assert.deepEqual([...stripComments(fdSection()).matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]), []);
});

test('no colour literal in the fd- section or in the module that paints it', () => {
  const offenders: string[] = [];
  for (const m of stripComments(fdSection()).matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/g)) {
    offenders.push(`app.css: ${m[0]}`);
  }
  const code = MODULE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(code.length > 1_000, 'non-vacuity: the module scan found nothing');
  for (const m of code.matchAll(/#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?|oklch)\(/g)) {
    offenders.push(`drop-dialog.ts: ${m[0]}`);
  }
  assert.deepEqual(offenders, [], `a colour decision outside tokens.css: ${offenders.join('; ')}`);
});

test('the accent is never a fill, and the card wears the app-wide button pair', () => {
  const block = stripComments(fdSection());
  const fills = [...block.matchAll(/background:\s*var\((--color-accent|--color-attn|--color-danger)\)/g)].map(
    (m) => m[0],
  );
  assert.deepEqual(fills, [], `the accent and the semantics are never a fill: ${fills.join('; ')}`);
  for (const line of [
    "const skipBtn = button('btn-quiet', 'Skip'",
    "const replaceBtn = button('btn-quiet', 'Replace'",
    "const keepBtn = button('btn-accent', 'Keep both'",
    "const closeBtn = button('btn-quiet', 'Close'",
  ]) {
    assert.ok(MODULE_SRC.includes(line), `the footer idiom changed: ${line}`);
  }
});

test('the honesty line has ONE function and ONE marked call site', () => {
  // Part B10 deletes the mock by deleting what the marker names; two call
  // sites would mean one of them survives the deletion silently.
  const marker = ['PLACEHOLDER', 'MARKER'].join(' ');
  assert.equal(MODULE_SRC.split(`${marker} — DELETE WITH THE MOCK (B10)`).length - 1, 1);
  // Comments NAME the function (the file header explains the rule), so only
  // code counts: one declaration, one call, nothing else.
  const code = MODULE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(code.split('honestyLine(').length - 1, 2, 'one declaration, one call');
  assert.ok(MODULE_SRC.includes(HONEST), 'the copying sentence lives behind that function');
  assert.equal(
    MODULE_SRC.includes(HONEST_ASKING),
    false,
    'the question s sentence is DELETED, not merely unrendered: its conflicts are real since B2',
  );
});

test('the Escape ladder in main.ts ranks the drop dialog after the folder picker', () => {
  const main = frontendFiles(['.ts']).find((f) => f.name === 'web/src/main.ts')?.src ?? '';
  assert.ok(main.length > 10_000, 'non-vacuity: main.ts');
  const pick = main.indexOf('} else if (isFolderPickerOpen())');
  const drop = main.indexOf('} else if (isDropDialogOpen())');
  const newproj = main.indexOf('} else if (isNewProjectDialogOpen())');
  assert.ok(pick > 0 && drop > 0 && newproj > 0, 'all three arms must exist');
  assert.ok(pick < drop && drop < newproj, 'after the folder picker, before the new-project dialog');
  assert.match(main, /import \{ dropDialogEscape, isDropDialogOpen, openDropDialog \} from '\.\/ui\/drop-dialog\.ts';/);
});
