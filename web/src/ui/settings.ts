/**
 * App settings panel — what Claude Code's own status line shows, the keys the
 * app takes off the terminal (2026-09-08), and the one backend action.
 *
 * Everything else this panel used to carry is gone with the feature it
 * configured: the global launch defaults + auto-run startup command (the launch
 * dialog now pre-selects from the project's own defaults), the read-only usage
 * ledger (the endpoint behind it no longer exists), and the per-pane telemetry
 * strip (replaced by the status line the session draws itself). Terminal themes
 * live in their own popover (ui/theme.ts) and are untouched.
 *
 * What a toggle here does: it writes the `statusLine` key of the prefs bag, and
 * the script Claude Code runs re-reads that file on every invocation — so an
 * item toggle takes effect in ALREADY RUNNING sessions within a couple of
 * seconds, with no restart. The ONE thing a toggle cannot do is give a status
 * line to a session that was started without one (the server injects the
 * per-session settings file at spawn); those sessions are named in the notice
 * this panel renders, and only when there actually are some.
 *
 * Copy rule (PROJECT-SCOPE, 2026-07-25): no commands, flags or config-file names
 * anywhere in here. The per-row samples are the literal text the status line
 * draws for that item, which is terminal output, not CLI syntax.
 */
import type { SessionInfo } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import { log } from '../log.ts';
import * as st from '../state.ts';
import { el, button, trapTab } from './util.ts';
import { commandLabel } from './launch-args.ts';
import { openRestartConfirm, runtimeFacts } from './update.ts';
import {
  DEAD_PREFS_KEYS,
  getStatusLine,
  initStatusLine,
  setStatusLine,
  statusLineDefaults,
  statusLinePatch,
  sessionsWithoutStatusLine,
  type StatusLineCfg,
} from './statusline-model.ts';

