/**
 * Nocturne A8, phase 1 — the dialogs + panels half: the sections of
 * `web/src/styles/app.css` that carry the shared dialog scrim, the shortcuts
 * overlay (`sc-`), the update toast (`ut-`), the restart/update confirmation
 * (`rs-`), and the A5/A6 panel and screen blocks (panels, sessions rows, Files
 * panel, commits list, drag edge, commit view, diff, file pane) — plus the three
 * modules that paint them.
 *
 * What it pins:
 *
 *   1. TOKENS ONLY. Every `var(--x)` in those sections is declared in
 *      tokens.css, the same check the A4 and A7 block tests make for their own
 *      blocks. Phase 2 deleted the alias layer, so this is a typo guard: a
 *      var() naming no token resolves to nothing at runtime.
 *   2. CLASS PARITY for the dialog prefixes over the WHOLE stylesheet and the
 *      WHOLE of web/src: every `sc-`/`ut-`/`rs-`/`fd-`/`dd-` class a module
 *      assigns has a rule, every such rule has a setter, and the prefix
 *      belongs to exactly one module (the overlay's to ui/shortcuts.ts, the
 *      next two to ui/update.ts, `fd-` — the A9 drop dialog — to
 *      ui/drop-dialog.ts, and `dd-` — the B10a delete confirmation — to
 *      ui/delete-dialog.ts).
 *   3. THE RETIRED NAMES — the Legacy `modal*` family, the seven `launch-*`
 *      rules the confirmation still wore, and the old `restart-*` / `toast-*`
 *      sets — have zero users: no rule in app.css, no assignment anywhere in
 *      web/src. `.modal-scrim` is the deliberate SURVIVOR: ui/keys.ts finds an
 *      open dialog by it, so every dialog still wears it.
 *   4. NO COLOUR LITERAL in those sections or in the three modules.
 *   5. THE SURFACES STAY HONEST: the overlay keeps a caption under the two
 *      chords that need one and renders gestures as sentences rather than key
 *      chips; the confirmation shows a percentage only while bytes are really
 *      moving, and prints no `%` of its own.
 *
 * Source inspection only — no DOM, no server. The behaviour of the flows is
 * pinned next door: `tests/ui-shortcuts-table.test.ts`,
 * `tests/ui-shortcuts-openers.test.ts`, `tests/ui-update-model.test.ts`,
 * `tests/ui-restart-guards.test.ts`, `tests/ui-restart-log-hold.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  APP_CSS,
  TOKENS_CSS,
  WEB_SRC,
  declaredTokens,
  frontendFiles,
  mySections as sectionsNamed,
  stripComments,
  usedTokens,
} from './tokens-helpers.ts';

const SHORTCUTS_TS = readFileSync(join(WEB_SRC, 'ui', 'shortcuts.ts'), 'utf8');
/** The rows the overlay renders: their own module since part B6 (the Settings
 *  Keyboard page draws the same ones). */
const SHORTCUT_ROWS_TS = readFileSync(join(WEB_SRC, 'ui', 'shortcuts-rows.ts'), 'utf8');
const UPDATE_TS = readFileSync(join(WEB_SRC, 'ui', 'update.ts'), 'utf8');
const DROP_DIALOG_TS = readFileSync(join(WEB_SRC, 'ui', 'drop-dialog.ts'), 'utf8');
const DELETE_DIALOG_TS = readFileSync(join(WEB_SRC, 'ui', 'delete-dialog.ts'), 'utf8');
const UNSAVED_TS = readFileSync(join(WEB_SRC, 'ui', 'unsaved.ts'), 'utf8');

/** Every .ts under web/src, plus the one hand-written HTML page. */
const FILES = frontendFiles(['.ts']);

/** Comments hold prose that NAMES classes and tokens; only rules count. */
const strip = stripComments;
const APP_RULES = strip(APP_CSS);

/** The section titles Developer B owns in phase 1, by their opening words. */
const MINE = [
  'the shared dialog scrim',
  'shortcuts overlay (Nocturne A8)',
  'panels (Nocturne A5',
  'sessions panel rows (Nocturne A5)',
  'Files panel (Nocturne A5',
  'commits list',
  'the drag edge',
  'update notice: the topbar pill and the toast',
  'restart / update confirmation (Nocturne A8)',
  'commit view: header',
  'commit view: one collapsible file',
  'the diff itself',
  "the Files panel's selected-commit state",
  // Nocturne A10 deleted the `editor` section with the editor column itself:
  // a file is a PANE now, and its styling lives in the pane blocks
  // (`file pane (Nocturne A10)`), which are Developer A's.
  'file pane (Nocturne A10)',
  // Part B10a's confirmation — and, since part B4, the unsaved-changes
  // question, which is that same card with another sentence in it and shares
  // every rule in the section: one more dialog on the same scrim and the same
  // button block, so both are scanned by the same token and colour rules.
  'delete confirmation (Nocturne B10a)',
];

