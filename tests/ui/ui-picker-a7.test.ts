/**
 * Nocturne part A7 (follow-up c) — the STYLE contract of the FOLDER PICKER,
 * pinned by source inspection (`.claude/plans/PLAN-NOCTURNE.md` §A7), in the manner of
 * `tests/ui/ui-launch-a4.test.ts` and `tests/ui/ui-addproject-a7.test.ts`. The
 * picker's behaviour is driven for real in `tests/ui/ui-picker-dom.test.ts` (it
 * opens over the Add-a-project dialog and hands a path back) and its endpoints
 * in `tests/server/scaffold.test.ts` / `tests/ui/ui-api-auth.test.ts`. What is left for a
 * source pin:
 *
 *   1. TOKENS ONLY. Every `var(--x)` in the `pk-` block must be declared in
 *      tokens.css. (The Legacy block this replaced reached for --s-*, --edge-*,
 *      --acc*, --ok*, --text-* and --fs-*: it was the last Legacy dialog left
 *      over a Nocturne one. Part A8 deleted that alias layer, names and all, so
 *      this is now a typo guard.)
 *   2. NO HARDCODED COLOR in the block (tokens.css: "Never hardcode a color
 *      outside this file").
 *   3. CLASS PARITY. Every `pk-` class picker.ts puts on an element has a rule,
 *      every `pk-` selector in the block is still used by picker.ts, and the
 *      only non-`pk-` classes it wears are the three shared ones it MUST wear.
 *   4. The Legacy chrome the picker dropped is gone — from picker.ts, and, for
 *      the rules it was the LAST user of, from app.css.
 *   5. The scrim is top-anchored and keeps `modal-scrim`, which is how
 *      ui/keys.ts sees an open dialog and how main.ts ranks Esc.
 *
 * Looks, sizes, and whether it reads right stay manual
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../helpers/helpers.ts';
import { declaredTokens, readAppCss, usedTokens } from '../helpers/tokens-helpers.ts';

const UI = join(projectRoot, 'web', 'src', 'ui');
const STYLES = join(projectRoot, 'web', 'src', 'styles');
const read = (p: string): string => readFileSync(p, 'utf8');

const APP_CSS = readAppCss();
const TOKENS_CSS = read(join(STYLES, 'tokens.css'));
const PICKER = read(join(UI, 'picker.ts'));
/** picker.ts without comments: a comment may NAME the Legacy chrome it replaced. */
const PICKER_CODE = PICKER.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const BLOCK_START = '/* ---- folder picker (Phase 2a)';
/** The block's own sub-headers share the `/* ---- ` shape, so the end is the NEXT section. */
const BLOCK_END = '/* ---- boot overlay (honest steps;';
const start = APP_CSS.indexOf(BLOCK_START);
const end = APP_CSS.indexOf(BLOCK_END, start + BLOCK_START.length);
const PK_CSS = start === -1 || end === -1 ? '' : APP_CSS.slice(start, end);
/** Comments out: a comment may NAME what the rules may not use. */
const PK_RULES = PK_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
/** The whole stylesheet without comments, for "this rule is really gone" checks. */
const APP_RULES = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** The whole token vocabulary — A8 phase 2 left exactly one set. */
const DECLARED = declaredTokens();

test('non-vacuity: the pk- block and the token vocabulary is really being read', () => {
  assert.notEqual(start, -1, `app.css must carry the "${BLOCK_START}" section`);
  assert.notEqual(end, -1, `the block must still be followed by "${BLOCK_END}"`);
  assert.ok(PK_RULES.length > 2000, 'the pk- block looks empty');
  assert.ok(PK_RULES.includes('.pk-modal'), 'the block must style .pk-modal');
  assert.ok(DECLARED.has('--color-accent') && DECLARED.has('--space-4'), 'tokens parsed');
  assert.ok(DECLARED.size >= 100, `non-vacuity: ${DECLARED.size} tokens declared`);
});

test('tokens only: every var() in the pk- block is declared in tokens.css', () => {
  const used = [...new Set(usedTokens(PK_RULES))];
  assert.ok(used.length >= 10, `non-vacuity: found ${used.length} tokens`);
  const offenders = used.filter((t) => !DECLARED.has(t));
  assert.deepEqual(
    offenders,
    [],
    'a var() naming no declared token resolves to nothing at runtime. Offenders: ' +
      offenders.join(', '),
  );
});

test('non-vacuity: the block still consumes a token (the 1px hairline), so the scan is not empty', () => {
  assert.ok(PK_RULES.includes('var(--line)'), 'the block must still wear the 1px hairline width');
});

test('no hardcoded color in the pk- block', () => {
  const hits = [...PK_RULES.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(rgba?|hsla?|oklch)\(/g)].map((m) => m[0]);
  assert.deepEqual(hits, [], 'colors come from tokens.css only');
});

