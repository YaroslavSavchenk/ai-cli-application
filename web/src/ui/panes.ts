/**
 * Pane grid for the ACTIVE tab. Each tab is a grid of 1-4 pane slots; a
 * slot is either empty (session launcher) or a view onto a server-side
 * session (thin header + xterm). Sessions exist independently of panes —
 * this module only attaches/detaches views.
 *
 * Terminals exist only for visible slots of the active tab; switching tabs
 * or layouts disposes and re-attaches (the server replays the full buffer).
 * An xterm instance is mounted in EVERY visible slot — for empty slots it
 * sits under the launcher and provides the cols/rows measurement
 * (FitAddon.proposeDimensions) used when creating the session.
 */
import type { CreateSessionRequest, SessionInfo } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import type { ConnState } from '../ws.ts';
import { TerminalView, type TerminalEvents } from './terminal.ts';
import { el, button, armButton } from './util.ts';
import { flash } from './statusline.ts';

type Preset = 'claude' | 'claude-skip' | 'custom';

interface LauncherRefs {
  form: HTMLFormElement;
  project: HTMLSelectElement;
  presets: HTMLInputElement[];
  commandField: HTMLElement;
  command: HTMLInputElement;
  modelField: HTMLElement;
  model: HTMLInputElement;
  resumeField: HTMLElement;
  resume: HTMLSelectElement;
  title: HTMLInputElement;
  submit: HTMLButtonElement;
  err: HTMLElement;
  none: HTMLElement;
}

interface Slot {
  index: number;
  root: HTMLElement;
  attn: HTMLElement;
  proj: HTMLElement;
  title: HTMLElement;
  status: HTMLElement;
  connChip: HTMLElement;
  detachBtn: HTMLButtonElement;
  killBtn: HTMLButtonElement;
  note: HTMLElement;
  termHost: HTMLElement;
  launcher: LauncherRefs;
  view: TerminalView | null;
  sessionId: string | null;
  conn: ConnState | null;
  exitCode: number | null;
  dead: boolean;
}

let grid: HTMLElement;
let slots: Slot[] = [];
let renderedTabId = '';
let renderedLayout = 0;
let lastFocusKey = '';

// --------------------------------------------------------------------------
// Public API
// --------------------------------------------------------------------------

export function initPanes(gridEl: HTMLElement): void {
  grid = gridEl;
  st.subscribe((kind) => {
    if (kind === 'ui') render();
    else if (kind === 'sessions') {
      for (const s of slots) {
        updateHeader(s);
        updateNote(s);
      }
    } else if (kind === 'projects') {
      for (const s of slots) populateProjects(s.launcher);
    }
  });
  // Regaining window focus while a pane with attention is focused clears it.
  window.addEventListener('focus', () => {
    const s = slots[st.activeTab().focused];
    if (s !== undefined) clearAttentionIfPending(s);
  });
  render();
}

/** Connection state of the focused pane's session view (for the statusline). */
export function focusedConn(): ConnState | null {
  const s = slots[st.activeTab().focused];
  return s !== undefined && s.sessionId !== null ? s.conn : null;
}

/** Focus the terminal of the focused slot (used after drawer attach). */
export function requestTerminalFocus(): void {
  const s = slots[st.activeTab().focused];
  if (s !== undefined && s.view !== null && s.sessionId !== null) s.view.focus();
}

/** Ctrl+Alt+Enter: open the launcher of the focused pane (visible UI equivalent: the form itself). */
export function openLauncher(): void {
  const s = slots[st.activeTab().focused];
  if (s === undefined) return;
  if (s.sessionId !== null) {
    flash('pane occupied — detach it first');
    return;
  }
  s.launcher.project.focus();
}

// --------------------------------------------------------------------------
// Rendering / reconciliation
// --------------------------------------------------------------------------

function render(): void {
  const tab = st.activeTab();
  if (tab.id !== renderedTabId || tab.layout !== renderedLayout) {
    rebuild(tab);
  } else {
    for (let i = 0; i < slots.length; i++) reconcileSlot(i, tab.panes[i] ?? null);
  }
  applyFocus();
}

