/**
 * App settings — a modal with a LEFT NAV (Nocturne A7, v3
 * `session-manager-v3.html` lines 561-640): a 170px column of page names beside
 * a scrolling page. Five pages:
 *
 *   Status bar          what a session states about itself — LIVE, the prefs
 *                       `statusLine` key. Since Nocturne B1 one checklist
 *                       drives TWO places: Claude Code's own line inside the
 *                       terminal (`enabled`) and the app's bar under it
 *                       (`paneBar`, ui/pane-status-model.ts); since B11 a
 *                       third switch shows the Background agents table
 *                       (`paneAgents`, default off).
 *   Preferences         the keys the tools need, which tools the New session
 *                       dialog offers, and how the app behaves — all LIVE
 *                       since part B6. The key rows arrived with B5 (one
 *                       optional key per tool that reads one from its
 *                       environment; the page only ever learns saved / not
 *                       saved); the Tools block hides cards from the dialog's
 *                       grid, and the Defaults block writes the three
 *                       behaviour toggles the app reads at boot, at every
 *                       door that ends a session, and on every terminal write,
 *                       plus (C1) the peek mascot's switch, which the mascot
 *                       page reads.
 *   Keyboard            the WHOLE keyboard table, drawn from the same rows as
 *                       the shortcuts overlay (ui/shortcuts-rows.ts) in a
 *                       layout that fits a 640-wide page: the chords the app
 *                       takes off the terminal, the drags and their keyboard
 *                       twins. Until B6 it was a hand-copied three-row excerpt
 *                       with a link to the overlay, which is how two tables
 *                       drift apart.
 *   Terminal colours    ground + text for the terminals (ui/term-colours.ts) —
 *                       LIVE since part B9: the page drives ui/theme.ts's
 *                       control (injected, see SettingsDeps.theme), which
 *                       paints every open terminal and persists the pair.
 *   Background service  version, uptime, Check for updates, Restart. Since B6
 *                       the check runs the backend's own release check and
 *                       answers on the page (one sentence, and the `Update`
 *                       act when a release is waiting) instead of opening a
 *                       page in the browser.
 *
 * What a Status bar toggle does: it writes the `statusLine` key of the prefs
 * bag, and the script Claude Code runs re-reads that file on every invocation —
 * so an item toggle takes effect in ALREADY RUNNING sessions within a couple of
 * seconds, with no restart. The ONE thing a toggle cannot do is give a status
 * line to a session that was started without one (the server injects the
 * per-session settings file at spawn); those sessions are named in the notice
 * the Status bar page renders, and only when there actually are some.
 *
 * The modal is TOP-anchored like the New session dialog, and for the same
 * reason: its height changes per page, and a centred box would re-place itself
 * under the pointer every time the nav is used.
 *
 * Copy rule (PROJECT-SCOPE, 2026-07-25): no commands, flags or config-file names
 * anywhere in here. The per-row samples are the literal text the status line
 * draws for that item, which is terminal output, not CLI syntax.
 */
import type { KeyedTool, SessionInfo } from '../../../shared/protocol.ts';
import { isKeyedTool } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import { log } from '../log.ts';
import * as st from '../state.ts';
import { el, button, trapTab } from './util.ts';
import { TOOL_CARDS, commandLabel, type ToolIconId } from './launch-args.ts';
import { toolIcon } from './icons-tools.ts';
import { ROWS } from './shortcuts-rows.ts';
import { buildTermColours, type TermColoursControl, type TermPair } from './term-colours.ts';
// theme-model.ts only: the clamp that reads a prefs bag's `theme`. ui/theme.ts
// itself arrives as a dep (see SettingsDeps.theme).
import { themeFromBag } from './theme-model.ts';
import {
  type BehaviourCfg,
  behaviourPatch,
  getBehaviour,
  getHiddenTools,
  getMascotEnabled,
  initBehaviour,
  initHiddenTools,
  initMascot,
  mascotPatch,
  setBehaviour,
  setHiddenTools,
  setMascotEnabled,
  toolsPatch,
} from './prefs-model.ts';
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
import { createKeyRows } from './settings-apikeys.ts';
import { createServicePage } from './settings-service.ts';