test('the scrim consumes --color-scrim, keeps `modal-scrim`, and is TOP-anchored', () => {
  // Top-anchored on the SAME 250px the `ap-` scrim uses: the picker opens over
  // the Add-a-project card, so its top edge lands on that card's instead of
  // jumping. And `modal-scrim` is not decoration: ui/keys.ts finds an open
  // dialog by it (FOCUS_OWNER_SELECTOR) and main.ts ranks Esc by
  // isFolderPickerOpen() before the dialog underneath.
  assert.match(PK_RULES, /\.modal-scrim\.pk-scrim\s*\{[^}]*background:\s*var\(--color-scrim\)/);
  assert.match(PK_RULES, /\.modal-scrim\.pk-scrim\s*\{[^}]*align-items:\s*flex-start/);
  // 250px is the `ap-` scrim's own anchor: the two cards then share a top edge.
  assert.match(PK_RULES, /\.pk-scrim\s*\{[^}]*calc\(50vh - 250px\)/);
  assert.ok(PICKER_CODE.includes("'modal-scrim pk-scrim'"), 'the scrim keeps the class keys.ts looks for');
  // Nothing in the block may re-centre the card.
  const boxes = [...PK_RULES.matchAll(/([^{}]*\.pk-(?:scrim|modal)(?![\w-])[^{}]*)\{([^{}]*)\}/g)];
  assert.ok(boxes.length >= 2, `non-vacuity: ${boxes.length} box rules`);
  for (const b of boxes) {
    assert.ok(
      !/align-items:\s*center|place-items:\s*center|margin(?:-top|-block-start)?:\s*auto/.test(b[2] as string),
      `the picker must keep a stable top edge: ${b[1] as string}`,
    );
  }
});

test('one accent rule: the footer commitment and the focus ring, nothing else', () => {
  // Everything available is neutral-700/800; the accent means the one control
  // that commits (the shared .btn-accent, which the block does not restyle) and
  // the focus ring. Standing ON a quick zone is a STATE, so it takes the
  // neutral ground — the same discipline as the `ap-` block.
  assert.match(PK_RULES, /\.pk-zone\.is-on\s*\{[^}]*background:\s*var\(--color-neutral-900\)/);
  assert.ok(
    !/\.pk-zone\.is-on\s*\{[^}]*--color-accent/.test(PK_RULES),
    'a marked quick zone must not borrow the accent',
  );
  const accentRules = [...PK_RULES.matchAll(/([^{}]+)\{([^{}]*var\(--color-accent[^{}]*)\}/g)].map((m) =>
    (m[1] as string).trim(),
  );
  assert.ok(accentRules.length >= 1, 'non-vacuity: the block uses the accent somewhere');
  for (const sel of accentRules) {
    assert.ok(
      /:focus(?:-visible)?/.test(sel),
      `the accent belongs to the focus ring and the field's own focus edge only: ${sel}`,
    );
  }
});

/**
 * Class names picker.ts assigns, read from the CALL SITES rather than from every
 * string literal: `el('<tag>', '<classes>')`, `button('<classes>', …)` — also
 * the one ternary that picks a class — and `classList.toggle('<class>')`. A
 * whole-file string scan would swallow tag names, attribute names and copy.
 */
function pickerClasses(): { pk: Set<string>; other: Set<string> } {
  const pk = new Set<string>();
  const other = new Set<string>();
  const lists: string[] = [];
  for (const re of [
    /\bel\('[a-z0-9]+', '([^']*)'/g,
    /\bbutton\('([^']*)'/g,
    /\? '([^']*)' : '([^']*)'/g,
    /classList\.toggle\('([^']*)'/g,
  ]) {
    for (const m of PICKER_CODE.matchAll(re)) {
      for (const g of m.slice(1)) if (typeof g === 'string') lists.push(g);
    }
  }
  for (const raw of lists) {
    // A class name in this app always carries a hyphen (`pk-hd`, `is-on`,
    // `modal-scrim`), which is what keeps the ternary's `'true'`/`'false'`
    // aria values out of the set.
    for (const c of raw.split(' ').filter((x) => x.includes('-'))) {
      if (c.startsWith('pk-')) pk.add(c);
      else other.add(c);
    }
  }
  return { pk, other };
}