function rebuild(tab: st.TabState): void {
  for (const s of slots) s.view?.dispose();
  slots = [];
  renderedTabId = tab.id;
  renderedLayout = tab.layout;
  lastFocusKey = '';
  grid.dataset.layout = String(tab.layout);
  grid.replaceChildren();
  for (let i = 0; i < tab.layout; i++) {
    // createSlot appends its root to the grid BEFORE constructing the
    // TerminalView — xterm must open on an attached, measurable node.
    slots.push(createSlot(i));
  }
  for (let i = 0; i < slots.length; i++) reconcileSlot(i, tab.panes[i] ?? null);
}

function reconcileSlot(index: number, sessionId: string | null): void {
  const s = slots[index];
  if (s === undefined || s.sessionId === sessionId) {
    if (s !== undefined) {
      updateHeader(s);
      updateNote(s);
    }
    return;
  }
  s.sessionId = sessionId;
  s.conn = null;
  s.exitCode = null;
  s.dead = false;
  if (sessionId !== null) {
    // Reuse a never-connected terminal (it measured this very container);
    // otherwise start clean.
    if (s.view === null || s.view.connected) {
      s.view?.dispose();
      s.termHost.replaceChildren();
      s.view = new TerminalView(s.termHost);
    }
    s.launcher.form.hidden = true;
    s.view.connect(sessionId, slotEvents(s, sessionId));
  } else {
    s.view?.dispose();
    s.termHost.replaceChildren();
    s.view = new TerminalView(s.termHost);
    s.launcher.form.hidden = false;
    resetLauncher(s.launcher);
  }
  updateHeader(s);
  updateNote(s);
}

function slotEvents(s: Slot, sessionId: string): TerminalEvents {
  return {
    onInfo: (info: SessionInfo) => st.upsertSession(info),
    onExit: (exitCode) => {
      s.exitCode = exitCode;
      st.markExited(sessionId, exitCode);
      updateNote(s);
    },
    onAttention: () => {
      const tab = st.activeTab();
      if (tab.id === renderedTabId && tab.focused === s.index && document.hasFocus()) {
        // Attention arrived on the focused pane: acknowledge immediately.
        ackSeen(s, sessionId);
      } else {
        st.setAttention(sessionId, true);
      }
    },
    onConn: (conn) => {
      s.conn = conn;
      if (conn === 'dead') s.dead = true;
      updateHeader(s);
      updateNote(s);
      st.notify('conn');
    },
    onDims: (cols, rows) => st.setSessionDims(sessionId, cols, rows),
  };
}

function applyFocus(): void {
  const tab = st.activeTab();
  for (const s of slots) s.root.classList.toggle('focused', s.index === tab.focused);
  const key = `${tab.id}:${tab.focused}`;
  if (key === lastFocusKey) return;
  lastFocusKey = key;
  const s = slots[tab.focused];
  if (s === undefined) return;
  if (s.view !== null && s.sessionId !== null) s.view.focus();
  else s.root.focus(); // Empty pane: keyboard must not keep typing into the previous terminal.
  clearAttentionIfPending(s);
}

function clearAttentionIfPending(s: Slot): void {
  if (s.sessionId === null) return;
  const info = st.state.sessions.get(s.sessionId);
  if (info !== undefined && info.attention) ackSeen(s, s.sessionId);
}

function ackSeen(s: Slot, sessionId: string): void {
  // Both channels per spec; both are idempotent server-side.
  s.view?.sendSeen();
  void api.markSeen(sessionId).catch(() => {});
  st.setAttention(sessionId, false);
}

// --------------------------------------------------------------------------
// Slot DOM
// --------------------------------------------------------------------------

