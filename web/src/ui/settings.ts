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
 *                       door that ends a session, and on every terminal write.
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
import type { KeyedTool, KeyStatus, SessionInfo, UpdateStatus } from '../../../shared/protocol.ts';
import { isKeyedTool, UPDATE_NEW_VERSION_AVAILABLE } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import { log } from '../log.ts';
import * as st from '../state.ts';
import { el, button, trapTab } from './util.ts';
import { TOOL_CARDS, commandLabel } from './launch-args.ts';
import { applyRuntime, openRestartConfirm, runtimeFacts } from './update.ts';
import { releaseSentence } from './update-model.ts';
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
  initBehaviour,
  initHiddenTools,
  setBehaviour,
  setHiddenTools,
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
 * The Preferences page's key rows, LIVE since part B5. They are listed for
 * every tool the app knows, hidden card or not (B6): a key is about the tool,
 * not about whether its card shows up in the New session dialog.
 * `tool` names the keyed tool whose field the row carries — absent = no field,
 * because there is no key this app can store for it.
 */
interface ProviderRow {
  mark: string;
  label: string;
  keyText: string;
  /** The keyed tool this row saves for; absent = the row is words only. */
  tool?: KeyedTool;
  /** The known agent's tile carries the accent family (v3). */
  agent?: boolean;
}

/**
 * What each row says about its key, by the New session dialog's own card id.
 * Codex gets NO field on purpose (user decision 2026-09-18): a key alone does
 * not authenticate it, so the honest line is that it signs in where it runs.
 * A card with no entry here (the custom-command `Other`) gets no provider row.
 */
const ROW_KEYS: Record<string, { keyText: string; tool?: KeyedTool; agent?: boolean }> = {
  claude: { keyText: 'Uses your Claude login. A saved key is used instead.', tool: 'claude', agent: true },
  codex: { keyText: 'Signs in inside the terminal' },
  gemini: { keyText: 'Needs an API key, or a sign-in inside the terminal.', tool: 'gemini' },
  grok: { keyText: 'Needs an API key, or a sign-in inside the terminal.', tool: 'grok' },
  terminal: { keyText: 'No key needed' },
};

/** What the row says about the key it has: stored here, or only in the environment. */
const KEY_SAVED = 'Saved';
const KEY_ENV_ONLY = 'Set outside the app';

/**
 * The marks and names are the New session dialog's own table (launch-args.ts
 * `TOOL_CARDS`, whose `claude` entry carries `AGENT_LABEL`) in its own order, so
 * the two surfaces cannot drift apart and the product name lives in one place.
 */
const PROVIDER_ROWS: ProviderRow[] = TOOL_CARDS.flatMap((c) => {
  const k = ROW_KEYS[c.id];
  return k === undefined ? [] : [{ mark: c.mark, label: c.label, ...k }];
});

/**
 * The Defaults block on the Preferences page — LIVE since part B6, one row per
 * member of the behaviour store (ui/prefs-model.ts). The captions say what the
 * switch really decides, because all three are invisible until the moment they
 * act: a start, a click on a door, a line of output arriving.
 *
 * The v3 markup's fourth row (`Notifications when a session needs you`) is not
 * here: there is no notification mechanism to switch off yet (user decision D2,
 * 2026-09-22 — it returns with the peek mascot in part C1).
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

/** The Tools block's refusal, said in the row's own caption slot (D1). */
const TOOLS_FLOOR = 'Keep at least one tool visible.';

/**
 * How long that refusal stays on screen. 3000 ms is the app's own "for a
 * moment" already: the armed two-step in ui/util.ts disarms after exactly that.
 */
const TOOLS_FLOOR_MS = 3000;

/**
 * The Background service page's own words (D4). The check asks the backend,
 * which asks the release page; the four outcomes are these, and the version in
 * the second one is the only string here that came from outside the app — it
 * passes `releaseSentence`'s shape gate before it is ever printed.
 */
