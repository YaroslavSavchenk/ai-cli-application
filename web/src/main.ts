/**
 * App entry: builds the shell (handoff §1 — topbar / drawers + pane grid /
 * bottom tab strip / statusline), wires the modules together, owns the
 * global keyboard chords and the session poll.
 *
 * Shell anatomy, top to bottom (Nocturne A2): a 48px top bar — logo tile +
 * wordmark, hairline, the Files / Projects / Sessions toggles, spacer,
 * connection readout with the update pill, hairline, GitHub account chip,
 * Settings, New session — the middle row (projects drawer, pane grid,
 * sessions drawer; drawers are structural flex siblings, so toggling one
 * resizes panes through the real fit -> ws-resize chain; since A5 the Files
 * panel is a third one, between the projects drawer and the grid), the 32px tab strip,
 * and the 26px statusline. Heights and colors live in tokens.css.
 *
 * A2 removed two top-bar controls: the Theme button (Nocturne is the only
 * theme; A8 deleted its popover, and since B9 what is left of ui/theme.ts is
 * driven by the Terminal colours Settings page) and the `?` help
 * button (the shortcuts overlay stays reachable through the `?` key, the
 * statusline's "Keyboard shortcuts" button and the settings panel).
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
import {
  initPanes,
  killSession,
  refreshPaneArea,
  repaintStatus,
  requestTerminalFocus,
} from './ui/panes.ts';
import { flash, initStatusline } from './ui/statusline.ts';
import { initSessionsDrawer } from './ui/sessions.ts';
import { initHistory } from './ui/history.ts';
import { initProjectsDrawer } from './ui/projects.ts';
import {
  destinationOfActiveView,
  destinationOfPane,
  filesPanelDestination,
  initFilesPanel,
  listingFor,
  pasteDestination,
  refreshAfterDrop,
  selectedFolder,
} from './ui/files.ts';
import { initFileDrop, installDropGuard, type DropRequest } from './ui/filedrop.ts';
import { createDropRun } from './ui/drop-upload.ts';
import { initCommitView } from './ui/commit-view.ts';
import { setCommitGateway } from './ui/commit-store.ts';
import { setEditorGateway } from './ui/editor-store.ts';
import {
  closeActiveTabGuarded,
  disarmUnloadGuard,
  discardDialogEscape,
  isDiscardDialogOpen,
  unloadGuard,
} from './ui/unsaved.ts';
import { flashMoveTabResult, flashOpenResult } from './ui/dnd.ts';
import { initShortcuts } from './ui/shortcuts.ts';
import { initSettings } from './ui/settings.ts';
import { initStatusLine } from './ui/statusline-model.ts';
import { initTheme } from './ui/theme.ts';
import { getBehaviour, initBehaviour, initHiddenTools, initMascot } from './ui/prefs-model.ts';
import { TOOL_CARDS } from './ui/launch-args.ts';
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
import { onFocusSession } from './ui/host-bridge.ts';
import { isFolderPickerOpen, closeFolderPicker } from './ui/picker.ts';
import {
  dropDialogEscape,
  isDropDialogOpen,
  isDropRunning,
  openDropDialog,
} from './ui/drop-dialog.ts';
import { deleteDialogEscape, isDeleteDialogOpen } from './ui/delete-dialog.ts';
import { focusOwnerOpen, isEditableTarget, isTerminalTarget, shouldRefocusTerminal } from './ui/keys.ts';
import { loadTerminalFont, watchTerminalFont } from './ui/terminal.ts';
import type { FontWaitResult } from './ui/font-ready.ts';
import { startPresence } from './ws.ts';
import { formatError, initLogging, log } from './log.ts';
import { el, button } from './ui/util.ts';
import { gearIcon } from './ui/icons.ts';

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
  brand.append(tile, el('div', 'boot-brand-name', 'Session Manager'));
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
        button('btn-accent', 'Reload', () => location.reload()),
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
  // FIRST, before the boot panel and before any await: until the shell exists
  // nothing else in this page refuses a file drop, and an un-refused one
  // navigates the browser away from the app. A boot that never finishes (a
  // failed hydrate leaves the boot panel up for good) keeps this guard for
  // ever; a boot that does finish hands over inside initFileDrop.
  installDropGuard();
  const panel = createBootPanel();
  // Steps registered up front; each resolves on its own real event. They run
  // concurrently — serializing them would stretch real time for chrome.
  const stepToken = panel.step('Reaching the background service');
  const stepHydrate = panel.step('Loading projects and sessions');
  const stepWs = panel.step('Opening the live connection');
  const stepFont = panel.step('Loading the terminal font');

  // Terminal font BEFORE any terminal: a TerminalView built while JetBrains
  // Mono is still in flight measures the FALLBACK face, and keeps its glyphs
  // and its (wrong) cell width — so the cols/rows it reports to the PTY are
  // wrong — until a reload. The request starts here and is awaited just
  // before buildShell, which is the only place a pane (and therefore a
  // terminal) is ever built, so the wait overlaps the hydrate round trip
  // instead of adding to it. Bounded inside (FONT_WAIT_MS) and free when the
  // face is already there; ui/terminal.ts repairs a late arrival anyway.
  //
  // `.catch` at the SOURCE, not around the await: a synchronous throw out of
  // the token reads or `document.fonts` would otherwise reject this promise,
  // and the await below sits after every other row has settled — boot would
  // end on a bare unhandledrejection with the overlay already gone (dark
  // window, no message). 'failed' is a settled outcome the app survives.
  const fontReady = loadTerminalFont().catch((): FontWaitResult => 'failed');
  // It is an honest row, because the wait is real time the user waits: settled
  // from the SAME promise, so the overlay is still up while it runs instead of
  // holding buildShell behind an empty page. A 'timeout'/'failed' face is not
  // fatal — the terminal draws with the fallback and the watch below repairs
  // it — so it reads like the other non-fatal rows: a message, not a stop.
  // No .catch on this .then: fontReady cannot reject (caught at its source
  // above), and ok()/fail() settle the row before touching the DOM, so even a
  // throw in here could only cost one unhandledrejection line, never a
  // spinning row.
  void fontReady.then((result) => {
    if (result === 'timeout' || result === 'failed' || result === 'unparseable') {
      stepFont.fail('It did not arrive. Terminals start with a substitute font.');
    } else {
      stepFont.ok();
    }
  });

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
        else stepWs.fail('The connection closed. Trying again in the background.');
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
  // escape as an unhandled rejection and left the first boot row pending
  // forever.
  // The settled promise (never rejects: the catch below settles it) is
  // awaited ONCE before loadUi() — B6 D3 keys the stored tabs on this run's
  // startedAt, so the answer must be in before the bag is read, or an F5 with
  // `Reopen tabs on start` off would read as a new app start and drop them.
  const runtimeChecked: Promise<void> = api
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
  // (the status-line checklist) is joined into the SAME hydrate wait — no extra boot-panel step,
  // no reordering — but wrapped in its own .catch so a prefs-fetch failure
  // never fails hydrate or blocks the UI (the status-line checklist then keeps
  // its defaults, and the terminal colours stand on their local cache alone —
  // see initTheme in buildShell).
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
      'The app cannot reach the background service. It may have restarted — start the app again from its shortcut, then reload this page.',
    );
    stepHydrate.fail(err instanceof Error ? err.message : String(err));
    return;
  }
  // Settle BEFORE the log line, for the same reason the token step does.
  stepHydrate.ok();
  log.info(`boot hydrated: ${projects.length} projects, ${sessions.length} sessions`);
  await fontReady; // see loadTerminalFont above — it started before hydrate
  // The watch is armed HERE, between the wait and the first terminal: what it
  // remembers is whether the font was present at the moment terminals started
  // being built. Armed any earlier it would also fire on the face landing
  // normally (before any view existed) and cost a redraw and a PTY resize for
  // nothing.
  watchTerminalFont();
  try {
    st.initServer(projects, sessions);
    // Behaviour toggles and hidden tool cards (Nocturne B6) from the boot
    // bag, BEFORE loadUi(): it reads `reopenTabs` once; the doors, the
    // terminal writes and the New session dialog read the store fresh.
    initBehaviour(prefs?.behaviour);
    initHiddenTools(
      prefs?.tools,
      TOOL_CARDS.map((c) => c.id),
    );
    // The peek mascot switch (C1): only the Settings row reads it here; the
    // mascot page reads the bag itself on every poll.
    initMascot(prefs?.mascot);
    // D3: with `Reopen tabs on start` off the stored tabs belong to the run
    // that wrote them — a reload inside THIS run keeps them, a new app start
    // opens on Home. `serverStartedAt` is this run's identity (GET /api/runtime,
    // fetched above and awaited here; null only when that check failed, which
    // reads as a new run).
    await runtimeChecked;
    st.loadUi({ reopen: getBehaviour().reopenTabs, run: st.state.serverStartedAt });
    buildShell(root, prefs);
  } catch (err) {
    // Everything above has settled its row, but the ws row may still be
    // pending — a throw here would otherwise leave the overlay spinning on a
    // step that is fine, over an app that never mounted. Pin it instead.
    const m = err instanceof Error ? err.message : String(err);
    log.error(`boot failed: shell ${m}`);
    panel.fatal('The app could not start. Reload to try again.');
    return;
  }
  // The shell is up and usable. From here the ws row is the only thing that
  // could still hold the overlay open, and it has no failure event of its own
  // when the socket simply hangs — so it gets a ceiling.
  window.setTimeout(() => {
    if (wsFirst) {
      wsFirst = false;
      stepWs.fail('Still connecting.');
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
  // ---- top bar (Nocturne A2) -----------------------------------------------
  // Left to right: logo tile + wordmark, hairline, the three panel toggles,
  // spacer, connection readout (+ the update pill), hairline, GitHub account
  // chip, Settings, New session. Nothing here is decorative: every item is a
  // state readout or a way in.
  const topbar = el('header', 'topbar');
  const brand = el('div', 'tb-brand');
  const logo = el('div', 'logo-tile');
  logo.setAttribute('aria-hidden', 'true');
  logo.append(el('span', 'logo-glyph', '>_'));
  brand.append(logo, el('div', 'wordmark', 'Session Manager'));

  const toggles = el('div', 'tb-toggles');
  // Files (A5): a real toggle, and it needs no session — the panel opens on an
  // empty app and its header reads `Home`. Only ONE left panel is on screen at
  // a time: opening Files closes the Projects drawer, and an open Projects
  // drawer hides Files without forgetting that the user wants it.
  const filesBtn = button('tb-btn', 'Files', () => st.toggleLeftPanel('files'));
  const projectsBtn = button('tb-btn', 'Projects', () => st.toggleDrawer('projects'));
  projectsBtn.title = 'Projects';
  const sessionsBtn = button('tb-btn', 'Sessions', () => st.toggleDrawer('sessions'));
  sessionsBtn.title = 'Sessions';
  const sessionsBadge = el('span', 'tb-attn');
  sessionsBadge.hidden = true;
  sessionsBadge.title = 'Sessions waiting for you';
  sessionsBtn.append(sessionsBadge);
  toggles.append(filesBtn, projectsBtn, sessionsBtn);

  const conn = el('div', 'tb-conn');
  const connDot = el('span', 'tb-conn-dot is-ok');
  connDot.setAttribute('aria-hidden', 'true');
  const connTxt = el('span', '', 'Connected');
  conn.append(connDot, connTxt);

  // GitHub chip: account initial + login; opens the New Project dialog on its
  // GitHub tab (honest setup panel when the feature is dormant).
  const ghChip = createGithubChip(() => openNewProjectDialog('github'));

  // Settings: icon-only, the Phosphor gear as inline SVG (no icon package —
  // open decision #5 stays open). The glyph is decorative; `aria-label`
  // carries the accessible name.
  const settingsBtn = button('tb-icon', '');
  settingsBtn.append(gearIcon());
  settingsBtn.setAttribute('aria-label', 'Settings');
  settingsBtn.title = 'Settings';
  settingsBtn.setAttribute('aria-haspopup', 'dialog');

  const newBtn = button('tb-new', 'New session', () => openLaunchDialog());
  newBtn.title = 'New session (ctrl+alt+t)';

  topbar.append(
    brand,
    el('span', 'tb-divider'),
    toggles,
    el('span', 'tb-gap'),
    conn,
    el('span', 'tb-divider'),
    ghChip,
    settingsBtn,
    newBtn,
  );

  // ---- middle row: drawers are flex siblings of the grid --------------------
  const main = el('div', 'main');
  const projAside = el('aside', 'drawer drawer-proj');
  projAside.hidden = true;
  // Files sits between the Projects drawer and the grid (v3 order), and is a
  // flex sibling like them: its width IS the grid's missing width, so opening
  // or dragging it resizes every pane for real.
  const filesAside = el('aside', 'drawer files-panel');
  filesAside.hidden = true;
  filesAside.setAttribute('aria-label', 'Files');
  // The pane area's other occupant (Nocturne A6): the commit view REPLACES the
  // panes (the grid is hidden while it is up). It is a flex sibling for the
  // same reason the drawers are. The A6 EDITOR COLUMN is gone with part A10 —
  // a file is a pane now, so the grid keeps the whole row and never gives up
  // 46% of it to a column beside it (the user's complaint).
  const commitAside = el('section', 'screen-commit');
  commitAside.hidden = true;
  commitAside.setAttribute('aria-label', 'Commit');
  const grid = el('div', 'grid');
  const sessAside = el('aside', 'drawer drawer-sess');
  sessAside.hidden = true;
  main.append(projAside, filesAside, commitAside, grid, sessAside);

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
  // Terminal colours BEFORE anything that builds a terminal (initPanes, far
  // below): initTheme paints the chosen ground and ink onto :root, so every
  // terminal is born in them instead of being repainted after its first frame.
  // It also reconciles the local cache against the boot bag, and hands back the
  // one control the Settings page drives.
  const theme = initTheme(prefs);
  // Update notice BEFORE settings: the panel's BACKEND section calls into it,
  // and its pill lands in the topbar cluster right after the connection dot.
  const upd = initUpdate(modalHost);
  conn.after(upd.pill);
  // Since B6 the panel opens no overlay of its own: its Keyboard page draws the
  // whole shortcuts table from ui/shortcuts-rows.ts, so the `openShortcuts` dep
  // (and the ordering it needed — the overlay is built after this panel) is
  // gone. The statusline keeps that opener.
  const settings = initSettings(modalHost, settingsBtn, { repaintStatus, theme });
  settingsBtn.addEventListener('click', () => settings.toggle());
  initLaunchDialog(modalHost); // Before tabs/panes: their `+` paths open it.
  initNewProjectDialog(modalHost); // Projects-drawer `+ add` + GitHub chip open it.
  initGithub(); // one status fetch → the GitHub chip is honest from first paint.
  // The strip ends sessions and opens the launch dialog through injected
  // functions: importing either module from `ui/tabs.ts` would pull
  // @xterm/xterm into a module that has to stay drivable under `node --test`.
  const tabs = initTabs(strip, { killSession, openLaunch: () => openLaunchDialog() });
  // ONE overlay instance; A2 dropped the topbar `?` button and B6 dropped the
  // settings panel's link to it (that page draws the same table itself), so its
  // openers are the `?` key, Ctrl+Alt+/ and the statusline's Keyboard shortcuts
  // button.
  const shortcuts = initShortcuts(modalHost, requestTerminalFocus);
  const status = initStatusline(statusline, {
    openShortcuts: () => shortcuts.toggle(),
  });
  const sessionsDrawer = initSessionsDrawer(sessAside);
  const projectsDrawer = initProjectsDrawer(projAside);
  // B2: the panel reads the real filesystem through an INJECTED gateway. This
  // is the only module allowed to know that those three questions are HTTP —
  // `ui/files.ts` never imports `./api.ts`, which is what keeps it drivable
  // under `node --test` against a plain fake.
  // ONE object for both readers of git: the panel draws the list, the commit
  // store (ui/commit-store.ts) fetches the commit the view and the panel's
  // selected state share. Two gateways would be two boundaries to keep right.
  const fsGateway = {
    entries: api.fsEntries,
    create: api.fsCreate,
    changes: api.gitChanges,
    commits: api.gitCommits,
    commit: api.gitCommit,
    commitDiff: api.gitCommitDiff,
    winPath: api.fsWinPath,
    delete: api.fsDelete,
  };
  const filesPanel = initFilesPanel(filesAside, requestTerminalFocus, fsGateway);
  setCommitGateway(fsGateway);
  // B4: the editor pane reads and writes real files through its own injected
  // gateway. Same seam, same reason as the two above — `ui/file-pane.ts` never
  // imports `./api.ts`, so a file body is drivable under `node --test`.
  setEditorGateway({ read: api.fsRead, write: api.fsWrite });

  /**
   * One drop, handed over (B10). THIS is the seam where a path stops: the
   * runner is built here, closed over the real destination, and the dialog is
   * given the destination's NAME and that runner — so the card can copy into a
   * folder it cannot name the location of.
   *
   * The two things that happen once the copy is over live here too, for the
   * same reason: the panel is refreshed ONCE (and only if it is showing that
   * folder), and ONE line goes into the log with counts and nothing else.
   */
  function openDrop(req: DropRequest): void {
    const run = createDropRun({
      dest: req.dest,
      items: req.items,
      listing: req.listing,
      walk: req.walk,
      gateway: {
        put: (dir, rel, mode, body) => api.fsUpload(dir, rel, mode, body).then(() => undefined),
        // A folder that holds nothing still has to exist: the A9c create route
        // makes one, with the identical boundary and name rules the upload has.
        folder: (dir, name) => api.fsCreate(dir, name, 'folder').then(() => undefined),
      },
    });
    openDropDialog({
      dest: req.dest.name,
      items: req.items,
      listing: req.listing,
      returnFocus: req.returnFocus,
      run: {
        plan: (choice) => run.plan(choice),
        failed: () => run.failed(),
        start: async (choice, on) => {
          const results = await run.start(choice, on);
          // Both of these are AFTER the copy and neither may cost the dialog
          // its result: a throw here would reject the promise the card is
          // waiting on, and the card would say `Copying…` for good. One line
          // each, and the other one still runs.
          try {
            // Counted in FILES throughout — files carried, bytes carried,
            // files that failed — so the three numbers of one line are one
            // unit (a folder of 12 files that lost 3 says `3 failed`).
            api.logDrop(req.walk.files.length, req.walk.bytes, run.failed());
          } catch (err) {
            log.warn(`drop: the summary line could not be written: ${formatError(err)}`);
          }
          try {
            refreshAfterDrop(req.dest);
          } catch (err) {
            log.warn(`drop: the panel could not be refreshed: ${formatError(err)}`);
          }
          return results;
        },
      },
    });
  }

  // A9: the window's own HTML5 drop channel, after the panel exists — three of
  // its deps are that panel's own `subject()`, so it may not be wired first.
  initFileDrop({
    // B2 threads a real `{ path, name }` through the drop layer; the dialog
    // takes the NAME, which is the only half of a destination that may ever be
    // drawn, plus the runner that owns the other half.
    openDialog: openDrop,
    // One copy at a time (B10): a second drop while one is still writing would
    // race this one's panel refresh, so it is refused before it is walked.
    copyRunning: isDropRunning,
    listingFor,
    destinationOfPane,
    destinationOfActiveView,
    filesPanelDestination,
    pasteDestination,
    selectedFolder,
  });
  // Two hand-overs, because the commit view can leave in two directions: back
  // to the panes, or INTO the pane it just opened a file in. Both land in the
  // pane area, and the focused pane knows how to take the keyboard itself —
  // a file pane focuses its text, a diff its header, a session its terminal.
  const commitView = initCommitView(commitAside, requestTerminalFocus, requestTerminalFocus);

  /**
   * WHO OCCUPIES THE PANE AREA. One owner for the two flags, and it is
   * subscribed BEFORE ui/panes.ts on purpose: when a commit view closes, the
   * grid must already be visible again by the time the panes are asked to
   * render, or the rebuild they refuse while hidden would be refused for good.
   */
  function applyScreenLayout(): void {
    const commitOpen = st.state.openCommit !== null;
    const wasHidden = grid.hidden;
    commitAside.hidden = !commitOpen;
    grid.hidden = commitOpen;
    commitView.render();
    // The panes are measurable again: run the render they refused while the
    // commit view covered them.
    if (wasHidden && !grid.hidden) refreshPaneArea();
  }
  st.subscribe(applyScreenLayout);

  // Last: its first render needs the grid mounted and sized. The dialog
  // opener is injected to avoid a panes ↔ launch import cycle.
  initPanes(grid, () => openLaunchDialog());

  function updateChrome(): void {
    // The same set as the statusline's `N waiting for you`: BELs only (user,
    // 2026-09-22 — an ended turn shows on its pane, not in the counts).
    const n = st.attentionCount();
    sessionsBadge.hidden = n === 0;
    sessionsBadge.textContent = String(n);
    projAside.hidden = st.state.drawer !== 'projects';
    sessAside.hidden = st.state.drawer !== 'sessions';
    const filesOn = st.state.leftPanel === 'files';
    const filesShown = st.filesPanelVisible();
    filesAside.hidden = !filesShown;
    // `is-on` is the WISH (the filled look the reference keeps while the
    // Projects drawer covers the left side); `aria-pressed` is what is actually
    // ON SCREEN — a screen reader must not be told a panel is open that is not.
    filesBtn.classList.toggle('is-on', filesOn);
    filesBtn.setAttribute('aria-pressed', filesShown ? 'true' : 'false');
    // The sentence belongs to the wanted-but-hidden state only: it says where
    // the panel went, and pressing the button brings it straight back.
    filesBtn.title = filesOn && !filesShown ? 'Hidden while Projects is open' : 'Files';
    sessionsBtn.classList.toggle('is-on', st.state.drawer === 'sessions');
    sessionsBtn.setAttribute('aria-pressed', st.state.drawer === 'sessions' ? 'true' : 'false');
    projectsBtn.classList.toggle('is-on', st.state.drawer === 'projects');
    projectsBtn.setAttribute('aria-pressed', st.state.drawer === 'projects' ? 'true' : 'false');
    const ok = st.state.backendReachable;
    connDot.className = `tb-conn-dot ${ok ? 'is-ok' : 'is-down'}`;
    connTxt.textContent = ok ? 'Connected' : 'Offline';
  }

  st.subscribe(() => {
    // Every renderer is cheap or signature-guarded; dispatch coarsely.
    updateChrome();
    tabs.render();
    status.render();
    sessionsDrawer.render();
    projectsDrawer.render();
    filesPanel.render();
  });
  applyScreenLayout();
  updateChrome();
  tabs.render();
  status.render();
  sessionsDrawer.render();
  projectsDrawer.render();
  filesPanel.render();

  // ---- global keyboard -----------------------------------------------------

  // The Files panel and the drawers can be open with no session at all, and
  // then `requestTerminalFocus()` is a silent no-op (ui/panes.ts: no slot has
  // a view), so closing one would drop the keyboard on <body> and typing would
  // go nowhere until the next window activation — hand it to a visible control.
  function handBackKeyboard(fallback: HTMLElement): void {
    requestTerminalFocus();
    const a = document.activeElement;
    if (a === null || a === document.body) fallback.focus();
  }

  /**
   * The next EDITOR pane of a view after `from`, wrapping, or -1 when there is
   * no other one. ctrl+alt+m walks the panes in the order they are drawn, so
   * pressing it repeatedly carries the tab around the tab and back home.
   */
  /** ctrl+alt+m on a pane whose only tab is the one being moved. */
