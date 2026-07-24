/**
 * App entry: builds the shell (handoff §1 — topbar / drawers + pane grid /
 * bottom tab strip / statusline), wires the modules together, owns the
 * global keyboard chords and the session poll.
 *
 * Shell anatomy, top to bottom: 44px gradient topbar (logo tile + wordmark,
 * Theme / Projects / Sessions toggles, connected dot, + New session), the
 * middle row (projects drawer · pane grid · sessions drawer — drawers are
 * structural flex siblings, so toggling one resizes panes through the real
 * fit -> ws-resize chain), the Steam-style BOTTOM tab strip, and the 23px
 * statusline. Heights and colors live in tokens.css.
 *
 * Keyboard: app chords live EXCLUSIVELY on Ctrl+Alt (AltGr excluded via
 * getModifierState so European layouts still reach the TUI). Plain keys are
 * never touched: `?` only acts outside editable targets and Escape is
 * ignored entirely when it originates in a terminal.
 */
import '@xterm/xterm/css/xterm.css';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/app.css';
import type { UiPrefs } from '../../shared/protocol.ts';
import * as st from './state.ts';
import * as api from './api.ts';
import { initTabs } from './ui/tabs.ts';
import { initPanes, focusedConn } from './ui/panes.ts';
import { initStatusline } from './ui/statusline.ts';
import { initSessionsDrawer } from './ui/sessions.ts';
import { initProjectsDrawer } from './ui/projects.ts';
import { initShortcuts } from './ui/shortcuts.ts';
import { initTheme } from './ui/theme.ts';
import { initSettings } from './ui/settings.ts';
import { initDefaults, initStatusBar } from './ui/defaults.ts';
import {
  initLaunchDialog,
  openLaunchDialog,
  closeLaunchDialog,
  isLaunchDialogOpen,
} from './ui/launch.ts';
import {
  initNewProjectDialog,
  isNewProjectDialogOpen,
  closeNewProjectDialog,
  openNewProjectDialog,
} from './ui/newproject.ts';
import { createGithubChip, initGithub } from './ui/github.ts';
import { isFolderPickerOpen, closeFolderPicker } from './ui/picker.ts';
import { startPresence } from './ws.ts';
import { el, button } from './ui/util.ts';

const POLL_MS = 3000;
/** Boot faster than this and the boot panel never mounts — no chrome flash. */
const BOOT_PANEL_DELAY_MS = 150;

const app = document.querySelector<HTMLDivElement>('#app');
if (app === null) throw new Error('#app missing');

void boot(app);

// ---------------------------------------------------------------------------
// Boot panel (handoff §10 visual language, honest steps only)
// ---------------------------------------------------------------------------

interface BootStep {
  ok(): void;
  fail(msg: string): void;
}

interface BootPanel {
  step(label: string): BootStep;
  /** Keep the overlay up with a reload action — boot cannot continue. */
  fatal(msg: string): void;
}

/**
 * Each row resolves when its REAL async work settles — no timers, no staged
 * theater, no launcher-lifecycle fiction (the app can never witness those
 * steps). The overlay mounts only if boot is still pending after ~150ms, so
 * a warm localhost boot shows nothing; it removes itself the moment every
 * step has settled. Failures render a red × plus the message; fatal
 * failures (hydrate/auth) pin the overlay with a reload action, because a
 * rotated token means this page can never talk to the server again.
 */