test('class parity: every pk- class picker.ts sets has a rule, and every pk- rule is still used', () => {
  const { pk } = pickerClasses();
  const inCss = new Set([...PK_RULES.matchAll(/\.(pk-[a-z0-9-]+)/g)].map((m) => m[1] as string));
  assert.ok(pk.size >= 15 && inCss.size >= 15, `non-vacuity: ts ${pk.size}, css ${inCss.size}`);
  const unstyled = [...pk].filter((c) => !inCss.has(c));
  const dead = [...inCss].filter((c) => !pk.has(c));
  assert.deepEqual(unstyled, [], `picker.ts sets pk- classes no rule styles: ${unstyled.join(', ')}`);
  assert.deepEqual(dead, [], `app.css styles pk- classes picker.ts never sets: ${dead.join(', ')}`);
  // Every pk- rule lives in the ONE block (nothing scattered for A8 to hunt).
  const outside = [...new Set([...APP_RULES.matchAll(/\.(pk-[a-z0-9-]+)/g)].map((m) => m[1] as string))].filter(
    (c) => !PK_RULES.includes(`.${c}`),
  );
  assert.deepEqual(outside, [], `pk- rules outside the block: ${outside.join(', ')}`);
});

test('the only shared classes the picker wears are the three it must', () => {
  // `modal-scrim` is the dialog contract with keys.ts/main.ts; the Nocturne
  // button pair is the app-wide footer idiom (`ap-`, `ns-`, the empty state).
  // Anything else here would be a Legacy leftover or a private style in hiding.
  const { other } = pickerClasses();
  assert.deepEqual([...other].sort(), ['btn-accent', 'btn-quiet', 'is-here', 'is-on', 'modal-scrim']);
});

test('the Legacy chrome the picker dropped is gone from picker.ts and from app.css where it was the last user', () => {
  // picker.ts was the last Legacy dialog: the gradient `launch-hd` header with
  // its tile and ×, the `.dirlist`/`.dir-btn` directory list, `.modal-ft`, the
  // `.btn`/`.btn.is-primary` footer pair, `.form-err` and `.drawer-empty`.
  // `modal` is not in this list: the module's own local variable is called that.
  // The card's class is pinned directly instead.
  assert.ok(PICKER_CODE.includes("el('div', 'pk-modal')"), 'the card wears the pk- class and nothing else');
  const droppedHere = [
    'launch-hd',
    'launch-tile',
    'launch-titles',
    'launch-title',
    'launch-gap',
    'launch-x',
    'np-glyph',
    'dirlist',
    'dir-btn',
    'modal-ft',
    'form-err',
    'drawer-empty',
    'btn',
    'is-primary',
    'pk-nav',
    'pk-cwd',
  ];
  const offenders: string[] = [];
  for (const c of droppedHere) {
    if (new RegExp(`['\` ]${c}(?![\\w-])`).test(PICKER_CODE)) offenders.push(`picker.ts ${c}`);
  }
  assert.deepEqual(offenders, [], `picker.ts still wears Legacy chrome: ${offenders.join(', ')}`);

  // Rules whose LAST user was the picker: they may not survive anywhere in the
  // stylesheet (comments stripped — the pk- block's own comment NAMES them as
  // the Legacy it replaced).
  const lastUser = ['np-glyph', 'dirlist', 'dir-btn', 'form-err', 'pk-nav', 'pk-cwd'];
  const alive = lastUser.filter((c) => new RegExp(`\\.${c}(?![\\w-])`).test(APP_RULES));
  assert.deepEqual(alive, [], `app.css still carries rules nothing sets: ${alive.join(', ')}`);
  // Non-vacuity: the regex shape really does find a rule that IS there.
  assert.match(APP_RULES, /\.pk-row(?![\w-])/);
  // And no frontend module set them either (the token went with the rule).
  const tsFiles = readdirSync(UI)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => [f, read(join(UI, f))] as const);
  tsFiles.push(['main.ts', read(join(projectRoot, 'web', 'src', 'main.ts'))]);
  tsFiles.push(['main-shell.ts', read(join(projectRoot, 'web', 'src', 'main-shell.ts'))]);
  const stillSet: string[] = [];
  for (const c of ['dirlist', 'dir-btn', 'form-err', 'np-glyph']) {
    for (const [f, src] of tsFiles) if (new RegExp(`['\`  ]${c}(?![\\w-])`).test(src)) stillSet.push(`${f} ${c}`);
  }
  assert.deepEqual(stillSet, []);
  assert.ok(!TOKENS_CSS.includes('--dirlist-min-h'), 'the list-height token went with the list rule');
});

test('paths and folder names read in mono, the words in the chrome do not', () => {
  // A path segment and a folder name are DATA (JetBrains Mono, per A1); the
  // title, the zones and the actions are words (Inter, inherited).
  for (const sel of ['.pk-crumb', '.pk-sep', '.pk-rowname', '.pk-mkname']) {
    const rule = new RegExp(`\\${sel}\\s*\\{[^}]*font-family:\\s*var\\(--font-mono\\)`);
    assert.match(PK_RULES, rule, `${sel} must read in mono`);
  }
  for (const sel of ['.pk-title', '.pk-zone', '.pk-ft']) {
    assert.ok(
      !new RegExp(`\\${sel}\\s*\\{[^}]*font-family`).test(PK_RULES),
      `${sel} is chrome: it inherits Inter`,
    );
  }
});

