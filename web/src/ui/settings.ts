/**
 * App settings — a modal with a LEFT NAV (Nocturne A7, v3
 * `session-manager-v3.html` lines 561-640): a 170px column of page names beside
 * a scrolling page. Five pages:
 *
 *   Status bar          what a session states about itself — LIVE, the prefs
 *                       `statusLine` key. Since Nocturne B1 one checklist
 *                       drives TWO places: Claude Code's own line inside the
 *                       terminal (`enabled`) and the app's bar under it
 *                       (`paneBar`, ui/pane-status-model.ts).
 *   Preferences         which tools show up and the keys they need — MOCK until
 *                       part B6; every control is inert and says so.
 *   Keyboard            the chords the app takes off the terminal, plus the
 *                       link to the full shortcuts overlay — unchanged.
 *   Terminal colours    ground + text for the terminals (ui/term-colours.ts) —
 *                       LOCAL to the page until part B9 wires ui/theme.ts.
 *   Background service  version, uptime, Check for updates, Restart — the
 *                       existing flows, restyled.
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
import type { SessionInfo } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import { log } from '../log.ts';
import * as st from '../state.ts';
import { el, button, trapTab } from './util.ts';
import { NOT_YET, TOOL_CARDS, commandLabel } from './launch-args.ts';
import { openReleasesPage } from './releases.ts';
import { openRestartConfirm, runtimeFacts } from './update.ts';
import { buildTermColours } from './term-colours.ts';
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
  /** Opens the shortcuts overlay (one instance, shared with the `?` key). */
  openShortcuts(): void;
  /**
   * Redraws the status bar under every visible terminal (`ui/panes.ts`
   * repaintStatus). Injected, not imported: that module pulls @xterm/xterm in,
   * and this one has to stay drivable under `node --test`. A checklist change
   * reaches Claude's own line by itself (the script re-reads prefs.json every
   * couple of seconds) but nothing tells the panes, and a preference the user
   * just clicked must not wait for the next session event to show up.
   */
  repaintStatus(): void;
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

/**
 * The Keyboard page: the things the app takes off the terminal, said where
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
  { what: 'copy the selection', keys: ['ctrl+shift+c', 'ctrl+insert'] },
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
 * The Preferences page's rows — MOCK until part B6. `needsKey` decides whether
 * the row shows a key field. Nothing here claims a key EXISTS: an invented
 * "Key added" row would be the one mock a user could act on by mistake.
 */
interface ProviderRow {
  mark: string;
  label: string;
  keyText: string;
  needsKey: boolean;
  /** The known agent's tile carries the accent family (v3). */
  agent?: boolean;
}

/**
 * What each row says about its key, by the New session dialog's own card id.
 * The three tools part B5 will wire say what that dialog says about them —
 * `NOT_YET`, one string in one place — because "Needs a key" would promise a
 * key is all that is missing. A card with no entry here (the custom-command
 * `Other`) gets no provider row.
 */
const ROW_KEYS: Record<string, { keyText: string; needsKey: boolean; agent?: boolean }> = {
  claude: { keyText: 'Uses your Claude login', needsKey: false, agent: true },
  codex: { keyText: NOT_YET, needsKey: true },
  gemini: { keyText: NOT_YET, needsKey: true },
  grok: { keyText: NOT_YET, needsKey: true },
  terminal: { keyText: 'No key needed', needsKey: false },
};

/**
 * The marks and names are the New session dialog's own table (launch-args.ts
 * `TOOL_CARDS`, whose `claude` entry carries `AGENT_LABEL`) in its own order, so
 * the two surfaces cannot drift apart and the product name lives in one place.
 */
const PROVIDER_ROWS: ProviderRow[] = TOOL_CARDS.flatMap((c) => {
  const k = ROW_KEYS[c.id];
  return k === undefined ? [] : [{ mark: c.mark, label: c.label, ...k }];
});

