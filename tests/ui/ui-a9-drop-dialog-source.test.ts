/**
 * `web/src/ui/drop-dialog.ts` — the drop dialog (Nocturne A9, `fd-`): the
 * source-level guards its stylesheet block needs, and the source pins on the
 * module itself. Split from `tests/ui/ui-a9-drop-dialog.test.ts` (which drives
 * the card on the DOM double).
 *
 * What: the block guards every Nocturne section carries — class parity for
 * `fd-` (no class without a rule, no rule without a setter, one owner), tokens
 * only, no colour literal, the accent never a fill and the app-wide button
 * pair; the mock is GONE from `web/src` (asserted by absence); the card drives
 * the RUNNER it was handed and owns no clock; `main.ts`'s Escape ladder ranks
 * the drop dialog after the folder picker.
 *
 * How: source text only (`frontendFiles`, `mySections`, `APP_CSS`) — no
 * module is imported, so nothing runs.
 *
 * NOT claimed: that the card looks right (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  APP_CSS,
  declaredTokens,
  frontendFiles,
  mySections,
  stripComments,
  usedTokens,
} from '../helpers/tokens-helpers.ts';
import { assignedClasses } from '../helpers/source-scan.ts';

const HONEST = 'Nothing is copied yet. This is what the copy will look like until the app can write files.';
/**
 * The sentence state 1 used to carry, GONE since part B2: the conflicts are
 * the destination folder's real top-level names now (`ui/filedrop.ts` reads
 * them at drop time), so the question has nothing left to apologise for. Kept
 * as a constant because the tests below assert it is nowhere any more.
 */
const HONEST_ASKING = 'Example conflicts until the app reads your folder.';

// ===========================================================================
// 6. The block: class parity, tokens only, no colour literal
// ===========================================================================

const MODULE = frontendFiles(['.ts']).find((f) => f.name === 'web/src/ui/drop-dialog.ts');
const MODULE_SRC = MODULE?.src ?? '';

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

test('the mock is GONE from web/src — asserted by ABSENCE, so it cannot come back', () => {
  // Part B10 deleted the mock by deleting what the marker named. This is read
  // off the SOURCE and not off the card: a rendered assertion passes just as
  // well when the sentence is merely unreachable, and an unreachable promise
  // that nothing is written is a promise waiting to be re-rendered.
  const marker = ['PLACEHOLDER', 'MARKER'].join(' ');
  const files = frontendFiles(['.ts', '.html']);
  assert.ok(files.length >= 20, `non-vacuity: scanned ${files.length} frontend files`);
  const offenders: string[] = [];
  for (const f of files) {
    // The bare marker is a repo-wide idiom (other parts carry their own); what
    // may not survive anywhere is B10's marker and B10's sentences.
    for (const needle of [
      `${marker} — DELETE WITH THE MOCK (B10)`,
      HONEST,
      HONEST_ASKING,
      'Nothing is copied yet',
    ]) {
      if (f.src.includes(needle)) offenders.push(`${f.name}: ${needle.slice(0, 40)}`);
    }
  }
  assert.equal(MODULE_SRC.includes(marker), false, 'and the card carries no marker of its own');
  assert.deepEqual(offenders, [], `the mock survives somewhere: ${offenders.join('; ')}`);

  // The three names the mock lived under, and the paragraph it was written in.
  for (const gone of ['honestyLine', 'HONEST_COPYING', 'STEP_MS', 'fd-honest']) {
    assert.equal(MODULE_SRC.includes(gone), false, `${gone} is still in the module`);
  }
  assert.equal(APP_CSS.includes('fd-honest'), false, 'and its rule is gone from the stylesheet');
  // A row settles because an upload answered. The card owns no clock at all.
  const code = MODULE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(code.length > 1_000, 'non-vacuity: the module scan found nothing');
  assert.equal(/setTimeout|setInterval/.test(code), false, 'no timer decides what a row says');
});

test('the card drives the RUNNER it was handed: plan, then start, and nothing of its own', () => {
  // The module imports the runner's TYPE only — the thing itself is built in
  // main.ts, closed over the destination's path. A dialog that imported
  // `createDropRun` would be a dialog that knows where files go.
  assert.match(MODULE_SRC, /import type \{ DropRun \} from '\.\/drop-upload\.ts';/);
  const code = MODULE_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(code.includes('req.run.plan(choice)'), 'the rows ARE the plan the copy will run');
  assert.ok(code.includes('req.run\n      .start(choice'), 'and the copy is that same answer');
  assert.equal(code.includes('planResults('), false, 'the card never plans a second time');
  assert.ok(code.includes("scrollIntoView?.({ block: 'nearest' })"), 'the settled row is kept in view');
});

test('the Escape ladder in main.ts ranks the drop dialog after the folder picker', () => {
  const main = frontendFiles(['.ts']).find((f) => f.name === 'web/src/main.ts')?.src ?? '';
  assert.ok(main.length > 10_000, 'non-vacuity: main.ts');
  const pick = main.indexOf('} else if (isFolderPickerOpen())');
  const drop = main.indexOf('} else if (isDropDialogOpen())');
  const newproj = main.indexOf('} else if (isNewProjectDialogOpen())');
  assert.ok(pick > 0 && drop > 0 && newproj > 0, 'all three arms must exist');
  assert.ok(pick < drop && drop < newproj, 'after the folder picker, before the new-project dialog');
  assert.match(
    main,
    /import \{[^}]*\bdropDialogEscape,[^}]*\bisDropDialogOpen,[^}]*\bopenDropDialog,?[^}]*\} from '\.\/ui\/drop-dialog\.ts';/s,
  );
  // The fix round added the "one copy at a time" question to the same module,
  // and the drag layer must really be wired to it.
  assert.match(main, /\bisDropRunning,/);
  assert.match(main, /\n\s*copyRunning: isDropRunning,\n/);
});
