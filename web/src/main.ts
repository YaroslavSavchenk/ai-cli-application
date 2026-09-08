/**
 * App entry: builds the shell (handoff §1 — topbar / drawers + pane grid /
 * bottom tab strip / statusline), wires the modules together, owns the
 * global keyboard chords and the session poll.
 *
 * Shell anatomy, top to bottom: 44px gradient topbar (logo tile + wordmark,
 * then the right-hand cluster in the refreshed prototype's order — ⚙ Settings
 * icon, Theme / Projects / Sessions toggles, divider, connected dot, GitHub
 * chip, + New session), the
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
import { initPanes, focusedConn, requestTerminalFocus } from './ui/panes.ts';
import { initStatusline } from './ui/statusline.ts';
import { initSessionsDrawer } from './ui/sessions.ts';
import { initHistory } from './ui/history.ts';
import { initProjectsDrawer } from './ui/projects.ts';
import { initShortcuts } from './ui/shortcuts.ts';
import { initTheme } from './ui/theme.ts';
import { initSettings } from './ui/settings.ts';
import { initStatusLine } from './ui/statusline-model.ts';
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
import {
  applyRuntime,
  closeRestartConfirm,
  initUpdate,
  isRestartConfirmOpen,
} from './ui/update.ts';
import { createAuthLossRecovery } from './ui/restart-flow.ts';
import { isFolderPickerOpen, closeFolderPicker } from './ui/picker.ts';
import { focusOwnerOpen, isEditableTarget, shouldRefocusTerminal } from './ui/keys.ts';
import { startPresence } from './ws.ts';
import { initLogging, log } from './log.ts';
import { el, button } from './ui/util.ts';

const POLL_MS = 3000;
/**
 * How often `GET /api/runtime` is re-asked while the page is visible. It
 * carries the live "newer code is on disk" answer, which costs the backend a
 * handful of stats — a minute-scale fact on a 30 s clock, deliberately NOT
 * folded into the 3 s session poll.
 */
const RUNTIME_POLL_MS = 30000;
/** Boot faster than this and the boot panel never mounts — no chrome flash. */
const BOOT_PANEL_DELAY_MS = 150;
/**
 * Ceiling on the ONE boot row that has no failure event of its own. A presence
 * socket that neither opens nor closes (a backend that accepts the connection
 * and then answers nothing — a real state right after a restart) leaves that
 * row spinning forever, and the overlay only leaves when every row has settled:
 * a fully working app, hidden behind a spinner. This is not staged theater —
 * the row is settled with what is true at that moment, and the socket keeps
 * trying underneath.
 */
const BOOT_WS_GRACE_MS = 8000;

// FIRST: uncaught errors, unhandled rejections and the pagehide flush are
// installed before anything else runs, so a failure during boot itself still
// reaches server.log (the detached backend has no other diagnostic channel).
initLogging();

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
      // A fatal can now arrive AFTER every row has settled (a throw while the
      // shell is being built), by which point the overlay has removed itself.
      // Un-finishing it is what makes the message visible at all — without
      // this the window goes blank and says nothing.
      fatalized = true;
      done = false;
      mounted = false;
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

/**
 * Bundle identity compiled in by the `define` in vite.config.ts. A bundle built
 * WITHOUT that config (`vite build` run from web/ instead of the repo root —
 * 2026-09-08) leaves the bare identifier in place; `typeof` on an undeclared
 * identifier is the one read that cannot throw, and a correct build rewrites
 * it to `typeof "<id>"`. 'unstamped' in the boot line is the tell.
 */
