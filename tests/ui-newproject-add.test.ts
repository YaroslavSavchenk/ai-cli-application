/**
 * The New Project dialog's "add an existing folder" path (2026-09-10 user
 * report: browsing to a folder that already existed could only ever end in
 * the backend's 409). The DECISIONS are pure and live in newproject-model
 * (tests/ui-newproject.test.ts, and end to end against a real backend in
 * tests/projects.test.ts); this file pins the WIRING in
 * `web/src/ui/newproject.ts` that turns those decisions into requests:
 *
 *   - the ADD intent sends `api.createProject(body)` — the register-as-is mode
 *     of POST /api/projects — with a body that can carry neither `create` nor
 *     `gitInit` (nothing is created, nothing is initialised);
 *   - the CREATE intent keeps `api.createLocalProject({ ...body, gitInit })`;
 *   - the intent comes from `blankIntent(probeFromList(...))` over the SAME
 *     GET /api/fs/list the picker browses with, and only a browsed path is
 *     probed.
 *
 * WHY A SOURCE SCAN. newproject.ts builds its dialog against `document` and
 * imports the GitHub panel and picker; there is no DOM in this runner. Every
 * check is paired with a non-vacuity assertion so a regex that matches nothing
 * cannot pass. What the dialog LOOKS like stays manual
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const NEWPROJECT = readFileSync(join(REPO_ROOT, 'web', 'src', 'ui', 'newproject.ts'), 'utf8');

/** Source of a nested `async function <name>(): Promise<void> { … }` (4-space body, 2-space close). */
function fnBody(name: string): string {
  const m = new RegExp(`async function ${name}\\(\\): Promise<void> \\{([\\s\\S]*?)\\n  \\}\\n`).exec(NEWPROJECT);
  assert.notEqual(m, null, `newproject.ts must still define ${name}()`);
  return m?.[1] ?? '';
}

/** The argument text of the first `callee(` … matching `)` in `src`. */
function callArgs(src: string, callee: string): string {
  const at = src.indexOf(`${callee}(`);
  assert.notEqual(at, -1, `${callee}( must appear`);
  let depth = 0;
  const open = at + callee.length;
  for (let i = open; i < src.length; i += 1) {
    const c = src[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  assert.fail(`unbalanced call to ${callee}`);
}

// ---------------------------------------------------------------------------

test('the scan reads the real module (non-vacuity: the dialog, its submit and its probe are found)', () => {
  assert.ok(NEWPROJECT.length > 10000, 'ui/newproject.ts looks empty');
  assert.ok(fnBody('submitBlank').length > 200);
  assert.ok(fnBody('refreshIntent').length > 200);
  assert.match(
    NEWPROJECT,
    /import \{[^}]*\baddedProjectName\b[^}]*\bblankIntent\b[^}]*\bprobeFromList\b[^}]*\} from '\.\/newproject-model\.ts';/,
  );
});

test('ADD sends createProject( with a body that cannot carry `create` or `gitInit`; CREATE sends createLocalProject( with gitInit', () => {
  const submit = fnBody('submitBlank');
  // Exactly one call of each, chosen by the intent.
  assert.equal(submit.split('api.createProject(').length - 1, 1, 'one createProject( call');
  assert.equal(submit.split('api.createLocalProject(').length - 1, 1, 'one createLocalProject( call');
  assert.match(
    submit,
    /intent === 'add'\s*\?\s*await api\.createProject\(body\)[^\n]*\n\s*:\s*await api\.createLocalProject\(\{ \.\.\.body, gitInit \}\);/,
    'add -> createProject(body), otherwise createLocalProject({ ...body, gitInit })',
  );

  // The ADD call's object: `body` itself, no inline `create:` / `gitInit`.
  const addArgs = callArgs(submit, 'api.createProject');
  assert.equal(addArgs.trim(), 'body');
  assert.equal(/\bcreate\s*:/.test(addArgs), false);
  assert.equal(addArgs.includes('gitInit'), false);

  // …and `body` is TYPED so neither field can be put on it later.
  assert.match(submit, /const body: Omit<CreateProjectRequest, 'create' \| 'gitInit'> = \{ name, path \};/);
  // Nothing else in submitBlank writes either key onto the body.
  assert.equal(/body\.(create|gitInit)\b/.test(submit), false);

  // The CREATE call carries the git-init toggle (and createLocalProject adds create:true itself).
  assert.match(callArgs(submit, 'api.createLocalProject'), /^\{ \.\.\.body, gitInit \}$/);
});