function createSlot(index: number): Slot {
  const root = el('section', 'pane');
  root.tabIndex = -1;
  root.dataset.slot = String(index);

  const hd = el('header', 'pane-hd');
  const mark = el('span', 'focus-mark');
  mark.title = 'focused pane';
  const attn = el('span', 'badge-attn', '!');
  attn.hidden = true;
  attn.title = 'session wants attention';
  const proj = el('span', 'pane-proj');
  const title = el('span', 'pane-title');
  const status = el('span', 'pane-status');
  const connChip = el('span', 'pane-conn');
  connChip.hidden = true;
  const gap = el('span', 'pane-gap');
  const detachBtn = button('pane-btn', 'detach');
  detachBtn.title = 'detach view (session keeps running)';
  const killBtn = button('pane-btn is-danger', 'kill');
  killBtn.title = 'kill session (asks to confirm)';
  hd.append(mark, attn, proj, title, status, connChip, gap, detachBtn, killBtn);

  const note = el('div', 'pane-note');
  note.hidden = true;

  const body = el('div', 'pane-body');
  const termHost = el('div', 'term-host');
  const launcher = buildLauncher(index);
  body.append(termHost, launcher.form);

  root.append(hd, note, body);
  root.addEventListener('mousedown', () => st.focusPane(index), true);
  grid.append(root); // Attach before TerminalView so xterm opens on a live node.

  const slot: Slot = {
    index,
    root,
    attn,
    proj,
    title,
    status,
    connChip,
    detachBtn,
    killBtn,
    note,
    termHost,
    launcher,
    view: new TerminalView(termHost),
    sessionId: null,
    conn: null,
    exitCode: null,
    dead: false,
  };

  detachBtn.addEventListener('click', () => {
    if (slot.sessionId !== null) st.assignPane(renderedTabId, index, null);
  });
  armButton(killBtn, 'sure?', () => {
    if (slot.sessionId !== null) void killSession(slot.sessionId);
  });

  populateProjects(launcher);
  return slot;
}

