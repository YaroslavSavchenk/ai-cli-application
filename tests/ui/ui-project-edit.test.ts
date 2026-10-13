/**
 * The Edit project dialog (`web/src/ui/project-edit.ts`) and the pencil that
 * opens it in a Projects drawer row (`web/src/ui/projects.ts`), part D1
 * (`.claude/plans/nocturne/PLAN-D1.md`; user decision 2026-10-13: an Edit
 * button beside `Session` and `×`, Name / Model / Permissions / Effort).
 *
 * How: the REAL drawer and dialog on the DOM double in `tests/helpers/fake-dom.ts`,
 * with their non-pure imports stubbed (`../api.ts` records the PATCH,
 * `../state.ts` holds a projects list the test owns; the drawer's `./launch.ts`,
 * `./newproject.ts` and `./statusline.ts` — whose graphs reach xterm — are
 * stubs). `project-prefs.ts`, `project-prefs-model.ts`, `launch-args.ts`,
 * `launch-controls.ts`, `icons.ts` and `util.ts` are the real modules.
 *
 * Why it matters: Save must send ONLY what changed (a stored alias must not be
 * rewritten by an open-and-save), No preference must clear (`null`), and the
 * server's refusal must reach the user as its own sentence.
 *
 * NOT claimed: the PATCH route itself (the backend's tests), layout and
 * looks (the D1 browser screenshot), the Escape ladder in `main-shell.ts`
 * (it calls `closeProjectEdit`, exercised here).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { Project, UpdateProjectRequest } from '../../shared/protocol.ts';
import { byClass, byKey, dispatch, installDom, type FakeElement } from '../helpers/fake-dom.ts';
import { settleTimers } from '../helpers/helpers.ts';

const dom = installDom();

interface Harness {
  projects: Project[];
  patches: { id: string; patch: UpdateProjectRequest }[];
  /** What the next PATCH does; default: answers with the project patched. */
  nextAnswer: (() => Promise<Project>) | null;
}

const H: Harness = { projects: [], patches: [], nextAnswer: null };
(globalThis as unknown as Record<string, unknown>).__peHarness = H;