test('ADD names the project from what was typed or the folder basename (addedProjectName), CREATE from what was typed', () => {
  const submit = fnBody('submitBlank');
  assert.match(
    submit,
    /const name =\s*intent === 'add' \? addedProjectName\(nameInput\.value, path\) : nameInput\.value\.trim\(\);/,
  );
});

test('the intent comes from probeFromList -> blankIntent over GET /api/fs/list, and only a BROWSED path is probed', () => {
  const probe = fnBody('refreshIntent');
  assert.ok(probe.includes('probeFromList(await api.fsList(path), 200)'), 'a 200 body is the probe');
  assert.ok(
    probe.includes('probeFromList(null, e instanceof api.ApiError ? e.status : null)'),
    'a failure maps its HTTP status, a network error maps to null',
  );
  assert.ok(probe.includes('intent = blankIntent(probe);'));
  // A suggested (typed-name) path is never probed: it is new by construction.
  assert.match(probe, /if \(!blankTouched \|\| path === ''\) \{\s*intent = 'create';/);
  // A stale probe (a later pick, a closed dialog, a changed path) never lands.
  assert.match(probe, /if \(seq !== probeSeq \|\| scrim\.hidden \|\| effectiveBlankPath\(\) !== path\) return;/);
  // The picker's pick is what triggers it.
  assert.match(NEWPROJECT, /blankChosen = chosen;\s*renderBlankPath\(\);\s*void refreshIntent\(\);/);
});

test('reopening the dialog resets the tab to CREATE (a previous add never leaks into the next open)', () => {
  assert.match(
    NEWPROJECT,
    /intent = 'create';\s*probeSeq \+= 1;[^\n]*\n\s*gitInit = true;\s*syncGit\(\);\s*syncIntent\(\);/,
  );
});

test('the ADD state is said in words: the button verb and the note under the path', () => {
  // Both literals are UI copy; the copy-rule scan canaries them too.
  assert.ok(NEWPROJECT.includes("adding ? 'Add this folder' : 'Create project'"));
  assert.ok(NEWPROJECT.includes("'This folder already exists. It is added as it is.'"));
  // The git-init toggle goes away while adding (an existing folder is not initialised).
  assert.match(NEWPROJECT, /function syncIntent\(\): void \{[\s\S]*?gitRow\.hidden = adding;/);
});

test('no verb is sent on a stale decision: the button is held while the pick is being probed, and for a folder that is already a project', () => {
  // The register mode of POST /api/projects does not dedupe (server-side), so
  // the dialog is the only thing between a second click and a duplicate
  // project; and a submit during the probe would send CREATE for a folder
  // about to turn out non-empty (the backend's 409, the original report).
  assert.match(
    NEWPROJECT,
    /function syncPrimary\(\): void \{\s*primary\.disabled =\s*cloning \|\| submittingBlank \|\| \(mode === 'blank' && \(probing \|\| isRegistered\(\)\)\);/,
  );
  // Every new pick starts pending, on the safe default.
  const probe = fnBody('refreshIntent');
  assert.match(probe, /intent = 'create';\s*probing = true;\s*syncIntent\(\);/);
  // …and only THIS pick's answer releases it.
  assert.match(probe, /if \(seq === probeSeq\) \{\s*probing = false;/);
  // A registered folder is matched on its exact path and said in words.
  assert.match(NEWPROJECT, /st\.state\.projects\.some\(\(p\) => p\.path === blankChosen\)/);
  assert.ok(NEWPROJECT.includes("'This folder is already a project.'"));
  // syncIntent is what re-evaluates the hold, so every intent change reaches it.
  assert.match(NEWPROJECT, /function syncIntent\(\): void \{[\s\S]*?syncPrimary\(\);\n {2}\}/);
});
