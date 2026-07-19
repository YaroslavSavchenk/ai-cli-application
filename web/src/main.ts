/**
 * App entry: builds the shell (topbar / pane grid + drawer / statusline),
 * wires the modules together, owns the global keyboard chords and the
 * session poll.
 *
 * Shell anatomy (see web/DESIGN.md): 30px topbar (brand block, tmux-style
 * tab strip, layout switcher with 1px miniature diagrams, panel toggles, ?),
 * the pane grid filling everything, 24px statusline readout. The drawer is a
 * structural sibling of the grid — opening it resizes the panes properly
 * (fit -> ws resize) instead of covering the terminal.
 *
 * Keyboard: app chords live EXCLUSIVELY on Ctrl+Alt (AltGr excluded via
 * getModifierState so European layouts still reach the TUI). Plain keys are
 * never touched: `?` only acts outside editable targets and Escape is
 * ignored entirely when it originates in a terminal.
 */
import '@xterm/xterm/css/xterm.css';
import './styles/tokens.css';
import './styles/app.css';
import * as st from './state.ts';
import * as api from './api.ts';
import { initTabs } from './ui/tabs.ts';
import { initPanes, focusedConn, openLauncher } from './ui/panes.ts';
import { initStatusline, setBackendReachable } from './ui/statusline.ts';
import { initSessionsDrawer } from './ui/sessions.ts';
import { initProjectsDrawer } from './ui/projects.ts';
import { initShortcuts } from './ui/shortcuts.ts';
import { startPresence } from './ws.ts';
import { el, button } from './ui/util.ts';

const POLL_MS = 3000;

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) throw new Error('#app missing');

void boot(app);

async function boot(root: HTMLDivElement): Promise<void> {
  // Presence FIRST: the backend's lifetime is bound to open windows, so the
  // socket must be up even when the REST boot below fails (an open window
  // must hold the backend); presence failures never block the UI.
  startPresence();
  // Server state first: loadUi() prunes pane assignments against it.
  let projects;
  let sessions;
  try {
    [projects, sessions] = await Promise.all([api.getProjects(), api.getSessions()]);
  } catch (err) {
    renderBootError(root, err);
    return;
  }
  st.initServer(projects, sessions);
  st.loadUi();
  buildShell(root);
  // Previous-run relaunch offers (crash/shutdown recovery). Fire-and-forget:
  // the offer list is a bonus, never a boot blocker.
  void api
    .getPrevious()
    .then((list) => st.setPrevious(list))
    .catch(() => {});
}

function renderBootError(root: HTMLDivElement, err: unknown): void {
  const box = el('div', 'boot-err');
  box.append(el('div', 'boot-err-hd', 'backend unreachable'));
  box.append(el('div', 'boot-err-msg', err instanceof Error ? err.message : String(err)));
  box.append(
    el(
      'div',
      'boot-err-msg',
      'the server may have restarted (tokens rotate per run) — relaunch from the launcher, then reload.',
    ),
  );
  box.append(button('btn is-primary', 'reload', () => location.reload()));
  root.replaceChildren(box);
}