const mySections = (): ReturnType<typeof sectionsNamed> => sectionsNamed(MINE);

/**
 * Class names a module really ASSIGNS, read from the call sites that assign
 * them — not from every string in the file. `toast` and `modal` are ordinary
 * English words in these modules' comments and identifiers (`toastVisible`,
 * `modalHost`), so a whole-file substring scan would report a retired class
 * that no element wears.
 */
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
    /\bclass="([^"]*)"/g,
  ]) {
    for (const m of src.matchAll(re)) push(m[1] as string);
  }
  return out;
}

/**
 * The dialog-and-panel prefixes this file is the parity guard for. `fd-` (the
 * A9 drop dialog) joined the family in part A9, `dd-` (the B10a delete
 * confirmation) in part B10a and `ud-` (part B4's unsaved-changes question) in
 * B4: each is one more dialog on the same scrim and the same button block, so
 * they are checked by the same three rules rather than by a second copy of
 * them. Their own DOM behaviour is `tests/ui-a9-drop-dialog.test.ts`,
 * `tests/ui-files-delete.test.ts` and `tests/ui-unsaved.test.ts`.
 */
const PREFIXED = /^(?:sc|ut|rs|fd|dd|ud)-[a-z0-9-]+$/;

// ---------------------------------------------------------------------------

test('non-vacuity: the stylesheet, the tokens and every frontend file are really read', () => {
  assert.ok(APP_RULES.length > 50_000, `app.css looks empty: ${APP_RULES.length} chars`);
  assert.ok(TOKENS_CSS.length > 5_000, `tokens.css looks empty: ${TOKENS_CSS.length} chars`);
  assert.ok(FILES.length >= 20, `only ${FILES.length} frontend files found`);
  const mine = mySections();
  assert.equal(mine.length, MINE.length);
  for (const s of mine) assert.ok(s.body.length > 40, `${s.title} looks empty at app.css:${s.at}`);
  // The assignment scanner really reads the three modules it is here for.
  assert.ok(assignedClasses(SHORTCUTS_TS).includes('sc-modal'), 'the overlay card must be found');
  assert.ok(assignedClasses(UPDATE_TS).includes('rs-modal'), 'the confirmation card must be found');
  assert.ok(assignedClasses(UPDATE_TS).includes('ut-toast'), 'the toast card must be found');
});

test('tokens only: every var() in the dialog and panel sections is declared in tokens.css', () => {
  // A8 phase 2 deleted the alias layer, so there is one vocabulary left and
  // this is a typo guard: a var() naming no token resolves to nothing at all.
  const declared = declaredTokens();
  assert.ok(declared.size >= 100, `non-vacuity: ${declared.size} tokens declared`);

  const offenders: string[] = [];
  const used = new Set<string>();
  for (const s of mySections()) {
    for (const name of usedTokens(strip(s.body))) {
      used.add(name);
      if (!declared.has(name)) offenders.push(`${s.title}: ${name}`);
    }
  }
  assert.ok(used.size >= 25, `non-vacuity: only ${used.size} tokens used by these sections`);
  assert.deepEqual(offenders, [], `a rule reads a token that is declared nowhere:\n  ${offenders.join('\n  ')}`);
});