const CHECK_LABEL = 'Check for updates';
const CHECK_BUSY = 'Checking…';
const CHECK_NEWEST = 'You have the newest version.';
const CHECK_INSTALLED = 'A new version is installed. Restart the service to use it.';
const CHECK_FAILED = 'Could not check for updates.';

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
  function checkRow(label: string, onToggle?: () => void, mark?: string): {
    row: HTMLButtonElement;
    box: HTMLElement;
  } {
    const row = button('sg-row', '', onToggle);
    const box = el('span', 'sg-box');
    box.setAttribute('aria-hidden', 'true');
    row.append(box);
    if (mark !== undefined) {
      const tile = el('span', 'sg-mark', mark);
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

  /** One live key row's controls, kept so the page can reflect what it learns. */
  interface KeyRowCtl {
    label: string;
    input: HTMLInputElement;
    show: HTMLButtonElement;
    save: HTMLButtonElement;
    remove: HTMLButtonElement;
    state: HTMLElement;
    err: HTMLElement;
  }
  const keyRows = new Map<KeyedTool, KeyRowCtl>();
  /** Last answer from GET /api/keys; null until one arrives. */
  let keyStatus: KeyStatus | null = null;

  const provWrap = el('div', 'sg-rows');
  for (const p of PROVIDER_ROWS) {
    const row = el('div', 'sg-prow');
    const mark = el('span', p.agent === true ? 'sg-mark is-agent' : 'sg-mark', p.mark);
    mark.setAttribute('aria-hidden', 'true');
    const txt = el('div', 'sg-prowtxt');
    txt.append(el('span', 'sg-rowlb', p.label), el('span', 'sg-prowkey', p.keyText));
    row.append(mark, txt);
    const tool = p.tool;
    if (tool !== undefined) {
      const inp = el('input', 'sg-keyin');
      // Same shape as the app's one real credential field (ui/github.ts): a key
      // is never plain text on screen unless the user asks, never offered as a
      // saved login, and with no `name` for an autofill to match.
      inp.type = 'password';
      inp.autocomplete = 'new-password';
      inp.spellcheck = false;
      inp.placeholder = 'Paste API key';
      inp.setAttribute('aria-label', `${p.label} key`);
      inp.id = `sg-key-${tool}`;
      const show = button('sg-smallbtn', 'Show', () => toggleShow(tool));
      show.setAttribute('aria-pressed', 'false');
      const save = button('sg-smallbtn', 'Save', () => void saveKey(tool));
      const remove = button('sg-smallbtn', 'Remove', () => void removeKey(tool));
      const state = el('span', 'sg-keystate', '');
      const line = el('div', 'sg-keyline');
      line.append(inp, show, save, remove);
      const err = el('div', 'sg-keyerr');
      err.setAttribute('role', 'alert');
      err.hidden = true;
      txt.append(line, err);
      row.append(state);
      // Save stays off until there is something to save — a key-shaped field
      // with nothing in it has no verb.
      inp.addEventListener('input', () => syncKeyRow(tool));
      keyRows.set(tool, { label: p.label, input: inp, show, save, remove, state, err });
    }
    provWrap.append(row);
  }
  prefsPage.append(el('h3', 'sg-sub', 'API keys'), provWrap);

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
    const { row, box } = checkRow(c.label, () => toggleTool(c.id), c.mark);
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
  prefsPage.append(defWrap);

  // ---- the key rows, live --------------------------------------------------

  /**
   * Reflect what the page knows onto ONE row: the state word beside the name
   * (`Saved`, or `Set outside the app` when only the environment carries one),
   * and which verbs can be used. The page only ever learns saved / not saved —
   * a key never comes back from the server, so the field always starts empty.
   */
  function syncKeyRow(tool: KeyedTool): void {
    const r = keyRows.get(tool);
    if (r === undefined) return;
    const saved = keyStatus?.saved[tool] === true;
    const env = keyStatus?.env[tool] === true;
    r.state.textContent = saved ? KEY_SAVED : env ? KEY_ENV_ONLY : '';
    r.save.disabled = r.input.value.trim() === '';
    r.remove.disabled = !saved;
  }

  function syncKeyRows(): void {
    for (const tool of keyRows.keys()) syncKeyRow(tool);
  }

  /** Show the key that is being typed, for as long as the user asks. */
  function toggleShow(tool: KeyedTool): void {
    const r = keyRows.get(tool);
    if (r === undefined) return;
    const showing = r.input.type === 'text';
    r.input.type = showing ? 'password' : 'text';
    r.show.textContent = showing ? 'Show' : 'Hide';
    r.show.setAttribute('aria-pressed', showing ? 'false' : 'true');
  }

  function keyErr(tool: KeyedTool, msg: string | null): void {
    const r = keyRows.get(tool);
    if (r === undefined) return;
    r.err.textContent = msg ?? '';
    r.err.hidden = msg === null;
  }

  /**
   * What to SAY about a failed key call. The server's own sentences are written
   * for the user and are rendered verbatim; a failure with no sentence (a
   * network drop, or a status whose body the client could not read) falls back
   * to plain words — `HTTP 413` is a status code, not something to read.
   */
  function keyFailure(e: unknown, fallback: string): string {
    const msg = e instanceof Error ? e.message : '';
    return msg !== '' && !/^HTTP \d+$/.test(msg) ? msg : fallback;
  }

  /**
   * Hand ONE key to the backend and forget it. The field is cleared in the same
   * turn the request is made, the local reference dies with this function, and
   * nothing about the value is logged — only which tool was written.
   */
  async function saveKey(tool: KeyedTool): Promise<void> {
    const r = keyRows.get(tool);
    if (r === undefined) return;
    const key = r.input.value.trim();
    if (key === '') return;
    keyErr(tool, null);
    r.save.disabled = true;
    try {
      await api.saveKey(tool, key);
      r.input.value = '';
      if (r.input.type === 'text') toggleShow(tool);
      keyStatus = withSaved(keyStatus, tool, true);
      log.info(`key saved for ${tool}`);
    } catch (e) {
      // The server's sentence is written for the user; it never echoes the value.
      keyErr(tool, keyFailure(e, 'That key was not saved.'));
    } finally {
      syncKeyRow(tool);
    }
  }

  /** Forget the stored key. An environment variable set outside the app stays. */
  async function removeKey(tool: KeyedTool): Promise<void> {
    const r = keyRows.get(tool);
    if (r === undefined) return;
    keyErr(tool, null);
    r.remove.disabled = true;
    try {
      await api.deleteKey(tool);
      keyStatus = withSaved(keyStatus, tool, false);
      log.info(`key cleared for ${tool}`);
    } catch (e) {
      keyErr(tool, keyFailure(e, 'That key was not removed.'));
    } finally {
      syncKeyRow(tool);
    }
  }

  /** The status bag with ONE tool's saved bit replaced (never mutated in place). */
  function withSaved(cur: KeyStatus | null, tool: KeyedTool, saved: boolean): KeyStatus {
    const base: KeyStatus = cur ?? {
      saved: { claude: false, gemini: false, grok: false },
      env: { claude: false, gemini: false, grok: false },
    };
    return { saved: { ...base.saved, [tool]: saved }, env: { ...base.env } };
  }

  /** Re-read which keys exist. Never throws: a failed read leaves the rows blank. */
  function refreshKeys(): void {
    void api
      .getKeys()
      .then((s) => {
        keyStatus = s;
        syncKeyRows();
      })
      .catch(() => {
        // Nothing to say: the rows simply claim no key.
      });
  }

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

  // ======================================================================
  // Background service — the program that runs the sessions, and the one
  // button that replaces it with the version currently on disk (2026-09-06,
  // user's request). Two readouts and an action: no dashboard, no graphs. An
  // INSTALLED app gets a second, quieter verb between them (2026-09-08): where
  // to go and get a newer version. Text link, not a second button — the weight
  // ordering says which one is the act with consequences.
  // ======================================================================
  const servicePage = newPage(
    'service',
    'Background service',
    'Your sessions run in a service that keeps going while this window is open. Restarting it picks up a new version of the app. Every running session closes, but stays in history.',
  );
  const card = el('div', 'sg-svc');
  const facts = el('div', 'sg-svcfacts');
  const factVer = el('span', 'sg-svcver');
  const factUp = el('span', 'sg-svcup');
  facts.append(factVer, factUp);
  // Only an installed app can be updated by downloading one; a developer clone
  // updates with the tools it was cloned with, and asking a release page about
  // it would be a question that does not apply to it.
  const checkBtn = button('sg-link', CHECK_LABEL, () => {
    void runCheck();
  });
  checkBtn.title = 'asks now whether a newer version exists';
  checkBtn.hidden = true;
  const restartBtn = button('sg-outbtn', 'Restart service', () => openRestartConfirm('settings'));
  restartBtn.setAttribute('aria-haspopup', 'dialog');
  card.append(facts, checkBtn, restartBtn);
  servicePage.append(card);

  // The answer to the check, under the facts it is about: one sentence, and —
  // when a release is waiting online — the same act the toast offers.
  const answer = el('div', 'sg-svcanswer');
  answer.hidden = true;
  answer.setAttribute('role', 'status');
  const answerText = el('span', 'sg-svcmsg', '');
  // The `Update` flow is the toast's and the pill's: this button only opens the
  // question, which the update module then asks in its own words.
  const updateBtn = button('sg-outbtn', 'Update', () => openRestartConfirm('settings-update'));
  updateBtn.setAttribute('aria-haspopup', 'dialog');
  updateBtn.hidden = true;
  answer.append(answerText, updateBtn);
  servicePage.append(answer);

  /**
   * The two readouts, refreshed on open and on every conn change (the runtime
   * poll writes both). `Running for` is a coarse duration on purpose: this line
   * is read once, not watched — the statusline already ticks a live clock.
   */
  function renderBackend(): void {
    const f = runtimeFacts();
    factVer.textContent = `Version ${f.version}`;
    factUp.textContent = `Running for ${f.runningFor}`;
    checkBtn.hidden = !st.state.installed;
  }

  /** Put an answer on the page, or take the line away again (null). */
  function sayAnswer(text: string | null, canUpdate = false): void {
    // Reveal BEFORE the text: a `role="status"` node filled while it is
    // hidden is a change no screen reader announces.
    answer.hidden = text === null;
    answerText.textContent = text ?? '';
    updateBtn.hidden = !canUpdate;
  }

  /** Which of the four sentences an answered check earns (D4). */
  function checkAnswer(status: UpdateStatus): { text: string; canUpdate: boolean } {
    if (!status.available) return { text: CHECK_NEWEST, canUpdate: false };
    // ONLINE: the release exists but is not on this machine, so the act is to
    // fetch it, and the sentence names the version the backend read — through
    // the model's own shape gate, the one place a remote tag is made printable.
    if (status.reason === UPDATE_NEW_VERSION_AVAILABLE) {
      return { text: releaseSentence(status.release), canUpdate: true };
    }
    // Anything else an installed backend can report means the newer version is
    // already here and only the running process is old.
    return { text: CHECK_INSTALLED, canUpdate: false };
  }

  /** True while a check is out — the button is the only way in, and it waits. */
  let checking = false;

  /**
   * Ask the backend to check NOW (Nocturne B6, D4). The button states that it
   * is working and stops taking clicks; the answer lands on the page, and then
   * the app re-reads the runtime the ONE way it always does, so the pill and
   * the toast learn the same news through the same path.
   */
  async function runCheck(): Promise<void> {
    if (checking) return;
    checking = true;
    checkBtn.disabled = true;
    checkBtn.textContent = CHECK_BUSY;
    sayAnswer(null);
    let answered = false;
    try {
      const status = await api.checkForUpdates();
      const a = checkAnswer(status);
      sayAnswer(a.text, a.canUpdate);
      answered = true;
      log.info(`update check: ${status.reason ?? 'up to date'}`);
    } catch {
      sayAnswer(CHECK_FAILED);
      log.warn('the update check did not answer');
    } finally {
      checking = false;
      checkBtn.disabled = false;
      checkBtn.textContent = CHECK_LABEL;
    }
    if (!answered) return;
    // The pill, the toast and this page all read one state; nothing here
    // writes it, and a failed re-read simply leaves the last known runtime.
    try {
      st.setRuntime(await api.getRuntime());
      applyRuntime();
      renderBackend();
    } catch {
      // Nothing to say: the 30 s poll asks again.
    }
  }

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

  /**
   * Empty every key field, drop its error and put it back to hidden. Run on
   * BOTH open and close: a key typed and never saved must not sit in an input's
   * `.value` for the rest of the page's life — a credential the user abandoned
   * is one the app stops holding, in the same gesture that abandons it.
   */
  function clearKeyFields(): void {
    for (const tool of keyRows.keys()) {
      const r = keyRows.get(tool);
      if (r === undefined) continue;
      r.input.value = '';
      if (r.input.type === 'text') toggleShow(tool);
      keyErr(tool, null);
    }
  }

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