test('Esc reaches the picker FIRST: ranked above the dialog it opens over, below the Settings modal', () => {
  // The behaviour test drives `closeFolderPicker()` (what main.ts calls); the
  // RANK lives in main.ts's one Escape chain and is what makes Esc peel the
  // picker instead of the Add-a-project card underneath it. Same arm-index
  // technique as `tests/ui/ui-a6-screens.test.ts` for the commit view.
  const MAIN = read(join(projectRoot, 'web', 'src', 'main-shell.ts'));
  const from = MAIN.indexOf("e.key === 'Escape'");
  assert.notEqual(from, -1, 'non-vacuity: the Escape branch was found');
  const to = MAIN.indexOf('// ---- reliability');
  assert.ok(to > from, 'non-vacuity: the branch has an end');
  const arms = MAIN.slice(from, to).split('} else if');
  const pickerArm = arms.findIndex((a) => a.includes('closeFolderPicker();'));
  const npArm = arms.findIndex((a) => a.includes('closeNewProjectDialog();'));
  const settingsArm = arms.findIndex((a) => a.includes('settings.close();'));
  assert.ok(pickerArm !== -1 && npArm !== -1 && settingsArm !== -1, 'non-vacuity: three arms found');
  assert.ok(pickerArm < npArm, 'the picker opens OVER the Add-a-project dialog, so Esc peels it first');
  assert.ok(settingsArm < pickerArm, 'the Settings modal stays topmost');
  assert.match(
    arms[pickerArm] as string,
    /isFolderPickerOpen\(\)[\s\S]*e\.preventDefault\(\);[\s\S]*closeFolderPicker\(\);/,
    'the arm must claim the key, not let it fall through',
  );
});

test('the picker knows no path of its own: Home and ~/projects come from the OPENER, only the root is a literal', () => {
  // newproject.ts resolves $HOME and `<home>/projects` from ONE GET /api/fs/list
  // ("no hardcoded `/home/...`", its own comment) and hands them down. A literal
  // here would be a second, wronger source of truth — and on a distro whose
  // home is not under /home it would name a folder that does not exist.
  const singleQuoted = [...PICKER_CODE.matchAll(/'([^'\n]*)'/g)].map((m) => m[1] as string);
  assert.ok(singleQuoted.length > 20, `non-vacuity: ${singleQuoted.length} literals read`);
  const absolute = singleQuoted.filter((t) => t.startsWith('/') && t !== '/' && !t.startsWith('//'));
  assert.deepEqual(absolute, [], `the picker may name no absolute path but the root: ${absolute.join(', ')}`);
  const homeish = [/\/home\b/, /\/root\b/, /\/Users\b/, /process\.env/, /\bHOME\b/, /os\.homedir/].filter((re) =>
    re.test(PICKER_CODE),
  );
  assert.deepEqual(homeish.map(String), [], 'the picker must not guess where home is');
  // The three zones, each reading what it is allowed to read.
  assert.match(PICKER_CODE, /label:\s*'Home',\s*path:\s*opts\.home\s*\?\?\s*undefined/);
  assert.match(PICKER_CODE, /label:\s*'~\/projects',\s*path:\s*opts\.projectsDir/);
  assert.match(PICKER_CODE, /label:\s*'Root',\s*path:\s*'\/'/);
  // A zone without a path is a load() with NO argument, which IS the backend's
  // $HOME default — never a string this module composed.
  assert.match(PICKER_CODE, /load\(path:\s*string\s*\|\s*undefined\)/);
});

test('copy: the picker names no command or flag, uses no decorative separator, and commits in plain words', () => {
  // PROJECT-SCOPE "No commands, flags, or code in the UI" (2026-07-25) and the
  // A2 copy rules. `+ folder` is the one terse label (a control, not a
  // sentence); the footer states what pressing it does.
  assert.ok(PICKER_CODE.includes("'Choose this folder'"), 'the footer says what it does');
  assert.ok(PICKER_CODE.includes("'No folders here.'"), 'an empty folder says so honestly');
  const strings = [...PICKER_CODE.matchAll(/(['`])([^'`\n]*)\1/g)].map((m) => m[2] as string);
  const banned = [/--[a-z][a-z-]+/, /\bAI_SM_[A-Z_]+/, /\$ /, /•|·|—\s*$/];
  const offenders: string[] = [];
  for (const t of strings) {
    if (t.startsWith('../') || t.startsWith('./')) continue; // import paths
    for (const re of banned) if (re.test(t)) offenders.push(t);
  }
  assert.deepEqual(offenders, [], 'UI copy must stay plain language');
});