const ALONE_IN_PANE = 'This file is already alone in its pane.';

function nextEditorSlot(v: st.ViewState, from: number): number {
    for (let i = 1; i < v.slots.length; i += 1) {
      const j = (from + i) % v.slots.length;
      if (v.slots[j]?.kind === 'editor') return j;
    }
    return -1;
  }

  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.altKey && !e.metaKey && !e.getModifierState('AltGraph')) {
      const k = e.key;
      const paneChord =
        k === 'ArrowLeft' ||
        k === 'ArrowRight' ||
        k === 'ArrowUp' ||
        k === 'ArrowDown' ||
        k === 'w' ||
        k === 'W' ||
        // A10b: the file-tab chords act on the FOCUSED EDITOR PANE, which is
        // just as covered by the commit view as the rest of the grid. The
        // SHIFTED pgup/pgdn is a tab-strip chord and stays available.
        ((k === 'PageUp' || k === 'PageDown') && !e.shiftKey) ||
        k === 'm' ||
        k === 'M' ||
        (k.length === 1 && k >= '1' && k <= '9');
      // Nocturne A6: while the commit view covers the pane area, these chords
      // would move focus between and swap sessions inside panes NOBODY CAN
      // SEE, or switch to a tab whose panes are just as covered (Ctrl+Alt+
      // 1..9). They are left alone until the view is closed
      // (Escape, or either back control); the chords that open something of
      // their own — the launch dialog, the shortcuts overlay — still work.
      if (paneChord && st.state.openCommit !== null) return;
      if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'ArrowUp' || k === 'ArrowDown') {
        e.preventDefault();
        const dir =
          k === 'ArrowLeft' ? 'left' : k === 'ArrowRight' ? 'right' : k === 'ArrowUp' ? 'up' : 'down';
        // +shift moves the focused PANE to the neighbor pane of its view
        // (swap, kind-blind since A10: a file trades places with a terminal);
        // without shift only focus moves.
        if (e.shiftKey) st.movePane(dir);
        else st.moveFocus(dir);
      } else if (k === 'w' || k === 'W') {
        // A10b: close the ACTIVE TAB of the focused editor pane; its LAST tab
        // takes the pane with it (user decision 3). A terminal pane answers
        // false and nothing happens — ending a session is a different act with
        // its own confirmation (the A3 rule).
        e.preventDefault();
        const v = st.activeView();
        // Through the B4 guard (D1): a tab whose unsaved text no other tab
        // shows asks first, and the state mutator runs only after `Discard`.
        if (v !== null) closeActiveTabGuarded(v.id, v.focused);
      } else if (k.length === 1 && k >= '1' && k <= '9') {
        e.preventDefault();
        st.setActiveViewIndex(Number(k) - 1);
      } else if ((k === 'PageUp' || k === 'PageDown') && e.shiftKey) {
        // Keyboard twin of the tab-reorder drag (shift = "move", like the
        // arrow chords). TESTED FIRST: the unshifted pair below is a different
        // chord on the same keys, and the shifted one must never fall into it.
        e.preventDefault();
        st.moveActiveViewBy(k === 'PageUp' ? -1 : 1);
      } else if (k === 'PageUp' || k === 'PageDown') {
        // A10b: previous / next FILE TAB of the focused editor pane, wrapping.
        // (`[` and `]` — the usual pair — are AltGr characters on NL/BE/DE
        // layouts, so they cannot be reached under ctrl+alt at all.) A focused
        // terminal answers false and the keystroke does nothing.
        e.preventDefault();
        st.cycleTab(k === 'PageUp' ? -1 : 1);
      } else if (k === 'm' || k === 'M') {
        // A10b, the keyboard twin of dragging a chip onto a pane: move the
        // active file tab to the NEXT editor pane of this tab, and when there
        // is no other one, into a new split beside the focused pane. Both
        // refusals come out of the one shared mapping, so the chord and the
        // drag can never explain the same "no" differently — including the
        // honest "no room" a pane's ONLY tab gets when it is asked to split
        // beside the pane it is already alone in.
        e.preventDefault();
        const v = st.activeView();
        const s = v === null ? undefined : v.slots[v.focused];
        if (v === null || s === undefined || s.kind !== 'editor') return;
        const to = nextEditorSlot(v, v.focused);
        if (to !== -1) {
          // `flashMoveTabResult`, not `flashOpenResult`: a `'full'` from
          // `moveTab` is a full STRIP (four files, B4 amendment), and it gets
          // the strip's own sentence rather than the pane-count one.
          flashMoveTabResult(st.moveTab(v.id, v.focused, s.active, to));
          return;
        }
        // A pane's only tab has nowhere to go: no other editor pane, and a
        // split beside its own pane would leave that pane empty. The drag twin
        // says the same by lighting nothing, so the chord says it in words.
        if (s.tabs.length < 2) {
          flash(ALONE_IN_PANE);
          return;
        }
        const zone = st.dropZonesFor(v, v.focused, 1)[0];
        if (zone === undefined) {
          flashOpenResult(v.slots.length >= st.MAX_PANES ? 'full' : 'no-zone');
          return;
        }
        flashOpenResult(st.moveTabToSplit(v.id, v.focused, s.active, v.focused, zone));
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
      // Priority: overlay, then dialogs, then the commit view
      // (A6: it covers the whole pane area), then drawer/panel (only when the
      // drawer actually holds focus — Esc elsewhere belongs to whatever has
      // it).
      if (shortcuts.isOpen()) {
        e.preventDefault();
        shortcuts.close();
      } else if (isRestartConfirmOpen()) {
        // Topmost: it opens OVER the settings panel. During the preflight Esc
        // HIDES it and the restart runs on; once the handover has begun it
        // ignores Esc (nothing left to cancel, nothing left behind it).
        e.preventDefault();
        closeRestartConfirm();
      } else if (settings.isOpen()) {
        e.preventDefault();
        settings.close();
      } else if (isFolderPickerOpen()) {
        // Topmost: the folder picker can open OVER the Add a project dialog.
        e.preventDefault();
        closeFolderPicker();
      } else if (isDeleteDialogOpen()) {
        // Topmost of the two file dialogs: the confirmation can open while the
        // drop dialog is hidden mid-copy. Escape is its Cancel, exactly.
        e.preventDefault();
        deleteDialogEscape();
      } else if (isDiscardDialogOpen()) {
        // The B4 unsaved-changes question, ranked beside the delete
        // confirmation it is modelled on. Escape is `Keep editing` — the only
        // safe answer to a question about text that is not on disk yet.
        e.preventDefault();
        discardDialogEscape();
      } else if (isDropDialogOpen()) {
        e.preventDefault();
        dropDialogEscape();
      } else if (isNewProjectDialogOpen()) {
        e.preventDefault();
        closeNewProjectDialog();
      } else if (isLaunchDialogOpen()) {
        e.preventDefault();
        closeLaunchDialog();
      } else if (st.state.openCommit !== null && !isEditable(e.target)) {
        // Ranked below every dialog and ABOVE the drawer/panel arms: the
        // commit view is the largest surface under the modals — it covers the
        // whole pane area — so Esc peels it before a side drawer, and it needs
        // no focus test for the same reason (there is no terminal behind it to
        // steal the key from). A field anywhere else still keeps its own Esc.
        e.preventDefault();
        st.closeCommitView();
        // The screen it covered is back; the keyboard goes with it.
        requestTerminalFocus();
      } else if (st.state.drawer !== null && focusInOrFree(projAside, sessAside)) {
        e.preventDefault();
        const wasProjects = st.state.drawer === 'projects';
        st.closeDrawer();
        // The surface that held the focus just went away; without this the
        // focus falls to <body> and typing goes nowhere until the next window
        // activation. With no session (the Files panel is up from the first
        // paint, so an empty app reaches this arm) the drawer's own toggle
        // takes the keyboard.
        handBackKeyboard(wasProjects ? projectsBtn : sessionsBtn);
      } else if (
        st.state.leftPanel !== null &&
        document.activeElement !== null &&
        filesAside.contains(document.activeElement)
      ) {
        // Narrower than the drawer rule on purpose: Esc with focus nowhere in
        // particular must not make the Files panel disappear under the user.
        e.preventDefault();
        st.toggleLeftPanel('files');
        handBackKeyboard(filesBtn);
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
    reload: () => {
      // The backend this page held a token for is gone, so the browser's
      // unsaved question would offer a "stay" on a page that cannot save
      // anything any more (ui/unsaved.ts).
      disarmUnloadGuard();
      location.reload();
    },
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

  // ---- peek mascot click (Nocturne C1) --------------------------------------
  // The host brought this window to the front for a click on a mascot and
  // names the session it stood for: go to its tab and focus its pane, which
  // acks a BEL like any look does (a turn that ended keeps its mascot until
  // the session works again or ends — user, 2026-09-22). A session this page does not know (ended
  // meanwhile) → nothing. The commit view steps aside — it covers the pane the
  // user asked to see and holds nothing that is lost by closing it; an open
  // dialog stays open (it may hold typing).
  onFocusSession((id) => {
    if (fatal || !st.state.sessions.has(id) || st.viewOfSession(id) === undefined) return;
    log.info(`host: focus-session ${id}`);
    st.closeCommitView();
    st.focusSession(id);
    requestTerminalFocus();
    refreshPaneArea();
  });

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

  // A RELOAD AND A WINDOW CLOSE ASK TOO (part B4, user decision D1). The app
  // cannot put its own card in front of either, so the browser's question is
  // the one that stands there — and only while something is really unsaved:
  // `unloadGuard` (ui/unsaved.ts) reads `state.edits` and arms nothing when it
  // is empty, because a page that always asks is a page whose question means
  // nothing.
  window.addEventListener('beforeunload', (e) => {
    unloadGuard(e);
  });
}

/**
 * The moment between "this page's token was rejected" and "the replacement
 * backend answered": a boot overlay, verbatim — same brand, same card, same
 * single spinning step row. It is not a metaphor for the boot state, it IS
 * one; the page is about to load again. Removed only if the probe fails, so the
 * panel underneath is not hidden behind it.
 */
const RECONNECT_LABEL = 'The background service restarted. Reconnecting…';
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
  brand.append(tile, el('div', 'boot-brand-name', 'Session Manager'));
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
  box.append(el('div', 'boot-err-hd', 'The background service restarted'));
  box.append(el('div', 'boot-err-msg', 'This page can no longer reach it. Reload to attach again.'));
  box.append(button('btn-accent', 'Reload', () => location.reload()));
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

/**
 * True when the event originates inside an xterm instance — its keys are
 * sacred. The `.term-host` test itself lives in ui/keys.ts, which is the one
 * place it may live (the external-drop layer asks the same question).
 */
function fromTerminal(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && isTerminalTarget(t);
}

/** Focus is inside one of the containers, or nowhere interesting (body/null). */
function focusInOrFree(...containers: HTMLElement[]): boolean {
  const a = document.activeElement;
  return a === null || a === document.body || containers.some((c) => c.contains(a));
}