test('class parity for sc-, ut-, rs-, fd-, dd- and ud-: no unstyled class, no dead rule, one owner per prefix', () => {
  const inTs = new Map<string, string[]>();
  for (const f of FILES) {
    for (const c of assignedClasses(f.src)) {
      if (!PREFIXED.test(c)) continue;
      const owners = inTs.get(c) ?? [];
      if (!owners.includes(f.name)) owners.push(f.name);
      inTs.set(c, owners);
    }
  }
  const inCss = new Set<string>();
  for (const m of APP_RULES.matchAll(/\.((?:sc|ut|rs|fd|dd|ud)-[a-z0-9-]+)/g)) inCss.add(m[1] as string);
  assert.ok(inTs.size >= 20 && inCss.size >= 20, `non-vacuity: ts ${inTs.size}, css ${inCss.size}`);

  const unstyled = [...inTs.keys()]
    .filter((c) => !inCss.has(c))
    .map((c) => `${c} (set by ${(inTs.get(c) as string[]).join(', ')})`);
  assert.deepEqual(unstyled, [], `classes no rule styles: ${unstyled.join('; ')}`);

  const dead = [...inCss].filter((c) => !inTs.has(c));
  assert.deepEqual(dead, [], `rules no module sets: ${dead.join('; ')}`);

  // A prefix is a block's name, not a shared toolbox: a fourth module reaching
  // into the overlay's or the confirmation's styling is a boundary break.
  const owners = new Map<string, Set<string>>();
  for (const [c, files] of inTs) {
    const prefix = c.slice(0, 2);
    const set = owners.get(prefix) ?? new Set<string>();
    for (const f of files) set.add(f);
    owners.set(prefix, set);
  }
  assert.deepEqual([...(owners.get('sc') as Set<string>)], ['web/src/ui/shortcuts.ts']);
  assert.deepEqual([...(owners.get('ut') as Set<string>)], ['web/src/ui/update.ts']);
  assert.deepEqual([...(owners.get('rs') as Set<string>)], ['web/src/ui/update.ts']);
  assert.deepEqual([...(owners.get('fd') as Set<string>)], ['web/src/ui/drop-dialog.ts']);
  assert.deepEqual([...(owners.get('dd') as Set<string>)], ['web/src/ui/delete-dialog.ts']);
  assert.deepEqual([...(owners.get('ud') as Set<string>)], ['web/src/ui/unsaved.ts']);
});

test('the retired Legacy dialog chrome has zero users: no rule, no assignment', () => {
  // The directory browser went in A7 (the `pk-` picker replaced it) and the
  // confirmation stopped wearing the launch dialog's header in A8, so these
  // rules had no reason to survive the migration onto the primitives.
  const gone = [
    'modal',
    'modal-hd',
    'modal-ft',
    'modal-shortcuts',
    'launch-hd',
    'launch-tile',
    'launch-titles',
    'launch-title',
    'launch-sub',
    'launch-x',
    'launch-gap',
    'restart-scrim',
    'restart-modal',
    'restart-body',
    'restart-lead',
    'restart-list',
    'restart-row',
    'restart-row-name',
    'restart-row-proj',
    'restart-more',
    'restart-note',
    'restart-progress',
    'restart-progress-lb',
    'restart-spin',
    'restart-pct',
    'restart-fail',
    'restart-ft',
    'toast',
    'toast-hd',
    'toast-title',
    'toast-x',
    'toast-body',
    'toast-reason',
    'toast-actions',
  ];
  const offenders: string[] = [];
  for (const c of gone) {
    if (new RegExp(`\\.${c}(?![\\w-])`).test(APP_RULES)) offenders.push(`web/src/styles/app.css .${c}`);
    for (const f of FILES) {
      if (assignedClasses(f.src).includes(c)) offenders.push(`${f.name} ${c}`);
    }
  }
  assert.deepEqual(offenders, [], `retired chrome is still referenced: ${offenders.join('; ')}`);
  // Non-vacuity, both halves: the regex shape finds a rule that IS there, and
  // the scanner finds an assignment that IS there.
  assert.match(APP_RULES, /\.rs-modal(?![\w-])/);
  assert.match(APP_RULES, /\.sc-row(?![\w-])/);
  assert.ok(assignedClasses(UPDATE_TS).includes('modal-scrim'));
});