function createBootPanel(): BootPanel {
  const overlay = el('div', 'boot-overlay');
  const panel = el('div', 'boot-panel');
  const brand = el('div', 'boot-brand');
  const tile = el('div', 'logo-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(el('span', 'logo-glyph', '>_'));
  brand.append(tile, el('div', 'boot-brand-name', 'AI SESSION MANAGER'));
  const card = el('div', 'boot-card');
  panel.append(brand, card);
  overlay.append(panel);

  let pending = 0;
  let fatalized = false;
  let mounted = false;
  let done = false;
  const timer = window.setTimeout(mount, BOOT_PANEL_DELAY_MS);

  function mount(): void {
    if (!mounted && !done) {
      mounted = true;
      document.body.append(overlay);
    }
  }

  function maybeFinish(): void {
    if (pending === 0 && !fatalized && !done) {
      done = true;
      clearTimeout(timer);
      overlay.remove();
    }
  }

  return {
    step(label: string): BootStep {
      pending++;
      const row = el('div', 'boot-step');
      const mark = el('span', 'boot-mark is-spin');
      mark.setAttribute('aria-hidden', 'true');
      const msg = el('span', 'boot-msg');
      msg.hidden = true;
      row.append(mark, el('span', 'boot-lb', label), msg);
      card.append(row);
      let settled = false;
      const settle = (): boolean => {
        if (settled) return false;
        settled = true;
        pending--;
        return true;
      };
      return {
        ok() {
          if (!settle()) return;
          mark.className = 'boot-mark is-ok';
          mark.textContent = '✓';
          row.classList.add('is-done');
          maybeFinish();
        },
        fail(m: string) {
          if (!settle()) return;
          mark.className = 'boot-mark is-err';
          mark.textContent = '×';
          msg.textContent = m;
          msg.hidden = false;
          maybeFinish();
        },
      };
    },
    fatal(m: string): void {
      // Callers fatal() BEFORE failing the gating step, so the overlay can
      // not have self-dismissed yet (that step is still pending).
      fatalized = true;
      mount();
      const zone = el('div', 'boot-fatal');
      zone.append(
        el('div', 'boot-fatal-msg', m),
        button('btn is-primary', 'reload', () => location.reload()),
      );
      panel.append(zone);
    },
  };
}

async function boot(root: HTMLDivElement): Promise<void> {
  const panel = createBootPanel();
  // Steps registered up front; each resolves on its own real event. They run
  // concurrently — serializing them would stretch real time for chrome.
  const stepToken = panel.step('token check');
  const stepHydrate = panel.step('hydrate sessions');
  const stepWs = panel.step('attach ws');

  // Presence FIRST: the backend's lifetime is bound to open windows, so the
  // socket must be up even when the REST boot below fails (an open window
  // must hold the backend); presence failures never block the UI. The same
  // channel measures ws latency for the statusline; a pong doubles as a
  // liveness signal. The FIRST latency event settles the ws boot step: a
  // pong = attached, a close before any pong = failed (it keeps reconnecting
  // in the background either way).
  let wsFirst = true;
  startPresence((ms) => {
    if (wsFirst) {
      wsFirst = false;
      if (ms !== null) stepWs.ok();
      else stepWs.fail('presence socket closed — reconnecting in background');
    }
    st.setWsLatency(ms);
    if (ms !== null) st.setBackendReachable(true);
  });

  // Token check doubles as the uptime fetch — GET /api/runtime is authed, so
  // its success proves the served token is current. Failure here alone is
  // non-fatal (uptime shows "—"); the hydrate step is the boot gate, and a
  // rotated token fails both.
  void api.getRuntime().then(
    (r) => {
      st.setServerStartedAt(r.startedAt);
      stepToken.ok();
    },
    (err: unknown) => stepToken.fail(err instanceof Error ? err.message : String(err)),
  );

  // Server state first: loadUi() prunes view assignments against it. Prefs
  // (theme) is joined into the SAME hydrate wait — no extra boot-panel step,
  // no reordering — but wrapped in its own .catch so a prefs-fetch failure
  // never fails hydrate or blocks the UI: the cached/default theme stands.
  let projects;
  let sessions;
  let prefs: UiPrefs | undefined;
  try {
    [projects, sessions, prefs] = await Promise.all([
      api.getProjects(),
      api.getSessions(),
      api.getPrefs().catch(() => undefined),
    ]);
  } catch (err) {
    panel.fatal(
      'backend unreachable — the server may have restarted (tokens rotate per run); relaunch from the launcher, then reload.',
    );
    stepHydrate.fail(err instanceof Error ? err.message : String(err));
    return;
  }
  stepHydrate.ok();
  st.initServer(projects, sessions);
  st.loadUi();
  buildShell(root, prefs);
  // Fire-and-forget extra — never a boot blocker: previous-run relaunch
  // offers (crash/shutdown recovery).
  void api
    .getPrevious()
    .then((list) => st.setPrevious(list))
    .catch(() => {});
}

function buildShell(root: HTMLDivElement, prefs: UiPrefs | undefined): void {
  // ---- topbar (handoff §2) -------------------------------------------------
  const topbar = el('header', 'topbar');
  const logo = el('div', 'logo-tile');
  logo.setAttribute('aria-hidden', 'true');
  logo.append(el('span', 'logo-glyph', '>_'));
  const wordmark = el('div', 'wordmark', 'AI SESSION MANAGER');

  const themeBtn = button('tb-btn', '');
  themeBtn.title = 'terminal themes';
  themeBtn.setAttribute('aria-haspopup', 'dialog');
  const swatch = el('span', 'tb-swatch');
  swatch.setAttribute('aria-hidden', 'true');
  swatch.append(
    el('span', 'tb-sw is-a'),
    el('span', 'tb-sw is-b'),
    el('span', 'tb-sw is-c'),
    el('span', 'tb-sw is-d'),
  );
  themeBtn.append(swatch, el('span', '', 'Theme'));

  const settingsBtn = button('tb-btn', 'Settings');
  settingsBtn.title = 'app settings — launch defaults, startup command, usage';
  settingsBtn.setAttribute('aria-haspopup', 'dialog');

  const projectsBtn = button('tb-btn', 'Projects', () => st.toggleDrawer('projects'));
  projectsBtn.title = 'manage projects';
  const sessionsBtn = button('tb-btn', 'Sessions', () => st.toggleDrawer('sessions'));
  sessionsBtn.title = 'sessions panel — all server sessions';
  const sessionsBadge = el('span', 'tb-attn');
  sessionsBadge.hidden = true;
  sessionsBadge.title = 'sessions awaiting input';
  sessionsBtn.append(sessionsBadge);

  const divider = el('span', 'tb-divider');
  const conn = el('div', 'tb-conn');
  const connDot = el('span', 'tb-conn-dot is-ok');
  connDot.setAttribute('aria-hidden', 'true');
  const connTxt = el('span', '', 'connected');
  conn.append(connDot, connTxt);

  // GitHub chip: live status dot + label; opens the New Project dialog on its
  // GitHub tab (honest setup panel when the feature is dormant).
  const ghChip = createGithubChip(() => openNewProjectDialog('github'));

  const newBtn = button('btn-go', '+ New session', () => openLaunchDialog());
  newBtn.title = 'launch a session (ctrl+alt+t)';

  topbar.append(logo, wordmark, el('span', 'tb-gap'), themeBtn, settingsBtn, projectsBtn, sessionsBtn, divider, conn, ghChip, newBtn);

  // ---- middle row: drawers are flex siblings of the grid --------------------
  const main = el('div', 'main');
  const projAside = el('aside', 'drawer drawer-proj');
  projAside.hidden = true;
  const grid = el('div', 'grid');
  const sessAside = el('aside', 'drawer drawer-sess');
  sessAside.hidden = true;
  main.append(projAside, grid, sessAside);

  // ---- bottom strip + statusline + modal host --------------------------------
  const strip = el('nav', 'tabstrip');
  strip.setAttribute('aria-label', 'tabs');
  const statusline = el('footer', 'statusline');
  const modalHost = el('div', 'modal-host');

  root.replaceChildren(topbar, main, strip, statusline, modalHost);

  // ---- modules ---------------------------------------------------------------
  // Launch defaults FIRST: seed the shared store from the boot prefs bag so the
  // launch dialog and settings panel read the same `defaults` (live-updated by
  // the panel, applied on the next dialog open — no reload).
  initDefaults(prefs?.defaults);
  // Status-bar toggles: same store-seeded-from-prefs pattern; the pane strips
  // and the settings preview read getStatusBar() live.
  initStatusBar(prefs?.statusBar);
  // Theme next: it applies the persisted ground/ramp onto :root before any
  // terminal is constructed, so terminals are born themed.
  const themePop = initTheme(modalHost, themeBtn, prefs);
  themeBtn.addEventListener('click', () => themePop.toggle());
  const settings = initSettings(modalHost, settingsBtn);
  settingsBtn.addEventListener('click', () => settings.toggle());
  initLaunchDialog(modalHost); // Before tabs/panes: their `+` paths open it.
  initNewProjectDialog(modalHost); // Projects-drawer `+ add` + GitHub chip open it.
  initGithub(); // one status fetch → the GitHub chip is honest from first paint.
  const tabs = initTabs(strip);
  const shortcuts = initShortcuts(modalHost);
  const status = initStatusline(statusline, {
    getFocusedConn: focusedConn,
    openShortcuts: () => shortcuts.toggle(),
  });
  const sessionsDrawer = initSessionsDrawer(sessAside);
  const projectsDrawer = initProjectsDrawer(projAside);
  // Last: its first render needs the grid mounted and sized. The dialog
  // opener is injected to avoid a panes ↔ launch import cycle.
  initPanes(grid, () => openLaunchDialog());

  function updateChrome(): void {
    const n = st.attentionCount();
    sessionsBadge.hidden = n === 0;
    sessionsBadge.textContent = String(n);
    projAside.hidden = st.state.drawer !== 'projects';
    sessAside.hidden = st.state.drawer !== 'sessions';
    sessionsBtn.classList.toggle('is-on', st.state.drawer === 'sessions');
    sessionsBtn.setAttribute('aria-pressed', st.state.drawer === 'sessions' ? 'true' : 'false');
    projectsBtn.classList.toggle('is-on', st.state.drawer === 'projects');
    projectsBtn.setAttribute('aria-pressed', st.state.drawer === 'projects' ? 'true' : 'false');
    const ok = st.state.backendReachable;
    connDot.className = `tb-conn-dot ${ok ? 'is-ok' : 'is-down'}`;
    connTxt.textContent = ok ? 'connected' : 'offline';
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
        // +shift moves the focused SESSION to the neighbor pane of its view
        // (swap); without shift only focus moves.
        if (e.shiftKey) st.moveSession(dir);
        else st.moveFocus(dir);
      } else if (k.length === 1 && k >= '1' && k <= '9') {
        e.preventDefault();
        st.setActiveViewIndex(Number(k) - 1);
      } else if ((k === 'PageUp' || k === 'PageDown') && e.shiftKey) {
        // Keyboard twin of the tab-reorder drag (shift = "move", like the
        // arrow chords). Unshifted ctrl+alt+pgup/pgdn stays untouched.
        e.preventDefault();
        st.moveActiveViewBy(k === 'PageUp' ? -1 : 1);
      } else if (k === 't' || k === 'T') {
        e.preventDefault();
        openLaunchDialog();
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
      // Priority: overlay, then popover, then dialogs, then drawer (only
      // when the drawer actually holds focus — Esc elsewhere belongs to
      // whatever has it).
      if (shortcuts.isOpen()) {
        e.preventDefault();
        shortcuts.close();
      } else if (themePop.isOpen()) {
        e.preventDefault();
        themePop.close();
      } else if (settings.isOpen()) {
        e.preventDefault();
        settings.close();
      } else if (isFolderPickerOpen()) {
        // Topmost: the folder picker can open OVER the New Project dialog.
        e.preventDefault();
        closeFolderPicker();
      } else if (isNewProjectDialogOpen()) {
        e.preventDefault();
        closeNewProjectDialog();
      } else if (isLaunchDialogOpen()) {
        e.preventDefault();
        closeLaunchDialog();
      } else if (st.state.drawer !== null && focusInOrFree(projAside, sessAside)) {
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
  // poll doubles as the backend health probe: repeated network failures flip
  // the topbar dot to offline (and the statusline item to unreachable), the
  // first success clears it.
  let pollFailures = 0;
  const poll = (): void => {
    if (fatal) return;
    void api
      .getSessions()
      .then((list) => {
        pollFailures = 0;
        st.setBackendReachable(true);
        st.setSessions(list);
      })
      .catch(() => {
        // 401/403 already took the page over via onAuthError; anything else
        // is the backend gone/unreachable. Two misses to skip one-off blips.
        pollFailures++;
        if (pollFailures >= 2) st.setBackendReachable(false);
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

/** Focus is inside one of the containers, or nowhere interesting (body/null). */
function focusInOrFree(...containers: HTMLElement[]): boolean {
  const a = document.activeElement;
  return a === null || a === document.body || containers.some((c) => c.contains(a));
}