/** The Defaults block on the Preferences page — MOCK until part B6. */
const DEFAULT_ROWS: { label: string; on: boolean }[] = [
  { label: 'Reopen tabs on start', on: true },
  { label: 'Confirm before ending a session', on: true },
  { label: 'Notifications when a session needs you', on: true },
  { label: 'Follow output', on: false },
];

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

  /** A boolean row: a real button, state in aria-pressed, no hover-only affordance. */
  function checkRow(label: string, onToggle?: () => void): {
    row: HTMLButtonElement;
    box: HTMLElement;
  } {
    const row = button('sg-row', '', onToggle);
    const box = el('span', 'sg-box');
    box.setAttribute('aria-hidden', 'true');
    row.append(box, el('span', 'sg-rowlb', label));
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
  const masterWrap = el('div', 'sg-rows');
  masterWrap.append(
    inside.row,
    el('div', 'sg-cap', 'Claude Code’s own line, drawn at the bottom of the terminal'),
    under.row,
    el('div', 'sg-cap', 'the app’s bar below the terminal'),
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
  // Preferences — MOCK until part B6. Every control is disabled, and one line
  // says so (the A4 inert-card idiom: the outline stays, the ink drops).
  // ======================================================================
  const prefsPage = newPage(
    'prefs',
    'Preferences',
    'Which tools show up when you start a session, and the keys they need.',
  );
  const provWrap = el('div', 'sg-rows');
  for (const p of PROVIDER_ROWS) {
    const row = el('div', 'sg-prow');
    const mark = el('span', p.agent === true ? 'sg-mark is-agent' : 'sg-mark', p.mark);
    mark.setAttribute('aria-hidden', 'true');
    const txt = el('div', 'sg-prowtxt');
    txt.append(el('span', 'sg-rowlb', p.label), el('span', 'sg-prowkey', p.keyText));
    row.append(mark, txt);
    if (p.needsKey) {
      const inp = el('input', 'sg-keyin');
      // Same shape as the app's one real credential field (ui/github.ts): a key
      // is never plain text on screen, and never offered as a saved login. No
      // `name`, so nothing can autofill it either.
      inp.type = 'password';
      inp.autocomplete = 'new-password';
      inp.placeholder = 'Paste API key';
      inp.disabled = true;
      inp.setAttribute('aria-label', `${p.label} key`);
      const show = button('sg-smallbtn', 'Show');
      show.disabled = true;
      row.append(inp, show);
    }
    provWrap.append(row);
  }
  prefsPage.append(provWrap);

  prefsPage.append(el('h3', 'sg-sub', 'Defaults'));
  const defWrap = el('div', 'sg-rows');
  for (const d of DEFAULT_ROWS) {
    const { row, box } = checkRow(d.label);
    row.setAttribute('aria-pressed', d.on ? 'true' : 'false');
    box.textContent = d.on ? '✓' : '';
    row.disabled = true;
    defWrap.append(row);
  }
  prefsPage.append(defWrap);

  /**
   * PLACEHOLDER MARKER — DELETE WITH THE MOCK (part B6). Every control on this
   * page is inert, and a settings page that silently forgets what it was told
   * is worse than one that is not there. One function, one call site.
   */
  function prefsPlaceholderNote(): HTMLElement {
    return el('p', 'sg-note', 'Example settings until the app saves them.');
  }
  prefsPage.append(prefsPlaceholderNote());

  // ======================================================================
  // Keyboard — the gestures that are NOT visible controls anywhere else
  // ======================================================================
  const keysPage = newPage(
    'keys',
    'Keyboard',
    'Almost everything you type goes straight to the terminal. The app only listens for these.',
  );
  const keyList = el('div', 'sg-rows');
  for (const r of KEY_ROWS) {
    const row = el('div', 'sg-keyrow');
    const chips = el('span', 'sg-keychips');
    if (r.keys !== undefined) for (const k of r.keys) chips.append(el('kbd', 'sg-kbd', k));
    // A mouse sentence is not a key: plain text, never a chip (overlay rule).
    if (r.gesture !== undefined) chips.append(el('span', 'sg-gesture', r.gesture));
    row.append(el('span', 'sg-rowlb', r.what), chips);
    keyList.append(row);
  }
  keysPage.append(keyList);
  const allKeysBtn = button('sg-link', 'all shortcuts', () => deps.openShortcuts());
  allKeysBtn.setAttribute('aria-haspopup', 'dialog');
  const allKeysRow = el('div', 'sg-actions');
  allKeysRow.append(allKeysBtn);
  keysPage.append(allKeysRow);

  // ======================================================================
  // Terminal colours — its own module (ui/term-colours.ts). Local to the page
  // until part B9: nothing here paints a terminal yet.
  // ======================================================================
  const colours = buildTermColours('sg-tab-colours');
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
  // updates with the tools it was cloned with, and a link to a releases page
  // would be an instruction that does not apply to it.
  const checkBtn = button('sg-link', 'Check for updates', () => {
    log.info('opening the releases page in the browser');
    openReleasesPage();
  });
  checkBtn.title = 'opens the releases page in your browser';
  checkBtn.hidden = true;
  const restartBtn = button('sg-outbtn', 'Restart service', () => openRestartConfirm('settings'));
  restartBtn.setAttribute('aria-haspopup', 'dialog');
  card.append(facts, checkBtn, restartBtn);
  servicePage.append(card);

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
      `prefs statusLine: enabled=${cfg.enabled} paneBar=${cfg.paneBar} ` +
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

  function open(): void {
    if (!scrim.hidden) return;
    restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    writes = 0;
    // The gear opens the panel on the page about the sessions' own status line.
    showPage(PAGES[0].id);
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
        // The re-read can change what the pane bar draws (another window turned
        // an item off), and the panes hear nothing about a prefs read.
        deps.repaintStatus();
      })
      .catch(() => {
        // Keep the in-memory config; nothing to say.
      });
    tabEls.get(page)?.focus();
  }

  function close(): void {
    if (scrim.hidden) return;
    scrim.hidden = true;
    anchor.setAttribute('aria-expanded', 'false');
    if (restoreTo !== null && restoreTo.isConnected) restoreTo.focus();
    else anchor.focus();
    restoreTo = null;
  }

  showPage(page);

  return {
    open,
    close,
    toggle: () => (scrim.hidden ? open() : close()),
    isOpen: () => !scrim.hidden,
  };
}