test('.modal-scrim is the deliberate survivor: one rule, and every dialog still wears it', () => {
  // ui/keys.ts recognises an open dialog by this class
  // (OPEN_FOCUS_OWNER_SELECTOR / FOCUS_OWNER_SELECTOR). A dialog that dropped
  // it would keep its looks and silently break the focus handover.
  const rule = /\.modal-scrim\s*\{([^}]*)\}/.exec(APP_RULES);
  assert.notEqual(rule, null, 'the shared scrim rule must still exist');
  const body = rule?.[1] ?? '';
  assert.match(body, /position:\s*fixed/);
  assert.match(body, /z-index:\s*var\(--z-modal\)/);
  assert.match(body, /background:\s*var\(--color-scrim\)/, 'the scrim is the flat Nocturne backdrop');
  const wearers = FILES.filter((f) => assignedClasses(f.src).includes('modal-scrim')).map((f) => f.name);
  assert.deepEqual(wearers.sort(), [
    'web/src/ui/delete-dialog.ts',
    'web/src/ui/drop-dialog.ts',
    'web/src/ui/launch.ts',
    'web/src/ui/newproject.ts',
    'web/src/ui/picker.ts',
    'web/src/ui/settings.ts',
    'web/src/ui/shortcuts.ts',
    'web/src/ui/unsaved.ts',
    'web/src/ui/update.ts',
  ]);
  // The two new scrims wear it beside their own prefix, in that order.
  assert.ok(SHORTCUTS_TS.includes("el('div', 'modal-scrim sc-scrim')"));
  assert.ok(UPDATE_TS.includes("el('div', 'modal-scrim rs-scrim')"));
  assert.ok(DROP_DIALOG_TS.includes("el('div', 'modal-scrim fd-scrim')"));
  assert.ok(DELETE_DIALOG_TS.includes("el('div', 'modal-scrim dd-scrim')"));
  assert.ok(UNSAVED_TS.includes("el('div', 'modal-scrim ud-scrim')"));
  // The confirmation sits at the shared --z-modal — it takes its z-layer from
  // `.modal-scrim` and declares none of its own, unlike the restart
  // confirmation, which is the ONE dialog that opens over another.
  // Since part B4 that anchor rule serves TWO scrims — the confirmation and
  // the unsaved-changes question are one card with two questions in it — so
  // the selector is a list and the block is read through it.
  const dd = /\.modal-scrim\.dd-scrim[^{]*\{([^}]*)\}/.exec(APP_RULES);
  assert.notEqual(dd, null, 'the confirmation scrim must have its own anchor rule');
  assert.equal(/z-index/.test(dd?.[1] ?? ''), false, 'it inherits --z-modal from .modal-scrim');
  assert.match(APP_RULES, /\.modal-scrim\.ud-scrim/, 'and the B4 question is anchored with it');
  // The confirmation is the ONE dialog that opens over another one.
  assert.match(APP_RULES, /\.modal-scrim\.rs-scrim\s*\{[^}]*z-index:\s*var\(--z-modal-top\)/);
  // The toast sits over the panes and under every dialog.
  assert.match(APP_RULES, /\.ut-toast\s*\{[^}]*z-index:\s*var\(--z-toast\)/);
});