/** Where an opener wants the panel to land (Nocturne B5: the launch dialog's `Add key`). */
export interface SettingsOpenOpts {
  /** The page to show instead of the first one. */
  page?: PageId;
  /** Put the keyboard in THIS tool's key field (implies the Preferences page). */
  focusKey?: KeyedTool;
}

export interface SettingsPanel {
  open(opts?: SettingsOpenOpts): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

/**
 * The ONE live panel, so another surface can send the user straight to a page
 * without owning a reference (the launch dialog's `Add key` button). Same idiom
 * as `openLaunchDialog` in ui/launch.ts; null until main.ts has built it.
 */
let panelCtl: SettingsPanel | null = null;

/** Open Settings, optionally on a given page with one key field focused. */
export function openSettings(opts?: SettingsOpenOpts): void {
  panelCtl?.open(opts);
}

export interface SettingsDeps {
  /**
   * Redraws the status bar under every visible terminal (`ui/panes.ts`
   * repaintStatus). Injected, not imported: that module pulls @xterm/xterm in,
   * and this one has to stay drivable under `node --test`. A checklist change
   * reaches Claude's own line by itself (the script re-reads prefs.json every
   * couple of seconds) but nothing tells the panes, and a preference the user
   * just clicked must not wait for the next session event to show up.
   */
  repaintStatus(): void;
  /**
   * ui/theme.ts's terminal-colours control, spelled structurally (the page's
   * own `TermColoursControl` plus the dialog's flush): importing theme.ts
   * would pull @xterm/xterm into a module that has to stay drivable under
   * `node --test`. The Terminal colours page drives it; `flush()` sends a
   * debounced server write NOW, which is what closing this dialog does, and
   * `adopt()` takes a pair that came FROM the server (the re-read below)
   * without writing it back.
   */
  theme: TermColoursControl & { adopt(next: TermPair): void; flush(): Promise<void> };
}

/** The nav, in order. The gear always opens the first one. */
const PAGES = [
  { id: 'status', label: 'Status bar' },
  { id: 'prefs', label: 'Preferences' },
  { id: 'keys', label: 'Keyboard' },
  { id: 'colours', label: 'Terminal colours' },
  { id: 'service', label: 'Background service' },
] as const;

type PageId = (typeof PAGES)[number]['id'];

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
  /**
   * The item exists under the terminal only — Claude's own line cannot draw it
   * (the payload it is handed carries no such value), so the preview, which IS
   * that line, leaves it out. Nocturne B1: `Session time`.
   */
  paneOnly?: boolean;
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
  {
    key: 'time',
    label: 'Session time',
    sample: '2h 15m',
    caption: 'under the terminal only',
    paneOnly: true,
  },
  { key: 'lines', label: 'Lines changed', sample: '+128 -41' },
  { key: 'context', label: 'Context used', sample: 'ctx 62%' },
  {
    key: 'usage',
    label: 'Account usage',
    sample: '5h 38%',
    caption:
      'works with a Claude Pro or Max account, and appears after the session’s first reply',
  },
];


/**
 * The Defaults block on the Preferences page — LIVE since part B6, one row per
 * member of the behaviour store (ui/prefs-model.ts). The captions say what the
 * switch really decides, because all three are invisible until the moment they
 * act: a start, a click on a door, a line of output arriving.
 *
 * The v3 markup's fourth row (`Notifications when a session needs you`) came
 * back with the peek mascot (user decision D2, 2026-09-22; part C1) as the
 * `Peek mascot` row below, which is not a behaviour member: it has its own
 * prefs key (`mascot`) because the mascot page reads it, not this app.
 */
interface DefaultRow {
  key: keyof BehaviourCfg;
  label: string;
  caption: string;
}

const DEFAULT_ROWS: DefaultRow[] = [
  {
    key: 'reopenTabs',
    label: 'Reopen tabs on start',
    caption:
      'The files, folders and views you left open come back the next time the app starts; sessions never survive a restart.',
  },
  {
    key: 'confirmEnd',
    label: 'Confirm before ending a session',
    caption: 'Every button that ends a session asks once before it does.',
  },
  {
    key: 'followOutput',
    label: 'Follow output',
    caption: 'A terminal jumps to its newest output even when you have scrolled up.',
  },
];