const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'unstamped';

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
  try {
    startPresence((ms) => {
      // Settle FIRST, always: a throw further down this callback (state, a log
      // line) must not be able to leave the row spinning forever — the same
      // rule the token step learned on 2026-09-08.
      if (wsFirst) {
        wsFirst = false;
        if (ms !== null) stepWs.ok();
        else stepWs.fail('presence socket closed — reconnecting in background');
      }
      st.setWsLatency(ms);
      if (ms !== null) st.setBackendReachable(true);
    });
  } catch (err) {
    // `new WebSocket(url)` throws synchronously on a URL the browser refuses.
    // Unguarded that ends boot() before hydrate, leaving THREE pending rows and
    // an overlay that never goes away.
    wsFirst = false;
    const m = err instanceof Error ? err.message : String(err);
    stepWs.fail(m);
    log.error(`boot: presence socket could not be opened: ${m}`);
  }

  // Token check doubles as the uptime fetch — GET /api/runtime is authed, so
  // its success proves the served token is current. Failure here alone is
  // non-fatal (uptime shows "—"); the hydrate step is the boot gate, and a
  // rotated token fails both.
  //
  // `.then().catch()`, not `.then(ok, err)`: a throw INSIDE the success path
  // (the boot log line once threw a ReferenceError on an unstamped bundle)
  // must land in the catch and settle the step — the two-argument form let it
  // escape as an unhandled rejection and left 'token check' pending forever.
  void api
    .getRuntime()
    .then((r) => {
      st.setRuntime(r);
      applyRuntime();
      // THE line that identifies this page in server.log: which bundle is
      // running against which backend run. A stale bundle talking to a fresh
      // backend (or the reverse) is the failure mode this exists to expose.
      // serverCommit/webBuild are printed BESIDE the bundle this page is: the
      // two identities are not directly comparable (`BUILD_ID` is
      // <yyyymmdd-hhmm>-<hash>, `webBuild` is assets/index-<hash>.js), so it is
      // having both on one line that makes a stale pairing readable.
      log.info(
        `boot ui=${BUILD_ID} backend startedAt=${r.startedAt} port=${location.port === '' ? '-' : location.port} ` +
          `server=${r.serverCommit ?? '-'} serving=${r.webBuild ?? '-'} ` +
          `update=${r.update?.available === true ? (r.update.reason ?? 'yes') : 'no'}`,
      );
      stepToken.ok();
    })
    .catch((err: unknown) => {
      // Settle FIRST — the step must never depend on the log call succeeding.
      const m = err instanceof Error ? err.message : String(err);
      stepToken.fail(m);
      log.warn(`boot ui=${BUILD_ID} runtime check failed: ${m}`);
    });

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
    log.error(`boot failed: hydrate ${err instanceof Error ? err.message : String(err)}`);
    panel.fatal(
      'backend unreachable — the server may have restarted (tokens rotate per run); relaunch from the launcher, then reload.',
    );
    stepHydrate.fail(err instanceof Error ? err.message : String(err));
    return;
  }
  // Settle BEFORE the log line, for the same reason the token step does.
  stepHydrate.ok();
  log.info(`boot hydrated: ${projects.length} projects, ${sessions.length} sessions`);
  try {
    st.initServer(projects, sessions);
    st.loadUi();
    buildShell(root, prefs);
  } catch (err) {
    // Everything above has settled its row, but the ws row may still be
    // pending — a throw here would otherwise leave the overlay spinning on a
    // step that is fine, over an app that never mounted. Pin it instead.
    const m = err instanceof Error ? err.message : String(err);
    log.error(`boot failed: shell ${m}`);
    panel.fatal('the app could not start. reload to try again.');
    return;
  }
  // The shell is up and usable. From here the ws row is the only thing that
  // could still hold the overlay open, and it has no failure event of its own
  // when the socket simply hangs — so it gets a ceiling.
  window.setTimeout(() => {
    if (wsFirst) {
      wsFirst = false;
      stepWs.fail('presence socket is still connecting');
      log.warn('boot: presence socket had not answered when the app finished starting');
    }
  }, BOOT_WS_GRACE_MS);
  // Fire-and-forget extra — never a boot blocker: the session history, plus
  // the subscription that refetches it whenever a session ends, is removed,
  // or the sessions drawer opens. Its own failures are its own: the app is up.
  try {
    initHistory();
  } catch (err) {
    log.warn(`boot: history init failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function buildShell(root: HTMLDivElement, prefs: UiPrefs | undefined): void {
  // ---- topbar (handoff §2) -------------------------------------------------
  const topbar = el('header', 'topbar');
  const logo = el('div', 'logo-tile');
  logo.setAttribute('aria-hidden', 'true');
  logo.append(el('span', 'logo-glyph', '>_'));
  const wordmark = el('div', 'wordmark', 'AI SESSION MANAGER');

  // Settings: icon-only 28px gear, FIRST of the right-hand controls (refreshed
  // prototype, 2026-07-24 — superseding the earlier text button). The glyph is
  // decorative; `aria-label` carries the accessible name.
  const settingsBtn = button('tb-btn is-icon', '');
  const gear = el('span', '', '⚙');
  gear.setAttribute('aria-hidden', 'true');
  settingsBtn.append(gear);
  settingsBtn.setAttribute('aria-label', 'Settings');
  settingsBtn.title = 'settings — what each session shows in its status line';
  settingsBtn.setAttribute('aria-haspopup', 'dialog');

  // Keyboard help: the same icon-only 28px control, immediately after the gear
  // (2026-09-08). Until now the shortcuts overlay had exactly two ways in — the
  // bare `?` key and the statusline hint — and the app's newest chord (paste)
  // is the one nobody can guess, so the reference needs a control where the
  // eye already goes for app-level settings.
  const helpBtn = button('tb-btn is-icon', '');
  const qmark = el('span', '', '?');
  qmark.setAttribute('aria-hidden', 'true');
  helpBtn.append(qmark);
  helpBtn.setAttribute('aria-label', 'Keyboard shortcuts');
  helpBtn.title = 'keyboard shortcuts';
  helpBtn.setAttribute('aria-haspopup', 'dialog');

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

  topbar.append(
    logo,
    wordmark,
    el('span', 'tb-gap'),
    settingsBtn,
    helpBtn,
    themeBtn,
    projectsBtn,
    sessionsBtn,
    divider,
    conn,
    ghChip,
    newBtn,
  );

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
  // Status-line toggles FIRST: seed the shared store from the boot prefs bag so
  // the settings panel opens showing what the sessions' own status line reads
  // (the script re-reads the same key from disk on every draw).
  initStatusLine(prefs?.statusLine);
  // Theme next: it applies the persisted ground/ramp onto :root before any
  // terminal is constructed, so terminals are born themed.
  const themePop = initTheme(modalHost, themeBtn, prefs);
  themeBtn.addEventListener('click', () => themePop.toggle());
  // Update notice BEFORE settings: the panel's BACKEND section calls into it,
  // and its pill lands in the topbar cluster right after the connection dot.
  const upd = initUpdate(modalHost);
  conn.after(upd.pill);
  // `openShortcuts` is deferred on purpose: the overlay is constructed AFTER
  // this panel so its scrim stacks above it (equal z-index, later in the DOM),
  // and the panel's own KEYS section opens it over itself.
  const settings = initSettings(modalHost, settingsBtn, { openShortcuts: () => shortcuts.toggle() });
  settingsBtn.addEventListener('click', () => settings.toggle());
  initLaunchDialog(modalHost); // Before tabs/panes: their `+` paths open it.
  initNewProjectDialog(modalHost); // Projects-drawer `+ add` + GitHub chip open it.
  initGithub(); // one status fetch → the GitHub chip is honest from first paint.
  const tabs = initTabs(strip);
  // ONE overlay instance, three openers: the `?` key, this topbar button and
  // the statusline hint (plus the settings panel's `all shortcuts`).
  const shortcuts = initShortcuts(modalHost);
  helpBtn.addEventListener('click', () => shortcuts.toggle());
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
      } else if (isRestartConfirmOpen()) {
        // Topmost: it opens OVER the settings panel. During the preflight Esc
        // HIDES it and the restart runs on; once the handover has begun it
        // ignores Esc (nothing left to cancel, nothing left behind it).
        e.preventDefault();
        closeRestartConfirm();
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

  // ---- reliability: a rejected token is a QUESTION, network loss is a readout
  // Any REST 401/403 after boot means the backend this page was served by is
  // gone. That is USUALLY harmless: another window (or the update flow)
  // restarted it, and the replacement is already listening on the same port
  // with a fresh token — which a reload picks up, because index.html injects
  // it. So the page asks `/health` before it panics, and only a backend that
  // stays silent for 5 s earns the takeover panel.
  let fatal = false;
  const recoverFromAuthLoss = createAuthLossRecovery({
    health: () => api.backendHealth(),
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
    setRestarting: (v) => st.setRestarting(v),
    showProbe: () => showReconnectTakeover(),
    reload: () => location.reload(),
    showPanel: () => {
      fatal = true;
      hideReconnectTakeover();
      renderRestartPanel(root);
    },
    log: (level, line) => {
      if (level === 'error') log.error(line);
      else log.warn(line);
    },
  });
  api.onAuthError(() => {
    // A restart we asked for rotates the token BY DESIGN; the update dialog
    // owns the screen until it reloads. Tearing the page down here would
    // replace an honest progress state with a scary panic panel. The recovery
    // arms the same flag, so a 401 storm produces exactly one probe.
    if (fatal || st.state.restarting) return;
    recoverFromAuthLoss();
  });

  // ---- session poll --------------------------------------------------------
  // WS events only reach attached panes; badges for sessions hidden in other
  // tabs (and attention cleared elsewhere) reconcile through this poll. The
  // poll doubles as the backend health probe: repeated network failures flip
  // the topbar dot to offline (and the statusline item to unreachable), the
  // first success clears it.
  let pollFailures = 0;
  const poll = (): void => {
    if (fatal || st.state.restarting) return;
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

  // ---- runtime poll (uptime · version · update check) ----------------------
  // Only while the page is visible: a backgrounded window has nobody to tell.
  const runtimePoll = (): void => {
    if (fatal || st.state.restarting) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    void api
      .getRuntime()
      .then((r) => {
        st.setRuntime(r);
        applyRuntime();
      })
      .catch(() => {
        // The session poll already owns the reachable/offline readout; a
        // missed update check is simply asked again in 30 s.
      });
  };
  window.setInterval(runtimePoll, RUNTIME_POLL_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      poll();
      runtimePoll();
      refocusTerminal();
    }
  });

  // ---- focus after a window switch -----------------------------------------
  // The app window loses focus for real reasons: a `/login` link opens the
  // Windows browser, the user reads something, alt-tabs back — and the page
  // came back with the keyboard NOWHERE, so the CLI's own "paste the code
  // here" field silently took nothing (user report, 2026-09-08). Nothing else
  // in the app refocuses, so this is it: on regaining window focus, put the
  // keyboard back in the terminal UNLESS a surface that owns it is up (any
  // dialog, a drawer, an overlay, a field being typed in). BOTH halves of that
  // decision live in ui/keys.ts and are unit-tested: `focusOwnerOpen` reads
  // what is on screen (an open drawer counts even while its own topbar toggle
  // holds the focus — that button sits inside no drawer, so the element test
  // alone said yes), `shouldRefocusTerminal` reads where the focus sits.
  function refocusTerminal(): void {
    if (focusOwnerOpen(document)) return;
    const active = document.activeElement;
    if (shouldRefocusTerminal(active instanceof HTMLElement ? active : null)) {
      requestTerminalFocus();
    }
  }
  window.addEventListener('focus', refocusTerminal);
}

/**
 * The moment between "this page's token was rejected" and "the replacement
 * backend answered": a boot overlay, verbatim — same brand, same ink-well card,
 * same single spinning step row. It is not a metaphor for the boot state, it IS
 * one; the page is about to load again. Removed only if the probe fails, so the
 * panel underneath is not hidden behind it.
 */
const RECONNECT_LABEL = 'Backend restarted — reconnecting…';
let takeover: HTMLElement | null = null;

function showReconnectTakeover(): void {
  if (takeover !== null) return;
  const overlay = el('div', 'boot-overlay');
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  const panel = el('div', 'boot-panel');
  const brand = el('div', 'boot-brand');
  const tile = el('div', 'logo-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(el('span', 'logo-glyph', '>_'));
  brand.append(tile, el('div', 'boot-brand-name', 'AI SESSION MANAGER'));
  const card = el('div', 'boot-card');
  const row = el('div', 'boot-step');
  const mark = el('span', 'boot-mark is-spin');
  mark.setAttribute('aria-hidden', 'true');
  row.append(mark, el('span', 'boot-lb', RECONNECT_LABEL));
  card.append(row);
  panel.append(brand, card);
  overlay.append(panel);
  document.body.append(overlay);
  takeover = overlay;
}

function hideReconnectTakeover(): void {
  takeover?.remove();
  takeover = null;
}

/**
 * Full-page takeover after a REST 401/403 post-boot that `/health` could not
 * explain away: same panel pattern as the boot error. The app is torn down
 * deliberately — every socket and pane of this page holds a dead token, so
 * nothing behind the panel could work.
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

/**
 * Does this event target swallow typing? One rule, shared with the
 * refocus decision (ui/keys.ts) so the two can never disagree about what an
 * editable element is.
 */
function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && isEditableTarget(t);
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
