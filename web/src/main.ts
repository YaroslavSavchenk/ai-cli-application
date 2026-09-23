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
 *
 * Split by O8 (2026-09-23): the shell itself — `buildShell`, the global
 * keyboard, the polls, the takeovers — lives in `main-shell.ts`; this file
 * keeps the entry: the stylesheets, the boot panel and `boot()`.
 */
import '@xterm/xterm/css/xterm.css';
import './styles/tokens.css';
import './styles/fonts.css';
import './styles/app.css';
import { buildShell } from './main-shell.ts';
import type { UiPrefs } from '../../shared/protocol.ts';
import * as st from './state.ts';
import * as api from './api.ts';
import { initHistory } from './ui/history.ts';
import { installDropGuard } from './ui/filedrop.ts';
import { getBehaviour, initBehaviour, initHiddenTools, initMascot } from './ui/prefs-model.ts';
import { TOOL_CARDS } from './ui/launch-args.ts';
import { applyRuntime } from './ui/update.ts';
import { loadTerminalFont, watchTerminalFont } from './ui/terminal.ts';
import type { FontWaitResult } from './ui/font-ready.ts';
import { startPresence } from './ws.ts';
import { initLogging, log } from './log.ts';
import { el, button } from './ui/util.ts';

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