function buildShell(root: HTMLDivElement): void {
  // ---- topbar --------------------------------------------------------------
  const topbar = el('header', 'topbar');
  const brand = el('div', 'brand', 'ai·sm');
  const strip = el('nav', 'tabstrip');
  strip.setAttribute('aria-label', 'tabs');

  const laySwitch = el('div', 'layswitch');
  laySwitch.setAttribute('role', 'group');
  laySwitch.setAttribute('aria-label', 'pane layout');
  const layBtns = new Map<st.Layout, HTMLButtonElement>();
  const layDefs: { layout: st.Layout; label: string }[] = [
    { layout: 1, label: '1 pane' },
    { layout: 2, label: '2 panes side by side' },
    { layout: 3, label: '3 panes — one large, two stacked' },
    { layout: 4, label: '4 panes in a 2×2 grid' },
  ];
  for (const d of layDefs) {
    const b = button('laybtn', '', () => st.setLayout(d.layout));
    b.setAttribute('aria-label', `layout: ${d.label}`);
    b.title = `layout: ${d.label}`;
    const mini = el('span', `mini mini-${d.layout}`);
    const cells = d.layout === 3 ? 3 : d.layout;
    for (let i = 0; i < cells; i++) mini.append(el('i'));
    b.append(mini);
    layBtns.set(d.layout, b);
    laySwitch.append(b);
  }

  const actions = el('div', 'topbar-actions');
  const sessionsBtn = button('tb-btn', 'sessions', () => st.toggleDrawer('sessions'));
  sessionsBtn.title = 'sessions panel — all server sessions';
  const sessionsBadge = el('span', 'badge-attn tb-badge');
  sessionsBadge.hidden = true;
  sessionsBtn.append(sessionsBadge);
  const projectsBtn = button('tb-btn', 'projects', () => st.toggleDrawer('projects'));
  projectsBtn.title = 'manage projects';
  const helpBtn = button('tb-btn tb-help', '?', () => shortcuts.toggle());
  helpBtn.title = 'keyboard shortcuts (? or ctrl+alt+/)';
  helpBtn.setAttribute('aria-label', 'keyboard shortcuts');
  actions.append(sessionsBtn, projectsBtn, helpBtn);

  topbar.append(brand, strip, laySwitch, actions);

  // ---- main row: grid + drawer --------------------------------------------
  const main = el('div', 'main');
  const grid = el('div', 'grid');
  const drawer = el('aside', 'drawer');
  drawer.hidden = true;
  main.append(grid, drawer);

  // ---- statusline + modal host --------------------------------------------
  const statusline = el('footer', 'statusline');
  const modalHost = el('div', 'modal-host');

  root.replaceChildren(topbar, main, statusline, modalHost);

  // ---- modules -------------------------------------------------------------
  const tabs = initTabs(strip);
  const status = initStatusline(statusline, { getFocusedConn: focusedConn });
  const sessionsDrawer = initSessionsDrawer(drawer);
  const projectsDrawer = initProjectsDrawer(drawer, modalHost);
  const shortcuts = initShortcuts(modalHost);
  initPanes(grid); // Last: its first render needs the grid mounted and sized.

  function updateChrome(): void {
    const t = st.activeTab();
    for (const [layout, b] of layBtns) {
      b.classList.toggle('is-active', t.layout === layout);
      b.setAttribute('aria-pressed', t.layout === layout ? 'true' : 'false');
    }
    const n = st.attentionCount();
    sessionsBadge.hidden = n === 0;
    sessionsBadge.textContent = String(n);
    drawer.hidden = st.state.drawer === null;
    sessionsBtn.classList.toggle('is-on', st.state.drawer === 'sessions');
    sessionsBtn.setAttribute('aria-pressed', st.state.drawer === 'sessions' ? 'true' : 'false');
    projectsBtn.classList.toggle('is-on', st.state.drawer === 'projects');
    projectsBtn.setAttribute('aria-pressed', st.state.drawer === 'projects' ? 'true' : 'false');
  }

  st.subscribe(() => {
    // Every renderer is cheap or signature-guarded; dispatch coarsely.
    updateChrome();
    tabs.render();
    status.render();
    sessionsDrawer.render();
    projectsDrawer.render();
  });
  updateChrome();
  tabs.render();
  status.render();
  sessionsDrawer.render();
  projectsDrawer.render();

  // ---- global keyboard -----------------------------------------------------
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && !e.metaKey && !e.getModifierState('AltGraph')) {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault();
        const dir =
          k === 'ArrowLeft' ? 'left' : k === 'ArrowRight' ? 'right' : k === 'ArrowUp' ? 'up' : 'down';
        // +shift moves the focused pane's SESSION (swap with the neighbor);
        // without shift only focus moves.
        if (e.shiftKey) st.moveSession(dir);
        else st.moveFocus(dir);
      } else if (k.length === 1 && k >= '1' && k <= '9') {
        e.preventDefault();
        st.setActiveTabIndex(Number(k) - 1);
      } else if (k === 't' || k === 'T') {
        e.preventDefault();
        st.addTab();
      } else if (k === 'Enter') {
        e.preventDefault();
        openLauncher();
      } else if (k === '/') {
        e.preventDefault();
        shortcuts.toggle();
      }
      return;
    }
    if (e.key === '?' && !e.ctrlKey && !e.altKey && !e.metaKey && !isEditable(e.target)) {
      e.preventDefault();
      shortcuts.toggle();
      return;
    }
    if (e.key === 'Escape' && !fromTerminal(e.target)) {
      // Priority: overlay, then dialog, then drawer (only when the drawer
      // actually holds focus — Esc elsewhere belongs to whatever has it).
      if (shortcuts.isOpen()) {
        e.preventDefault();
        shortcuts.close();
      } else if (projectsDrawer.modalOpen()) {
        e.preventDefault();
        projectsDrawer.closeModal();
      } else if (st.state.drawer !== null && focusInOrFree(drawer)) {
        e.preventDefault();
        st.closeDrawer();
      }
    }
  });

  // ---- reliability: token rotation is fatal, network loss is a readout ----
  // Any REST 401/403 after boot means the backend restarted (token rotated;
  // this page can never re-auth) — full-page takeover, reload is the cure.
  let fatal = false;
  api.onAuthError(() => {
    if (fatal) return;
    fatal = true;
    renderRestartPanel(root);
  });

  // ---- session poll --------------------------------------------------------
  // WS events only reach attached panes; badges for sessions hidden in other
  // tabs (and attention cleared elsewhere) reconcile through this poll. The
  // poll doubles as the backend health probe: repeated network failures show
  // the statusline readout, the first success clears it.
  let pollFailures = 0;
  const poll = (): void => {
    if (fatal) return;
    void api
      .getSessions()
      .then((list) => {
        pollFailures = 0;
        setBackendReachable(true);
        st.setSessions(list);
      })
      .catch(() => {
        // 401/403 already took the page over via onAuthError; anything else
        // is the backend gone/unreachable. Two misses to skip one-off blips.
        pollFailures++;
        if (pollFailures >= 2) setBackendReachable(false);
      });
  };
  window.setInterval(poll, POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') poll();
  });
}

/**
 * Full-page takeover after a REST 401/403 post-boot: same panel pattern as
 * the boot error. The app is torn down deliberately — every socket and pane
 * of this page holds a dead token, so nothing behind the panel could work.
 */
function renderRestartPanel(root: HTMLDivElement): void {
  const box = el('div', 'boot-err');
  box.append(el('div', 'boot-err-hd', 'backend restarted — reload'));
  box.append(
    el(
      'div',
      'boot-err-msg',
      'the auth token rotated with the restart, so this page can no longer reach the server. reload to reattach.',
    ),
  );
  box.append(button('btn is-primary', 'reload', () => location.reload()));
  root.replaceChildren(box);
}

function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    t.isContentEditable
  );
}

/** True when the event originates inside an xterm instance — its keys are sacred. */
function fromTerminal(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && t.closest('.term-host') !== null;
}

/** Focus is inside `container`, or nowhere interesting (body/null). */
function focusInOrFree(container: HTMLElement): boolean {
  const a = document.activeElement;
  return a === null || a === document.body || container.contains(a);
}