export interface SettingsPanel {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

export interface SettingsDeps {
  /** Opens the shortcuts overlay (one instance, shared with the `?` button and key). */
  openShortcuts(): void;
}

/**
 * The KEYS section: the two things the app takes off the terminal, said where
 * a user goes looking for app behaviour (2026-09-08 — the user asked "why
 * ctrl+shift+v?" about a chord that lived only in an overlay behind a bare `?`).
 * It is an EXCERPT, not a second reference: the overlay stays the full list,
 * and `all shortcuts` opens that same overlay.
 */
interface KeyRow {
  what: string;
  /** Chords, rendered as <kbd> chips — the same chips the overlay draws. */
  keys?: string[];
  /** A mouse sentence, rendered as plain text (never a key chip). */
  gesture?: string;
}

const KEY_ROWS: KeyRow[] = [
  { what: 'paste into a terminal', keys: ['ctrl+shift+v', 'shift+insert'] },
  { what: 'open a link printed in a terminal', gesture: 'ctrl+click' },
];

/** One toggle row: its key, its label, and the text that item really draws. */
interface ItemRow {
  key: keyof StatusLineCfg;
  label: string;
  /**
   * A sample in the status line's own formatting — the same strings
   * server/statusline.mjs prints, so the row promises exactly what appears.
   * `always ask` is the mode wording for the ask-first mode there.
   */
  sample: string;
  /** Optional caption under the row: the honest scope of that item. */
  caption?: string;
}

const ITEM_ROWS: ItemRow[] = [
  { key: 'model', label: 'Model', sample: 'opus' },
  {
    key: 'mode',
    label: 'Permission mode',
    sample: 'always ask',
    caption: 'shows the mode the session was started with',
  },
  { key: 'branch', label: 'Git branch', sample: 'git:main' },
  { key: 'cost', label: 'Cost so far', sample: '$0.42' },
  { key: 'lines', label: 'Lines changed', sample: '+128 -41' },
  { key: 'context', label: 'Context used', sample: 'ctx 62%' },
  {
    key: 'usage',
    label: 'Account usage',
    sample: '5h 38%',
    caption:
      'works with a Claude Pro or Max account · appears after the session’s first reply',
  },
];

export function initSettings(
  modalHost: HTMLElement,
  anchor: HTMLElement,
  deps: SettingsDeps,
): SettingsPanel {
  // ---- scrim + card --------------------------------------------------------
  const scrim = el('div', 'modal-scrim');
  scrim.hidden = true;
  const modal = el('div', 'modal settings-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'app settings');

  // ---- header (the shared gradient dialog header: launch dialog / picker) --
  const hd = el('header', 'launch-hd');
  const tile = el('div', 'launch-tile');
  tile.setAttribute('aria-hidden', 'true');
  tile.append(el('span', 'np-glyph', '⚙'));
  const titles = el('div', 'launch-titles');
  titles.append(
    el('div', 'launch-title', 'Settings'),
    el('div', 'launch-sub', 'status line · keys · backend'),
  );
  const closeX = button('launch-x', '×', () => close());
  closeX.setAttribute('aria-label', 'close settings');
  closeX.title = 'close (esc)';
  hd.append(tile, titles, el('span', 'launch-gap'), closeX);

  const bodyEl = el('div', 'settings-body');

  // ======================================================================
  // Status line — master switch + the seven items
  // ======================================================================
  const sect = el('section', 'settings-sect');
  sect.append(el('div', 'drawer-label', 'STATUS LINE'));
  sect.append(
    el(
      'div',
      'settings-note',
      'Claude Code draws a status line at the bottom of every session started here. Pick what it shows — changes reach running sessions within a couple of seconds.',
    ),
    // The blank-bar cases, said out loud so an empty line reads as normal
    // rather than broken.
    el(
      'div',
      'settings-note',
      'A session shows nothing until its first reply — and when Claude asks you to trust a folder it has not worked in before, the line stays blank until you do.',
    ),
  );

  // Relaunch notice: only rendered when running sessions actually lack one.
  const notice = el('div', 'settings-notice');
  notice.hidden = true;
  notice.setAttribute('role', 'note');
  const noticeText = el(
    'div',
    '',
    'These sessions were started without a status line. End them and start them again to add one:',
  );
  const noticeNames = el('div', 'settings-notice-names');
  notice.append(noticeText, noticeNames);
  sect.append(notice);

  // Master switch — its own row, above the hairline that separates the items
  // it governs.
  const masterRow = button('status-row', '', () => toggleKey('enabled'));
  const masterBox = el('span', 'status-box');
  masterBox.setAttribute('aria-hidden', 'true');
  masterRow.append(masterBox, el('span', 'status-lb', 'Show the status line'));
  const masterWrap = el('div', 'status-rows');
  masterWrap.append(masterRow);
  sect.append(masterWrap);

  const itemsWrap = el('div', 'status-rows settings-items');
  itemsWrap.setAttribute('role', 'group');
  itemsWrap.setAttribute('aria-label', 'status line items');
  const rowEls = new Map<keyof StatusLineCfg, HTMLButtonElement>();
  const boxEls = new Map<keyof StatusLineCfg, HTMLElement>();
  for (const r of ITEM_ROWS) {
    const row = button('status-row', '', () => toggleKey(r.key));
    const box = el('span', 'status-box');
    box.setAttribute('aria-hidden', 'true');
    row.append(box, el('span', 'status-lb', r.label), el('span', 'status-sample', r.sample));
    rowEls.set(r.key, row);
    boxEls.set(r.key, box);
    itemsWrap.append(row);
    if (r.caption !== undefined) itemsWrap.append(el('div', 'settings-rowcap', r.caption));
  }
  sect.append(itemsWrap);

  // ======================================================================
  // Keys — the two gestures that are NOT visible controls anywhere else
  // ======================================================================
  const keysSect = el('section', 'settings-sect');
  keysSect.append(el('div', 'drawer-label', 'KEYS'));
  const keyList = el('div', 'settings-keys');
  for (const r of KEY_ROWS) {
    const row = el('div', 'settings-keyrow');
    const chips = el('span', 'settings-keychips');
    if (r.keys !== undefined) {
      r.keys.forEach((k, i) => {
        if (i > 0) chips.append(el('span', 'settings-keysep', '·'));
        chips.append(el('kbd', '', k));
      });
    }
    if (r.gesture !== undefined) chips.append(el('span', 'settings-keygesture', r.gesture));
    row.append(el('span', 'status-lb', r.what), chips);
    keyList.append(row);
  }
  keysSect.append(keyList);
  const allKeysBtn = button('btn-link', 'all shortcuts', () => deps.openShortcuts());
  allKeysBtn.setAttribute('aria-haspopup', 'dialog');
  const allKeysRow = el('div', 'settings-actionrow');
  allKeysRow.append(allKeysBtn);
  keysSect.append(allKeysRow);

  // ======================================================================
  // Backend — the program that runs the sessions, and the one button that
  // replaces it with the version currently on disk (2026-09-06, user's
  // request). Two mono readouts and an action: no dashboard, no graphs, and
  // no mechanics explained — the confirmation says what restarting costs.
  // ======================================================================
  const backSect = el('section', 'settings-sect');
  backSect.append(el('div', 'drawer-label', 'BACKEND'));
  backSect.append(
    el(
      'div',
      'settings-note',
      'Your sessions run in a program that keeps going while this window is open. Restarting it picks up a new version of the app.',
    ),
  );
  const facts = el('div', 'settings-facts');
  const factUp = el('span', 'settings-fact');
  const factVer = el('span', 'settings-fact');
  facts.append(factUp, el('span', 'settings-fact-sep', '·'), factVer);
  const backRow = el('div', 'settings-actionrow');
  const restartBtn = button('btn', 'Restart backend', () => openRestartConfirm('settings'));
  restartBtn.setAttribute('aria-haspopup', 'dialog');
  backRow.append(facts, el('span', 'drawer-gap'), restartBtn);
  backSect.append(backRow);
  backSect.append(
    el('div', 'settings-note', 'Every running session closes. They stay in History.'),
  );

  bodyEl.append(sect, keysSect, backSect);

  /**
   * The two readouts, refreshed on open and on every conn change (the runtime
   * poll writes both). `running for` is a coarse duration on purpose: this line
   * is read once, not watched — the statusline already ticks a live clock.
   */
  function renderBackend(): void {
    const f = runtimeFacts();
    factUp.textContent = `running for ${f.runningFor}`;
    factVer.textContent = `version ${f.version}`;
  }

  // ---- footer --------------------------------------------------------------
  const ft = el('footer', 'modal-ft settings-ft');
  const resetBtn = button('btn', 'Reset to defaults', () => resetAll());
  resetBtn.title = 'restore the status line to its default on/off items';
  // Accent-blue primary (refreshed prototype 2026-07-24): confirm, not "go".
  const doneBtn = button('btn is-acc', 'Done', () => close());
  doneBtn.title = 'close settings (esc)';
  ft.append(resetBtn, el('span', 'drawer-gap'), doneBtn);

  modal.append(hd, bodyEl, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close();
  });
  trapTab(modal);
  modalHost.append(scrim);

  // ---- toggles <-> store ---------------------------------------------------

  /** Writes since this open — a late boot-prefs re-read must not undo them. */
  let writes = 0;

  /** Reflect the whole stored config onto the rows (boxes, aria, disabled). */
  function syncRows(): void {
    const cfg = getStatusLine();
    masterRow.setAttribute('aria-pressed', cfg.enabled ? 'true' : 'false');
    masterBox.textContent = cfg.enabled ? '✓' : '';
    for (const r of ITEM_ROWS) {
      const row = rowEls.get(r.key);
      const box = boxEls.get(r.key);
      if (row === undefined || box === undefined) continue;
      row.setAttribute('aria-pressed', cfg[r.key] ? 'true' : 'false');
      box.textContent = cfg[r.key] ? '✓' : '';
      // With the line switched off the items decide nothing; the group dims
      // and stops taking input (the launch dialog's is-disabled idiom).
      row.disabled = !cfg.enabled;
    }
    itemsWrap.classList.toggle('is-disabled', !cfg.enabled);
  }

  /**
   * Persist the whole resolved config, dropping the two retired prefs keys in
   * the same write. Fire-and-forget: a failed write leaves the in-memory value
   * for this run, and the status line simply keeps drawing what is on disk.
   */
  function persist(): void {
    writes++;
    const cfg = getStatusLine();
    log.debug(
      `prefs statusLine: enabled=${cfg.enabled} ` +
        ITEM_ROWS.map((r) => `${r.key}=${cfg[r.key]}`).join(' '),
    );
    void api.updatePrefs(statusLinePatch(cfg), DEAD_PREFS_KEYS).catch(() => {
      // Non-fatal by design — nothing user-facing to say about it.
    });
  }

  function toggleKey(key: keyof StatusLineCfg): void {
    const cur = getStatusLine();
    setStatusLine({ ...cur, [key]: !cur[key] });
    syncRows();
    persist();
  }

  function resetAll(): void {
    setStatusLine(statusLineDefaults());
    syncRows();
    persist();
  }

  // ---- relaunch notice -----------------------------------------------------

  /**
   * Name the RUNNING sessions of the known agent that have no status line.
   * Titles are user/server strings → textContent only. The notice is silent
   * when the set is empty, and item toggles never produce it: they apply live.
   *
   * A session launched without a title gets the raw command as its title
   * (server/sessions.ts), so naming it verbatim would print a command name in
   * UI chrome AND identify nothing when several sessions share it. The drawer's
   * `commandLabel` is reused for exactly that case, and names that would still
   * collide take their project as a qualifier when there is one.
   */
  function renderNotice(): void {
    const stale: SessionInfo[] = sessionsWithoutStatusLine(st.state.sessions.values());
    if (stale.length === 0) {
      notice.hidden = true;
      noticeNames.replaceChildren();
      return;
    }
    notice.hidden = false;
    const named = stale.map((s) => ({
      label: s.title === s.command ? commandLabel(s.command) : s.title,
      project: st.projectName(s.projectId),
    }));
    const counts = new Map<string, number>();
    for (const n of named) counts.set(n.label, (counts.get(n.label) ?? 0) + 1);
    noticeNames.textContent = named
      .map((n) => ((counts.get(n.label) ?? 0) > 1 && n.project !== null ? `${n.label} (${n.project})` : n.label))
      .join(' · ');
  }

  // The session list refreshes on the poll; keep the notice honest while open.
  st.subscribe((kind) => {
    if (scrim.hidden) return;
    if (kind === 'sessions') renderNotice();
    if (kind === 'conn') renderBackend();
  });

  // ---- open / close --------------------------------------------------------
  let restoreTo: HTMLElement | null = null;

  function open(): void {
    if (!scrim.hidden) return;
    restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    writes = 0;
    syncRows();
    renderNotice();
    renderBackend();
    scrim.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    // Re-read the stored config on open: another window (or another run) may
    // have changed it since boot, and these toggles must show what the status
    // line actually reads. Skipped if the user already toggled something in
    // this open — a slow response must never undo a fresh choice.
    void api
      .getPrefs()
      .then((bag) => {
        if (scrim.hidden || writes > 0) return;
        initStatusLine(bag.statusLine);
        syncRows();
      })
      .catch(() => {
        // Keep the in-memory config; nothing to say.
      });
    masterRow.focus();
  }

  function close(): void {
    if (scrim.hidden) return;
    scrim.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    if (restoreTo !== null && restoreTo.isConnected) restoreTo.focus();
    else anchor.focus();
    restoreTo = null;
  }

  return {
    open,
    close,
    toggle: () => (scrim.hidden ? open() : close()),
    isOpen: () => !scrim.hidden,
  };
}