const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__peHarness;
    export class ApiError extends Error {
      constructor(status, message) { super(message); this.status = status; }
    }
    export async function getProjects() { return H.projects; }
    export async function deleteProject() { return { ok: true }; }
    export async function updateProject(id, patch) {
      H.patches.push({ id, patch: JSON.parse(JSON.stringify(patch)) });
      if (H.nextAnswer !== null) { const f = H.nextAnswer; H.nextAnswer = null; return f(); }
      const p = H.projects.find((x) => x.id === id);
      const out = { ...p };
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete out[k]; else out[k] = v; }
      return out;
    }`,
  state: `
    const H = globalThis.__peHarness;
    const subs = [];
    export const state = {
      get projects() { return H.projects; },
      sessions: new Map(),
      drawer: 'projects',
    };
    export function setProjects(ps) { H.projects = ps; for (const f of subs) f('projects'); }
    export function closeDrawer() {}
    export function subscribe(f) { subs.push(f); }`,
  launch: `export function openLaunchDialog() {}`,
  newproject: `export function openNewProjectDialog() {}`,
  statusline: `export function flash() {}`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    if (parent.endsWith('/web/src/ui/projects.ts') || parent.endsWith('/web/src/ui/project-edit.ts')) {
      const m = /^(?:\.\.\/(api|state)|\.\/(launch|newproject|statusline))\.ts$/.exec(specifier);
      const name = m?.[1] ?? m?.[2];
      if (name !== undefined) return { url: `pe-stub:${name}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('pe-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('pe-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

interface ProjectsModule {
  initProjectsDrawer(host: unknown): { render(): void };
}
interface EditModule {
  isProjectEditOpen(): boolean;
  closeProjectEdit(): void;
}

// Computed specifiers: the server tsconfig must not walk the browser graph.
const PD = (await import(new URL('../../web/src/ui/projects.ts', import.meta.url).href)) as ProjectsModule;
const PE = (await import(new URL('../../web/src/ui/project-edit.ts', import.meta.url).href)) as EditModule;

const modalHost = dom.doc.createElement('div');
modalHost.className = 'modal-host';
const aside = dom.doc.createElement('aside');
dom.body.append(aside, modalHost);
const drawer = PD.initProjectsDrawer(aside);

const BASE: Project = {
  id: 'p1',
  name: 'crypto',
  path: '/home/you/projects/crypto',
  defaultModel: 'fable',
  defaultMode: 'skip-permissions',
  createdAt: '2026-10-13T00:00:00Z',
};

/** Fresh drawer with one project, no dialog up. */
async function reset(p: Project = BASE): Promise<void> {
  PE.closeProjectEdit();
  H.projects = [p];
  H.patches = [];
  drawer.render();
  await settleTimers();
}

const editBtn = (): FakeElement => {
  const b = byKey(aside, 'pedit:p1');
  assert.ok(b !== null, 'the row carries an Edit button');
  return b;
};
const dialog = (): FakeElement => {
  const d = byClass(modalHost, 'pe-modal')[0];
  assert.ok(d !== undefined, 'the Edit project dialog is up');
  return d;
};
const field = (name: string): FakeElement => {
  const hit = byClass(dialog(), 'ap-field')
    .flatMap((f) => f.children)
    .find((c): c is FakeElement => (c as FakeElement).name === name);
  assert.ok(hit !== undefined, `no [name=${name}] in the dialog`);
  return hit;
};
const btn = (text: string): FakeElement => {
  const hit = byClass(dialog(), 'ap-ft')[0]?.children.find((c) => c.textContent === text) as FakeElement | undefined;
  assert.ok(hit !== undefined, `no footer button "${text}"`);
  return hit;
};
/** Choose by the option's VALUE after checking an option really carries it. */
function choose(sel: FakeElement, value: string): void {
  assert.ok(optionValues(sel).includes(value), `[name=${sel.name}] offers ${JSON.stringify(value)}`);
  sel.value = value;
  dispatch(sel, 'change');
}
function optionValues(sel: FakeElement): string[] {
  const out: string[] = [];
  const walk = (n: FakeElement): void => {
    for (const c of n.children as FakeElement[]) {
      if (c.tagName === 'OPTION') out.push(c.value);
      else if (c.tagName === 'OPTGROUP') walk(c);
    }
  };
  walk(sel);
  return out;
}
async function save(): Promise<void> {
  btn('Save').click();
  await settleTimers();
}

test('the drawer row: Session, then the pencil Edit button, then ×', async () => {
  await reset();
  const line = byClass(aside, 'proj-line')[0] as FakeElement;
  const buttons = line.children.filter((c) => (c as FakeElement).tagName === 'BUTTON') as FakeElement[];
  assert.deepEqual(buttons.map((b) => b.getAttribute('data-k')), ['pnew:p1', 'pedit:p1', 'pdel:p1']);
  const edit = editBtn();
  assert.equal(edit.getAttribute('aria-label'), 'Edit project crypto');
  assert.equal(edit.getAttribute('aria-haspopup'), 'dialog');
  assert.equal(edit.textContent, '', 'an icon button: the name is in aria-label, never a glyph in the text');
  assert.equal(edit.children.length, 1, 'one pencil glyph');
});

test('Edit opens the dialog on the project as stored: name, the alias as the model it launches, the legacy mode as No prompts', async () => {
  await reset();
  editBtn().click();
  assert.equal(PE.isProjectEditOpen(), true);
  assert.equal(byClass(dialog(), 'ap-title')[0]?.textContent, 'Edit project');
  assert.equal(dialog().getAttribute('role'), 'dialog');
  assert.equal(field('name').value, 'crypto');
  assert.equal(dom.doc.activeElement, field('name'), 'the keyboard lands in Name');
  assert.equal(field('defaultModel').value, 'claude-fable-5-1');
  assert.equal(field('defaultPerm').value, 'bypassPermissions');
  assert.ok(field('defaultPerm').classList.contains('is-danger'), 'No prompts wears the danger edge');
  assert.equal(field('defaultEffort').value, '');
});

test('the three selects open on No preference and the Model select carries the Older models group', async () => {
  await reset({ ...BASE, defaultModel: undefined, defaultMode: undefined });
  editBtn().click();
  for (const name of ['defaultModel', 'defaultPerm', 'defaultEffort']) {
    const first = field(name).children[0] as FakeElement;
    assert.equal(first.textContent, 'No preference', name);
    assert.equal(first.value, '', name);
  }
  const group = field('defaultModel').children.find((c) => (c as FakeElement).tagName === 'OPTGROUP') as
    | (FakeElement & { label?: string })
    | undefined;
  assert.equal(group?.label, 'Older models');
  assert.ok(optionValues(field('defaultModel')).includes('claude-opus-4-8'));
});

test('Save with nothing changed sends nothing and closes, the keyboard back on the Edit button', async () => {
  await reset();
  editBtn().click();
  const opener = editBtn();
  await save();
  assert.deepEqual(H.patches, [], 'no PATCH: the stored alias is not rewritten');
  assert.equal(PE.isProjectEditOpen(), false);
  assert.equal(dom.doc.activeElement, opener);
});

test('Save sends only the changed fields, and No preference as null', async () => {
  await reset({ ...BASE, defaultEffort: 'high' });
  editBtn().click();
  choose(field('defaultModel'), 'claude-opus-4-8');
  choose(field('defaultEffort'), '');
  await save();
  assert.deepEqual(H.patches, [{ id: 'p1', patch: { defaultModel: 'claude-opus-4-8', defaultEffort: null } }]);
  assert.equal(PE.isProjectEditOpen(), false);
  assert.equal(H.projects[0]?.defaultModel, 'claude-opus-4-8', 'the answer replaces the project in the state');
  assert.equal(H.projects[0]?.defaultEffort, undefined);
});

test('a permission set back to No preference clears it; a rename is trimmed', async () => {
  await reset();
  editBtn().click();
  choose(field('defaultPerm'), '');
  assert.equal(field('defaultPerm').classList.contains('is-danger'), false, 'the danger edge goes with it');
  field('name').value = '  crypto v2 ';
  await save();
  assert.deepEqual(H.patches.at(-1)?.patch, { name: 'crypto v2', defaultPerm: null });
  drawer.render(); // main-shell re-renders the drawer on every state change
  assert.equal(byClass(aside, 'proj-name')[0]?.textContent, 'crypto v2', 'the drawer shows the new name');
});

test('a blank name is refused inline and nothing is sent', async () => {
  await reset();
  editBtn().click();
  field('name').value = '   ';
  await save();
  const err = byClass(dialog(), 'ap-err')[0] as FakeElement;
  assert.equal(err.hidden, false);
  assert.equal(err.textContent, 'A project name is required.');
  assert.equal(err.getAttribute('role'), 'alert');
  assert.deepEqual(H.patches, []);
  assert.equal(PE.isProjectEditOpen(), true);
});

test('the server’s refusal is shown as its own sentence, and the form is usable again', async () => {
  await reset();
  editBtn().click();
  choose(field('defaultModel'), 'claude-opus-5-5');
  H.nextAnswer = () => Promise.reject(new Error('That project no longer exists.'));
  await save();
  const err = byClass(dialog(), 'ap-err')[0] as FakeElement;
  assert.equal(err.textContent, 'That project no longer exists.');
  assert.equal(btn('Save').disabled, false);
  assert.equal(field('defaultModel').disabled, false);
  assert.equal(PE.isProjectEditOpen(), true, 'a failed save leaves the form up to retry');
  assert.equal(H.projects[0]?.defaultModel, 'fable', 'nothing changed in the state');
});

test('Enter in Name saves; Cancel, the scrim and Escape all close without a request', async () => {
  await reset();
  editBtn().click();
  field('name').value = 'renamed';
  dispatch(field('name'), 'keydown', { key: 'Enter' });
  await settleTimers();
  assert.deepEqual(H.patches.at(-1)?.patch, { name: 'renamed' });

  await reset();
  editBtn().click();
  btn('Cancel').click();
  assert.equal(PE.isProjectEditOpen(), false);
  editBtn().click();
  dispatch(byClass(modalHost, 'pe-scrim')[0] as FakeElement, 'mousedown');
  assert.equal(PE.isProjectEditOpen(), false, 'a press on the scrim is Cancel');
  editBtn().click();
  PE.closeProjectEdit(); // what main-shell's Escape ladder calls
  assert.equal(PE.isProjectEditOpen(), false);
  assert.deepEqual(H.patches, []);
});

test('Edit reads the project fresh at click time — a preferences-only save keeps the row', async () => {
  await reset();
  editBtn().click();
  choose(field('defaultPerm'), 'plan');
  await save();
  editBtn().click();
  assert.equal(field('defaultPerm').value, 'plan', 'not the stale No prompts the row was built with');
});

test('a hand-edited unknown permission or effort shows No preference and a rename-only save leaves it alone', async () => {
  await reset({ ...BASE, defaultMode: undefined, defaultPerm: 'yolo' as never, defaultEffort: 'turbo' as never });
  editBtn().click();
  assert.equal(field('defaultPerm').value, '', 'the select shows No preference');
  assert.equal(field('defaultEffort').value, '', 'the select shows No preference');
  field('name').value = 'renamed';
  await save();
  assert.deepEqual(H.patches, [{ id: 'p1', patch: { name: 'renamed' } }], 'only the name: nothing cleared behind the user');
});

test('Enter and a Save click while the PATCH is pending send exactly one request', async () => {
  await reset();
  editBtn().click();
  let answer: (p: Project) => void = () => {};
  H.nextAnswer = () => new Promise<Project>((resolve) => { answer = resolve; });
  field('name').value = 'renamed';
  dispatch(field('name'), 'keydown', { key: 'Enter' });
  btn('Save').click();
  dispatch(field('name'), 'keydown', { key: 'Enter' });
  await settleTimers();
  assert.equal(H.patches.length, 1, 'the second and third submit are swallowed while the first is in flight');
  answer({ ...BASE, name: 'renamed' });
  await settleTimers();
  assert.equal(PE.isProjectEditOpen(), false, 'the one answer closes the dialog');
  assert.equal(H.patches.length, 1);
});