/** DELETE a session and clear every pane referencing it (also used by the sessions drawer). */
export async function killSession(id: string): Promise<void> {
  try {
    await api.deleteSession(id);
    st.removeSessionEverywhere(id);
  } catch (err) {
    if (err instanceof api.ApiError && err.status === 404) {
      st.removeSessionEverywhere(id);
      return;
    }
    flash(`kill failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function updateHeader(s: Slot): void {
  const info = s.sessionId !== null ? st.state.sessions.get(s.sessionId) : undefined;
  if (s.sessionId === null) {
    s.proj.textContent = '';
    s.title.textContent = 'empty';
    s.title.classList.add('is-empty');
    s.status.textContent = '';
    s.status.className = 'pane-status';
    s.attn.hidden = true;
    s.connChip.hidden = true;
    s.detachBtn.hidden = true;
    s.killBtn.hidden = true;
    return;
  }
  s.title.classList.remove('is-empty');
  const pname = st.projectName(info?.projectId);
  s.proj.textContent = pname ?? '·';
  s.title.textContent = info?.title ?? s.sessionId.slice(0, 8);
  if (info === undefined || info.status === 'running') {
    s.status.textContent = 'running';
    s.status.className = 'pane-status is-ok';
  } else {
    const code = info.exitCode ?? 0;
    s.status.textContent = `exit ${code}`;
    s.status.className = `pane-status ${code === 0 ? '' : 'is-danger'}`;
  }
  s.attn.hidden = info === undefined || !info.attention;
  if (s.conn === null || s.conn === 'live') {
    s.connChip.hidden = true;
  } else {
    s.connChip.hidden = false;
    s.connChip.textContent = s.conn === 'dead' ? 'lost' : `${s.conn}…`;
    s.connChip.className = `pane-conn ${s.conn === 'dead' ? 'is-danger' : 'is-warn'}`;
  }
  s.detachBtn.hidden = false;
  s.killBtn.hidden = false;
}

function updateNote(s: Slot): void {
  if (s.sessionId === null) {
    s.note.hidden = true;
    return;
  }
  if (s.dead) {
    // Reconnect exhausted and the server does not know the session anymore.
    s.note.hidden = false;
    s.note.className = 'pane-note is-dead';
    s.note.replaceChildren(
      el('span', 'pane-note-text', 'session gone from server'),
      button('pane-note-btn', 'clear pane', () => st.assignPane(renderedTabId, s.index, null)),
    );
    return;
  }
  if (s.exitCode !== null) {
    // Structural exited banner; the buffer below stays readable.
    s.note.hidden = false;
    s.note.className = `pane-note ${s.exitCode === 0 ? 'is-exit' : 'is-exit-err'}`;
    const delBtn = button('pane-note-btn', 'delete session');
    armButton(delBtn, 'sure?', () => {
      if (s.sessionId !== null) void killSession(s.sessionId);
    });
    s.note.replaceChildren(
      el('span', 'pane-note-text', `exited · code ${s.exitCode}`),
      button('pane-note-btn', 'detach', () => st.assignPane(renderedTabId, s.index, null)),
      delBtn,
    );
    return;
  }
  s.note.hidden = true;
}

// --------------------------------------------------------------------------
// Launcher (empty-pane new-session form)
// --------------------------------------------------------------------------

function buildLauncher(index: number): LauncherRefs {
  const form = el('form', 'launcher') as HTMLFormElement;

  const hd = el('div', 'launcher-hd', 'new session');

  const projField = el('label', 'field');
  projField.append(el('span', 'field-lb', 'project'));
  const project = el('select') as HTMLSelectElement;
  project.name = 'project';
  projField.append(project);

  const presetSet = el('fieldset', 'preset-set');
  presetSet.append(el('legend', 'field-lb', 'preset'));
  const presets: HTMLInputElement[] = [];
  const presetDefs: { value: Preset; label: string }[] = [
    { value: 'claude', label: 'claude' },
    { value: 'claude-skip', label: 'claude · skip-permissions' },
    { value: 'custom', label: 'custom' },
  ];
  for (const def of presetDefs) {
    const lb = el('label', 'preset-opt');
    const input = el('input') as HTMLInputElement;
    input.type = 'radio';
    input.name = `preset-${index}`;
    input.value = def.value;
    if (def.value === 'claude') input.checked = true;
    lb.append(input, el('span', '', def.label));
    presets.push(input);
    presetSet.append(lb);
  }

  const commandField = el('label', 'field');
  commandField.hidden = true;
  const cmdLb = el('span', 'field-lb', 'command ');
  cmdLb.append(el('em', 'field-hint', 'whitespace split — no quoting, no shell'));
  const command = el('input') as HTMLInputElement;
  command.name = 'command';
  command.placeholder = 'htop --tree';
  command.spellcheck = false;
  commandField.append(cmdLb, command);

  const modelField = el('label', 'field');
  const modelLb = el('span', 'field-lb', 'model ');
  modelLb.append(el('em', 'field-hint', 'optional — sent as --model'));
  const model = el('input') as HTMLInputElement;
  model.name = 'model';
  model.placeholder = 'opus';
  model.spellcheck = false;
  modelField.append(modelLb, model);

  const resumeField = el('label', 'field');
  const resumeLb = el('span', 'field-lb', 'resume ');
  resumeLb.append(el('em', 'field-hint', 'continue a previous conversation'));
  const resume = el('select') as HTMLSelectElement;
  resume.name = 'resume';
  const resumeDefs: { value: string; label: string }[] = [
    { value: '', label: 'off — new conversation' },
    { value: '-c', label: 'continue last · -c' },
    { value: '--resume', label: 'pick conversation · --resume' },
  ];
  for (const def of resumeDefs) {
    const opt = el('option', '', def.label) as HTMLOptionElement;
    opt.value = def.value;
    resume.append(opt);
  }
  resumeField.append(resumeLb, resume);

  const titleField = el('label', 'field');
  const titleLb = el('span', 'field-lb', 'title ');
  titleLb.append(el('em', 'field-hint', 'optional'));
  const title = el('input') as HTMLInputElement;
  title.name = 'title';
  title.spellcheck = false;
  titleField.append(titleLb, title);

  const actions = el('div', 'launcher-actions');
  const submit = el('button', 'btn is-primary', 'launch') as HTMLButtonElement;
  submit.type = 'submit';
  const attach = button('btn', 'attach existing…', () => st.toggleDrawer('sessions'));
  attach.title = 'open the sessions panel';
  actions.append(submit, attach);

  const err = el('div', 'launcher-err');
  err.setAttribute('role', 'alert');
  err.hidden = true;

  const none = el('div', 'launcher-none');
  none.hidden = true;
  none.append(
    el('span', '', 'no projects yet — '),
    button('btn-link', 'add one', () => st.toggleDrawer('projects')),
  );

  form.append(
    hd,
    projField,
    presetSet,
    commandField,
    modelField,
    resumeField,
    titleField,
    actions,
    err,
    none,
  );

  const refs: LauncherRefs = {
    form,
    project,
    presets,
    commandField,
    command,
    modelField,
    model,
    resumeField,
    resume,
    title,
    submit,
    err,
    none,
  };

  for (const p of presets) {
    p.addEventListener('change', () => applyPresetVisibility(refs));
  }
  project.addEventListener('change', () => applyProjectDefaults(refs));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    void launch(index, refs);
  });
  return refs;
}

function currentPreset(refs: LauncherRefs): Preset {
  const checked = refs.presets.find((p) => p.checked);
  return (checked?.value as Preset | undefined) ?? 'claude';
}

function applyPresetVisibility(refs: LauncherRefs): void {
  const preset = currentPreset(refs);
  refs.commandField.hidden = preset !== 'custom';
  refs.model.disabled = preset === 'custom';
  refs.modelField.classList.toggle('is-disabled', preset === 'custom');
  refs.resume.disabled = preset === 'custom';
  refs.resumeField.classList.toggle('is-disabled', preset === 'custom');
}

function applyProjectDefaults(refs: LauncherRefs): void {
  const p = st.state.projects.find((p) => p.id === refs.project.value);
  if (p === undefined) return;
  if (p.defaultModel !== undefined && refs.model.value === '') refs.model.value = p.defaultModel;
  if (p.defaultMode === 'skip-permissions') {
    const skip = refs.presets.find((r) => r.value === 'claude-skip');
    if (skip !== undefined && currentPreset(refs) === 'claude') {
      skip.checked = true;
      applyPresetVisibility(refs);
    }
  }
}

function populateProjects(refs: LauncherRefs): void {
  const prev = refs.project.value;
  refs.project.replaceChildren();
  for (const p of st.state.projects) {
    const opt = el('option', '', p.name) as HTMLOptionElement; // names only, never paths
    opt.value = p.id;
    refs.project.append(opt);
  }
  if (st.state.projects.some((p) => p.id === prev)) refs.project.value = prev;
  const empty = st.state.projects.length === 0;
  refs.submit.disabled = empty;
  refs.none.hidden = !empty;
}

function resetLauncher(refs: LauncherRefs): void {
  refs.err.hidden = true;
  refs.command.value = '';
  refs.resume.value = '';
  refs.title.value = '';
  populateProjects(refs);
  applyPresetVisibility(refs);
}

async function launch(index: number, refs: LauncherRefs): Promise<void> {
  refs.err.hidden = true;
  const tabId = renderedTabId; // Captured: the user may switch tabs mid-await.
  const slot = slots[index];
  if (slot === undefined) return;

  const projectId = refs.project.value;
  if (projectId === '') {
    showErr(refs, 'pick a project (add one in the projects panel)');
    return;
  }
  const preset = currentPreset(refs);
  let command: string;
  let args: string[];
  if (preset === 'custom') {
    // Plain whitespace split by design: no quoting, no escaping, no shell
    // parsing — the backend spawns argv directly. Documented in the field.
    const parts = refs.command.value.trim().split(/\s+/).filter((p) => p !== '');
    if (parts.length === 0) {
      showErr(refs, 'command is required for the custom preset');
      return;
    }
    command = parts[0] as string;
    args = parts.slice(1);
  } else {
    command = 'claude';
    args = preset === 'claude-skip' ? ['--dangerously-skip-permissions'] : [];
    if (refs.resume.value !== '') args.push(refs.resume.value); // '-c' | '--resume'
    const model = refs.model.value.trim();
    if (model !== '') args.push('--model', model);
  }

  // Measure the pane the session will live in, before creating it.
  const dims = slot.view !== null ? slot.view.proposeDims() : { cols: 80, rows: 24 };
  const titleValue = refs.title.value.trim();
  const req: CreateSessionRequest = {
    projectId,
    command,
    args,
    ...(titleValue !== '' ? { title: titleValue } : {}),
    cols: dims.cols,
    rows: dims.rows,
  };

  refs.submit.disabled = true;
  try {
    const info = await api.createSession(req);
    st.upsertSession(info);
    st.assignPane(tabId, index, info.id);
    if (st.state.activeTabId === tabId) {
      st.focusPane(index);
      requestTerminalFocus();
    }
  } catch (err) {
    showErr(refs, err instanceof Error ? err.message : String(err));
  } finally {
    refs.submit.disabled = st.state.projects.length === 0;
  }
}

function showErr(refs: LauncherRefs, msg: string): void {
  refs.err.textContent = msg;
  refs.err.hidden = false;
}