/**
 * The Defaults block's fourth row (Nocturne C1, `.claude/plans/nocturne/PLAN-C1.md`
 * § The toggle). Plain words: what the user sees, and when.
 */
const MASCOT_LABEL = 'Peek mascot';
const MASCOT_CAPTION =
  'A small Claude peeks in at the edge of your screen when a session is done or asks you something.';

/** The Tools block's refusal, said in the row's own caption slot (D1). */
const TOOLS_FLOOR = 'Keep at least one tool visible.';

/**
 * How long that refusal stays on screen. 3000 ms is the app's own "for a
 * moment" already: the armed two-step in ui/util.ts disarms after exactly that.
 */
const TOOLS_FLOOR_MS = 3000;


export function initSettings(
  modalHost: HTMLElement,
  anchor: HTMLElement,
  deps: SettingsDeps,
): SettingsPanel {
  // ---- scrim + card --------------------------------------------------------
  // `.modal-scrim` stays on the scrim for its z-layer: the restart confirmation
  // opens OVER this panel and claims a higher one (app.css, .rs-scrim).
  const scrim = el('div', 'modal-scrim sg-scrim');
  scrim.hidden = true;
  const modal = el('div', 'sg-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Settings');

  // ---- left nav ------------------------------------------------------------
  const nav = el('nav', 'sg-nav');
  nav.append(el('div', 'sg-navtitle', 'Settings'));
  const tabs = el('div', 'sg-tabs');
  tabs.setAttribute('role', 'tablist');
  tabs.setAttribute('aria-orientation', 'vertical');
  tabs.setAttribute('aria-label', 'settings pages');
  const tabEls = new Map<PageId, HTMLButtonElement>();
  const panelEls = new Map<PageId, HTMLElement>();
  for (const p of PAGES) {
    const b = button('sg-tab', p.label, () => showPage(p.id));
    b.id = `sg-tab-${p.id}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', 'false');
    b.setAttribute('aria-controls', `sg-panel-${p.id}`);
    b.tabIndex = -1;
    tabEls.set(p.id, b);
    tabs.append(b);
  }
  // One tab stop for the whole nav, arrows move between pages (the A4 card-grid
  // idiom, the WAI-ARIA tablist pattern).
  tabs.addEventListener('keydown', (e: KeyboardEvent) => {
    const order = PAGES.map((p) => p.id);
    let i = order.indexOf(page);
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowRight') i = (i + 1) % order.length;
    else if (k === 'ArrowUp' || k === 'ArrowLeft') i = (i - 1 + order.length) % order.length;
    else if (k === 'Home') i = 0;
    else if (k === 'End') i = order.length - 1;
    else return;
    e.preventDefault();
    const next = order[i] as PageId;
    showPage(next);
    tabEls.get(next)?.focus();
  });
  nav.append(tabs);

  const bodyEl = el('div', 'sg-body');

  /** A page: the title the nav names, a lead line, then its rows. */
  function newPage(id: PageId, title: string, lead: string): HTMLElement {
    const sect = el('section', 'sg-page');
    sect.id = `sg-panel-${id}`;
    sect.setAttribute('role', 'tabpanel');
    sect.setAttribute('aria-labelledby', `sg-tab-${id}`);
    sect.append(el('h2', 'sg-title', title), el('p', 'sg-lead', lead));
    panelEls.set(id, sect);
    bodyEl.append(sect);
    return sect;
  }

  /**
   * A boolean row: a real button, state in aria-pressed, no hover-only
   * affordance. `mark` draws the tool's tile between the box and the name, the
   * same tile the key rows below carry, so one tool reads as one thing on both
   * blocks of the Preferences page.
   */
  function checkRow(label: string, onToggle?: () => void, mark?: ToolIconId): {
    row: HTMLButtonElement;
    box: HTMLElement;
  } {
    const row = button('sg-row', '', onToggle);
    const box = el('span', 'sg-box');
    box.setAttribute('aria-hidden', 'true');
    row.append(box);
    if (mark !== undefined) {
      const tile = el('span', 'sg-mark');
      tile.append(toolIcon(mark, 14));
      tile.setAttribute('aria-hidden', 'true');
      row.append(tile);
    }
    row.append(el('span', 'sg-rowlb', label));
    return { row, box };
  }

  // ======================================================================
  // Status bar — the checklist, live
  // ======================================================================
  const statusPage = newPage(
    'status',
    'Status bar',
    'Choose what each session shows under its terminal. Saved on this computer.',
  );

  // The bar as it will read, in the terminal's own ground and type.
  const preview = el('div', 'sg-prevbar');
  preview.setAttribute('aria-hidden', 'true');
  statusPage.append(preview);

  statusPage.append(
    // The blank-bar cases, said out loud so an empty line reads as normal
    // rather than broken.
    el(
      'p',
      'sg-lead',
      'A session shows nothing until its first reply, and when Claude asks you to trust a folder it has not worked in before the line stays blank until you do. With both on, the same values show twice.',
    ),
  );

  // Relaunch notice: only rendered when running sessions actually lack one.
  const notice = el('div', 'sg-notice');
  notice.hidden = true;
  notice.setAttribute('role', 'note');
  const noticeText = el(
    'div',
    '',
    'These sessions were started without a status line. End them and start them again to add one:',
  );
  const noticeNames = el('div', 'sg-notice-names');
  notice.append(noticeText, noticeNames);
  statusPage.append(notice);

  // The two places a status bar can be, each its own switch, in one group above
  // the items they share (B1). Separate because they are separate things: one is
  // drawn by Claude Code inside its terminal, the other by this app under it.
  const inside = checkRow('Inside the terminal', () => toggleKey('enabled'));
  const under = checkRow('Under the terminal', () => toggleKey('paneBar'));
  // Nocturne B11: the Background agents table is its own switch, next to the
  // bar it sits under, default OFF — Claude Code draws its own task list in
  // the terminal, so the table is the duplicate the user opts into. It does
  // not depend on either bar and the items below do not feed it.
  const agentsRow = checkRow('Background agents under the terminal', () => toggleKey('paneAgents'));
  const masterWrap = el('div', 'sg-rows');
  masterWrap.append(
    inside.row,
    el('div', 'sg-cap', 'Claude Code’s own line, drawn at the bottom of the terminal'),
    under.row,
    el('div', 'sg-cap', 'the app’s bar below the terminal'),
    agentsRow.row,
    el('div', 'sg-cap', 'the agents a session runs, also listed by Claude Code itself'),
  );
  statusPage.append(masterWrap);

  const itemsWrap = el('div', 'sg-rows sg-items');
  itemsWrap.setAttribute('role', 'group');
  itemsWrap.setAttribute('aria-label', 'status line items');
  const rowEls = new Map<keyof StatusLineCfg, HTMLButtonElement>();
  const boxEls = new Map<keyof StatusLineCfg, HTMLElement>();
  for (const r of ITEM_ROWS) {
    const { row, box } = checkRow(r.label, () => toggleKey(r.key));
    row.append(el('span', 'sg-val', r.sample));
    rowEls.set(r.key, row);
    boxEls.set(r.key, box);
    itemsWrap.append(row);
    if (r.caption !== undefined) itemsWrap.append(el('div', 'sg-cap', r.caption));
  }
  statusPage.append(itemsWrap);

  const resetBtn = button('sg-textbtn', 'Reset to defaults', () => resetAll());
  resetBtn.title = 'restore the status line to its default on and off items';
  const resetRow = el('div', 'sg-actions');
  resetRow.append(resetBtn);
  statusPage.append(resetRow);

  // ======================================================================
  // Preferences — three live blocks: the key rows (part B5), the Tools block
  // that picks which cards the New session dialog offers, and the Defaults
  // block that holds how the app behaves (part B6).
  // ======================================================================
  const prefsPage = newPage(
    'prefs',
    'Preferences',
    // Three blocks since B6: the keys, which cards the New session dialog
    // offers, and how the app behaves.
    'Your tools and how the app behaves.',
  );

  // The API keys block and its live rows are `settings-apikeys.ts` since O8,
  // built here, above the Tools block.
  const { keyRows, syncKeyRows, refreshKeys, clearKeyFields } = createKeyRows(prefsPage);

  // ---- Tools: which cards the New session dialog offers (B6, D1) ----------
  // A checked row = a visible card. The refusal for the last one is stated in
  // that row's own caption slot: a dialog or a toast for a rule the user just
  // met inside a row would answer somewhere else than where the question was
  // asked.
  prefsPage.append(
    el('h3', 'sg-sub', 'Tools'),
    el('p', 'sg-lead', 'Cards shown in the New session dialog.'),
  );
  const toolWrap = el('div', 'sg-rows');
  toolWrap.setAttribute('role', 'group');
  toolWrap.setAttribute('aria-label', 'tools shown in the New session dialog');
  const toolRows = new Map<string, { row: HTMLButtonElement; box: HTMLElement; cap: HTMLElement }>();
  for (const c of TOOL_CARDS) {
    const { row, box } = checkRow(c.label, () => toggleTool(c.id), c.icon);
    const cap = el('div', 'sg-cap');
    // The refusal is news, not decoration: a live region says it once, where
    // the keyboard already is.
    cap.setAttribute('role', 'status');
    cap.hidden = true;
    toolRows.set(c.id, { row, box, cap });
    toolWrap.append(row, cap);
  }
  prefsPage.append(toolWrap);

  // ---- Defaults: how the app behaves (B6) ---------------------------------
  prefsPage.append(el('h3', 'sg-sub', 'Defaults'));
  const defWrap = el('div', 'sg-rows');
  const defRows = new Map<keyof BehaviourCfg, { row: HTMLButtonElement; box: HTMLElement }>();
  for (const d of DEFAULT_ROWS) {
    const { row, box } = checkRow(d.label, () => toggleBehaviour(d.key));
    defRows.set(d.key, { row, box });
    defWrap.append(row, el('div', 'sg-cap', d.caption));
  }
  const mascotRow = checkRow(MASCOT_LABEL, () => toggleMascot());
  defWrap.append(mascotRow.row, el('div', 'sg-cap', MASCOT_CAPTION));
  prefsPage.append(defWrap);


  // ---- the Tools and Defaults rows, live (Nocturne B6) ---------------------

  /** Reflect both stores onto their rows (boxes + aria), never the other way. */
  function syncPrefsRows(): void {
    const hidden = new Set(getHiddenTools());
    for (const c of TOOL_CARDS) {
      const r = toolRows.get(c.id);
      if (r === undefined) continue;
      const on = !hidden.has(c.id);
      r.row.setAttribute('aria-pressed', on ? 'true' : 'false');
      r.box.textContent = on ? '✓' : '';
    }
    const cfg = getBehaviour();
    for (const d of DEFAULT_ROWS) {
      const r = defRows.get(d.key);
      if (r === undefined) continue;
      r.row.setAttribute('aria-pressed', cfg[d.key] ? 'true' : 'false');
      r.box.textContent = cfg[d.key] ? '✓' : '';
    }
    const mascotOn = getMascotEnabled();
    mascotRow.row.setAttribute('aria-pressed', mascotOn ? 'true' : 'false');
    mascotRow.box.textContent = mascotOn ? '✓' : '';
  }

  /** The refusal, in one row's caption slot, cleared again on its own. */
  let floorTimer = 0;
  function sayToolsFloor(id: string): void {
    const r = toolRows.get(id);
    if (r === undefined) return;
    clearToolsFloor();
    // Reveal BEFORE the text: a `role="status"` node filled while it is
    // hidden is a change no screen reader announces.
    r.cap.hidden = false;
    r.cap.textContent = TOOLS_FLOOR;
    floorTimer = window.setTimeout(() => {
      clearToolsFloor();
    }, TOOLS_FLOOR_MS);
  }

  function clearToolsFloor(): void {
    if (floorTimer !== 0) {
      window.clearTimeout(floorTimer);
      floorTimer = 0;
    }
    for (const r of toolRows.values()) {
      r.cap.textContent = '';
      r.cap.hidden = true;
    }
  }

  /**
   * Show or hide ONE card. The last visible card cannot be hidden (D1): the
   * New session dialog with an empty grid is a dialog that cannot launch
   * anything, so the row refuses in place and nothing is written.
   */
  function toggleTool(id: string): void {
    const before = getHiddenTools();
    const hidden = new Set(before);
    if (hidden.has(id)) hidden.delete(id);
    else if (TOOL_CARDS.length - hidden.size <= 1) {
      sayToolsFloor(id);
      return;
    } else hidden.add(id);
    clearToolsFloor();
    setHiddenTools(TOOL_CARDS.map((c) => c.id).filter((cid) => hidden.has(cid)));
    syncPrefsRows();
    writes++;
    log.debug(`prefs tools: hidden=${getHiddenTools().join(' ') || 'none'}`);
    void api.updatePrefs(toolsPatch(getHiddenTools()), DEAD_PREFS_KEYS).catch(() => {
      // A preference that was not stored must not keep claiming it was.
      setHiddenTools(before);
      syncPrefsRows();
      log.warn('the tools preference was not saved');
    });
  }

  /** Flip one behaviour toggle. A failed write puts the row back where it was. */
  function toggleBehaviour(key: keyof BehaviourCfg): void {
    const before = getBehaviour();
    setBehaviour({ ...before, [key]: !before[key] });
    syncPrefsRows();
    writes++;
    log.debug(`prefs behaviour: ${key}=${getBehaviour()[key]}`);
    void api.updatePrefs(behaviourPatch(getBehaviour()), DEAD_PREFS_KEYS).catch(() => {
      setBehaviour(before);
      syncPrefsRows();
      log.warn(`the ${key} preference was not saved`);
    });
  }

  /**
   * Flip the peek mascot (C1). The mascot page reads `prefs.mascot` on its
   * next poll, so the switch acts within ~2 s; a failed write puts the row
   * back where it was.
   */
  function toggleMascot(): void {
    const before = getMascotEnabled();
    setMascotEnabled(!before);
    syncPrefsRows();
    writes++;
    log.debug(`prefs mascot: enabled=${!before}`);
    void api.updatePrefs(mascotPatch(!before), DEAD_PREFS_KEYS).catch(() => {
      setMascotEnabled(before);
      syncPrefsRows();
      log.warn('the mascot preference was not saved');
    });
  }

  // ======================================================================
  // Keyboard — the whole table the shortcuts overlay draws, in a layout that
  // fits this page (ui/shortcuts-rows.ts)
  // ======================================================================
  const keysPage = newPage(
    'keys',
    'Keyboard',
    'Almost everything you type goes straight to the terminal. The app only listens for these.',
  );
  // The overlay lays a row out in three columns; 640 minus the nav leaves no
  // room for that, so the page uses the overlay's OWN narrow-window stack:
  // what you press, what it does, where the same thing lives in the UI — one
  // vocabulary, one reading order, two widths.
  const keyList = el('div', 'sg-rows');
  for (const r of ROWS) {
    const row = el('div', 'sg-keyrow');
    const chips = el('span', 'sg-keychips');
    r.keys.forEach((k, i) => {
      if (i > 0) chips.append(el('span', 'sg-or', 'or'));
      // A mouse sentence is not a key: plain text, never a chip (overlay rule).
      chips.append(r.gesture === true ? el('span', 'sg-gesture', k) : el('kbd', 'sg-kbd', k));
    });
    row.append(chips, el('span', 'sg-rowlb', r.what), el('span', 'sg-keyui', r.ui));
    if (r.note !== undefined) row.append(el('div', 'sg-cap', r.note));
    keyList.append(row);
  }
  keysPage.append(keyList);

  // ======================================================================
  // Terminal colours — its own module (ui/term-colours.ts). LIVE since part
  // B9: every change on it goes through the injected control, which paints
  // every open terminal and persists the pair. The control is wrapped so a
  // colour counts as a write of this open — the re-read below must never undo
  // a choice the user just made.
  // ======================================================================
  const colours = buildTermColours('sg-tab-colours', {
    apply: (next) => {
      writes += 1;
      deps.theme.apply(next);
    },
    current: () => deps.theme.current(),
  });
  colours.root.id = 'sg-panel-colours';
  panelEls.set('colours', colours.root);
  bodyEl.append(colours.root);

  // The Background service page — its readouts, the update check and the
  // restart — is `settings-service.ts` since O8, built here, in nav order.
  const { renderBackend, sayAnswer } = createServicePage(newPage);

  // ---- footer --------------------------------------------------------------
  // v3's own footer: one accent-OUTLINE confirm. `.btn-accent` is the Nocturne
  // pair already in app.css (the pane area's empty state, the top bar's New
  // session) — the Legacy `.btn.is-acc` tint it replaces is built from alias
  // tokens part A8 deletes.
  const ft = el('footer', 'sg-ft');
  const doneBtn = button('btn-accent', 'Done', () => close());
  doneBtn.title = 'close settings (esc)';
  ft.append(doneBtn);

  const col = el('div', 'sg-col');
  col.append(bodyEl, ft);
  modal.append(nav, col);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close();
  });
  trapTab(modal);
  modalHost.append(scrim);

  // ---- pages ---------------------------------------------------------------
  let page: PageId = PAGES[0].id;

  function showPage(id: PageId): void {
    page = id;
    for (const p of PAGES) {
      const tab = tabEls.get(p.id);
      const panel = panelEls.get(p.id);
      const on = p.id === id;
      if (tab !== undefined) {
        tab.classList.toggle('is-sel', on);
        tab.setAttribute('aria-selected', on ? 'true' : 'false');
        tab.tabIndex = on ? 0 : -1;
      }
      if (panel !== undefined) panel.hidden = !on;
    }
    // A page swap must not leave the reader halfway down the previous one.
    bodyEl.scrollTop = 0;
  }

  // ---- toggles <-> store ---------------------------------------------------

  /** Writes since this open — a late boot-prefs re-read must not undo them. */
  let writes = 0;

  /**
   * The preview IS Claude's own line inside the terminal, so it follows
   * `enabled` alone and skips the pane-bar-only items — showing `2h 15m` in a
   * line that can never print it would promise the wrong thing.
   */
  function renderPreview(): void {
    const cfg = getStatusLine();
    const on = cfg.enabled ? ITEM_ROWS.filter((r) => r.paneOnly !== true && cfg[r.key]) : [];
    if (on.length === 0) {
      preview.replaceChildren(el('span', 'sg-prevempty', 'Nothing selected, the bar is hidden'));
      return;
    }
    preview.replaceChildren(
      // The samples are invented ($0.42, 5h 38%); without this marker the strip
      // reads as the user's own numbers.
      el('span', 'sg-prevlb', 'Example'),
      ...on.map((r) => {
        const item = el('span', 'sg-previtem');
        item.append(el('span', 'sg-prevlb', r.label), el('span', 'sg-prevval', r.sample));
        return item;
      }),
    );
  }

  /** Reflect the whole stored config onto the rows (boxes, aria, disabled). */
  function syncRows(): void {
    const cfg = getStatusLine();
    inside.row.setAttribute('aria-pressed', cfg.enabled ? 'true' : 'false');
    inside.box.textContent = cfg.enabled ? '✓' : '';
    under.row.setAttribute('aria-pressed', cfg.paneBar ? 'true' : 'false');
    under.box.textContent = cfg.paneBar ? '✓' : '';
    agentsRow.row.setAttribute('aria-pressed', cfg.paneAgents ? 'true' : 'false');
    agentsRow.box.textContent = cfg.paneAgents ? '✓' : '';
    // The items feed BOTH bars, so they only stop deciding when both are gone.
    const anyBar = cfg.enabled || cfg.paneBar;
    for (const r of ITEM_ROWS) {
      const row = rowEls.get(r.key);
      const box = boxEls.get(r.key);
      if (row === undefined || box === undefined) continue;
      row.setAttribute('aria-pressed', cfg[r.key] ? 'true' : 'false');
      box.textContent = cfg[r.key] ? '✓' : '';
      // With both bars switched off the items decide nothing; the group dims
      // and stops taking input (the launch dialog's is-disabled idiom).
      row.disabled = !anyBar;
    }
    itemsWrap.classList.toggle('is-disabled', !anyBar);
    renderPreview();
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
      `prefs statusLine: enabled=${cfg.enabled} paneBar=${cfg.paneBar} paneAgents=${cfg.paneAgents} ` +
        ITEM_ROWS.map((r) => `${r.key}=${cfg[r.key]}`).join(' '),
    );
    void api.updatePrefs(statusLinePatch(cfg), DEAD_PREFS_KEYS).catch(() => {
      // Non-fatal: the in-memory value stands for this run, and the sessions'
      // own line keeps drawing what is on disk — but a write that did not land
      // is said in the log, like the tools and behaviour writes say it.
      log.warn('the status line preference was not saved');
    });
  }

  function toggleKey(key: keyof StatusLineCfg): void {
    const cur = getStatusLine();
    setStatusLine({ ...cur, [key]: !cur[key] });
    syncRows();
    deps.repaintStatus();
    persist();
  }

  function resetAll(): void {
    setStatusLine(statusLineDefaults());
    syncRows();
    deps.repaintStatus();
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
      .join(', ');
  }

  // The session list refreshes on the poll; keep the notice honest while open.
  st.subscribe((kind) => {
    if (scrim.hidden) return;
    if (kind === 'sessions') renderNotice();
    if (kind === 'conn') renderBackend();
  });

  // ---- open / close --------------------------------------------------------
  let restoreTo: HTMLElement | null = null;


  function open(opts?: SettingsOpenOpts): void {
    const focusKey = opts?.focusKey !== undefined && isKeyedTool(opts.focusKey) ? opts.focusKey : null;
    if (!scrim.hidden) {
      // Already open: an opener that names a destination still gets to send the
      // user there (the launch dialog's `Add key`).
      if (opts !== undefined) goTo(opts.page ?? (focusKey !== null ? 'prefs' : page), focusKey);
      return;
    }
    restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    writes = 0;
    // The gear opens the panel on the page about the sessions' own status line;
    // a named destination wins.
    showPage(opts?.page ?? (focusKey !== null ? 'prefs' : PAGES[0].id));
    syncRows();
    syncPrefsRows();
    renderNotice();
    renderBackend();
    clearKeyFields();
    syncKeyRows();
    refreshKeys();
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
        // The same re-read serves the B6 stores: another window may have
        // hidden a card or flipped a toggle since this page booted.
        initBehaviour(bag.behaviour);
        initMascot(bag.mascot);
        initHiddenTools(
          bag.tools,
          TOOL_CARDS.map((c) => c.id),
        );
        // Terminal colours too: another window's choice is already painted
        // there, and this page must not show the one this window booted with.
        // ADOPT, not apply: this pair came from the server, so it is painted
        // and cached but never written back — and the control drops it outright
        // if a write of ours is still pending (a close() flush in the air), or
        // a stale answer would revert the choice AND outlive it on disk.
        const pair = themeFromBag(bag.theme);
        if (pair !== null) deps.theme.adopt(pair);
        colours.sync();
        syncRows();
        syncPrefsRows();
        // The re-read can change what the pane bar draws (another window turned
        // an item off), and the panes hear nothing about a prefs read.
        deps.repaintStatus();
      })
      .catch(() => {
        // Keep the in-memory config; nothing to say.
      });
    if (focusKey !== null) focusKeyField(focusKey);
    else tabEls.get(page)?.focus();
  }

  /** Swap to a page and, when asked, put the keyboard in one tool's key field. */
  function goTo(to: PageId, focusKey: KeyedTool | null): void {
    showPage(to);
    if (focusKey !== null) focusKeyField(focusKey);
    else tabEls.get(to)?.focus();
  }

  /** The keyboard lands ON the field the opener sent the user here to fill. */
  function focusKeyField(tool: KeyedTool): void {
    const r = keyRows.get(tool);
    if (r !== undefined) r.input.focus();
    else tabEls.get(page)?.focus();
  }

  function close(): void {
    if (scrim.hidden) return;
    // A colour change is debounced server-side; the dialog closing is the
    // moment it has to become durable, not ~300ms of luck later.
    void deps.theme.flush();
    clearKeyFields();
    syncKeyRows();
    // An answer is about the moment it was asked for: the next open asks again.
    sayAnswer(null);
    clearToolsFloor();
    scrim.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    if (restoreTo !== null && restoreTo.isConnected) restoreTo.focus();
    else anchor.focus();
    restoreTo = null;
  }

  showPage(page);

  const ctl: SettingsPanel = {
    open,
    close,
    toggle: () => (scrim.hidden ? open() : close()),
    isOpen: () => !scrim.hidden,
  };
  panelCtl = ctl;
  return ctl;
}