test('no colour literal in these sections or in the modules that paint them', () => {
  // Every colour is a token or an inline color-mix of tokens (tokens.css is the
  // one place a hex may be written). The --shadow-* primitives carry their own
  // rgba, which is why only the sections are scanned and not the tokens file.
  const offenders: string[] = [];
  for (const s of mySections()) {
    for (const m of strip(s.body).matchAll(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/g)) {
      offenders.push(`${s.title}: ${m[0]}`);
    }
  }
  for (const [name, src] of [
    ['ui/shortcuts.ts', SHORTCUTS_TS],
    ['ui/update.ts', UPDATE_TS],
    ['ui/delete-dialog.ts', DELETE_DIALOG_TS],
  ] as const) {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.ok(code.length > 500, `non-vacuity: ${name}`);
    for (const m of code.matchAll(/#[0-9a-fA-F]{6}\b|\b(?:rgba?|hsla?|oklch)\(/g)) {
      offenders.push(`${name}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `a colour decision outside tokens.css: ${offenders.join('; ')}`);
  // Non-vacuity: the scanner can see a colour literal where one legitimately is.
  assert.match(TOKENS_CSS, /#[0-9a-fA-F]{6}\b/);
});

test('the overlay keeps its three columns, its key chips and the caption under the rows that need one', () => {
  // The caption is the answer to "why not ctrl+v?" and to "is ctrl+c still the
  // interrupt?" — it lives with its row, inside the same item, so the hairline
  // between entries never cuts a row away from its own explanation.
  assert.match(SHORTCUTS_TS, /const item = el\('div', 'sc-item'\);/);
  assert.match(SHORTCUTS_TS, /if \(r\.note !== undefined\) item\.append\(el\('div', 'sc-cap', r\.note\)\);/);
  assert.match(
    SHORTCUTS_TS,
    /row\.append\(keys, el\('span', 'sc-what', r\.what\), el\('span', 'sc-ui', r\.ui\)\);/,
    'three columns: what you press, what it does, where the same thing lives in the UI',
  );
  // A chord is a key chip; a mouse gesture is a sentence and must never be one.
  assert.match(
    SHORTCUTS_TS,
    /r\.gesture === true \? el\('span', 'sc-gesture', k\) : el\('kbd', '', k\)/,
  );
  assert.match(APP_RULES, /\.sc-keys kbd\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
  assert.match(APP_RULES, /\.sc-gesture\s*\{[^}]*font-family:\s*var\(--font-sans\)/);
  // The four chords the app takes off the terminal, and the link gesture, are
  // all still listed (the full vocabulary check is ui-shortcuts-table.test.ts).
  // Since B6 the rows live next door, in the module both surfaces read.
  for (const k of ['ctrl+shift+v', 'shift+insert', 'ctrl+shift+c', 'ctrl+insert', 'ctrl+click a link']) {
    assert.ok(SHORTCUT_ROWS_TS.includes(`'${k}'`), `the table must still list ${k}`);
  }
  // Each row that carries a one-line why keeps it, as a sentence. Five are
  // spelled with single quotes (paste, copy, the Files row menu since A9c, the
  // Delete key since B10a, whose note is the "no undo, no recycle bin"
  // sentence, and ctrl+s since B4, whose note is the reason a terminal still
  // gets that key); the files-on-the-clipboard note is double-quoted because
  // it holds an apostrophe, so this scan has never counted it.
  const notes = [...SHORTCUT_ROWS_TS.matchAll(/note: '([^']*)'/g)].map((m) => m[1] as string);
  assert.equal(
    notes.length,
    5,
    `expected the paste, copy, row-menu, delete and save notes, found ${notes.length}`,
  );
  for (const n of notes) {
    assert.match(n, /^[A-Z]/, `a caption is a plain sentence: ${n}`);
    assert.match(n, /\.$/, `a caption is a plain sentence: ${n}`);
  }
});

test('the confirmation shows a percentage only while bytes are really moving, and prints no % of its own', () => {
  // An honest wait: the phase is the news, the number is only true while the
  // download runs. `verify` and `install` have no measurable middle, and a
  // frozen 100% would claim one.
  assert.match(UPDATE_TS, /progressPct\.hidden = p !== 'downloading';/);
  assert.match(UPDATE_TS, /progressPct\.textContent = p === 'downloading' \? percentText\(percent\) : '';/);
  // The restart half has no percentage at all.
  const restartHalf = /\} else \{\n\s*progressText\.textContent = p === 'restarting'[\s\S]*?\n\s*\}/.exec(UPDATE_TS);
  assert.notEqual(restartHalf, null, 'the restart half of showProgress must still exist');
  assert.match(restartHalf?.[0] ?? '', /progressPct\.hidden = true;/);
  // And the module writes no percent sign itself: the only one in the app comes
  // from `percentText` in the DOM-free flow next door.
  const literals = [...UPDATE_TS.matchAll(/'([^'\n]*)'/g)].map((m) => m[1] as string);
  assert.ok(literals.length > 50, 'non-vacuity: the literal scan found nothing');
  assert.deepEqual(
    literals.filter((l) => l.includes('%')),
    [],
    'a percentage in this file would be a number the dialog invented',
  );
  // The figures that DO arrive are tabular, so the line cannot twitch while it
  // counts, and they are data — mono, like every other value in the app.
  assert.match(APP_RULES, /\.rs-pct\s*\{[^}]*font-variant-numeric:\s*tabular-nums/);
  assert.match(APP_RULES, /\.rs-pct\s*\{[^}]*font-family:\s*var\(--font-mono\)/);
});

test('the confirmation and the toast keep the Nocturne button pair, and the accent is never a fill', () => {
  // `.btn-accent` / `.btn-quiet` are the app-wide dialog footer idiom (the New
  // session dialog, Add a project, the folder picker, the empty state).
  for (const line of [
    "const cancelBtn = button('btn-quiet', COPY.cancel",
    "const confirmBtn = button('btn-accent', COPY.confirm",
    "const closeBtn = button('btn-quiet', COPY.close",
    "const hideBtn = button('btn-quiet', COPY.hide",
    "const retryBtn = button('btn-accent', COPY.retry",
    "const toastGo = button('btn-accent', COPY.toastGo",
  ]) {
    assert.ok(UPDATE_TS.includes(line), `the footer idiom changed: ${line}`);
  }
  // Nothing in either surface fills with the accent or the attention hue: the
  // accent is an outline, and amber is a rule on the edge of a card.
  const surfaces = mySections().filter(
    (s) => s.title.startsWith('update notice') || s.title.startsWith('restart / update confirmation'),
  );
  assert.equal(surfaces.length, 2);
  const offenders: string[] = [];
  for (const s of surfaces) {
    for (const m of strip(s.body).matchAll(/background:\s*var\((--color-accent|--color-attn)\)/g)) {
      offenders.push(`${s.title}: ${m[0]}`);
    }
  }
  assert.deepEqual(offenders, [], `the accent and the attention hue are never a fill: ${offenders.join('; ')}`);
  // The one amber mark each surface is allowed: a 2px rule on the left edge.
  assert.match(APP_RULES, /\.ut-toast\s*\{[^}]*border-left:\s*var\(--tick\) solid var\(--color-attn\)/);
  assert.match(APP_RULES, /\.rs-note\s*\{[^}]*border-left:\s*var\(--tick\) solid var\(--color-attn\)/);
});
