/**
 * App settings panel — the decided four (PROJECT-SCOPE "App settings panel",
 * user answers 2026-07-20), and nothing more:
 *
 *   1. Default model            → pre-selects the launch dialog's model field.
 *   2. Default permission mode  → pre-selects the dialog's permission cards
 *                                 (all four CLI modes incl. `plan`).
 *   3. Auto-run startup command → a line typed into every new claude session
 *                                 once it is ready (empty = off).
 *   4. Usage display (read-only)→ approximate Claude Code usage aggregates
 *                                 from GET /api/usage.
 *
 * A per-launch override ALWAYS wins over 1–3 (the dialog stays editable).
 * Defaults persist server-side in the prefs bag (`defaults`) via the shared
 * merge-on-write helper (api.updatePrefs), so the theme key and any other bag
 * key survive; changes take effect on the NEXT launch-dialog open with no
 * reload (the dialog reads getDefaults() live). The panel is a modal card in
 * the established dialog/popover language — plain label header (the shortcuts
 * overlay sibling), the dialog's own select + permission-card idioms for the
 * defaults, and a dense mono ledger for usage. NO new colors/tokens.
 *
 * Usage is fetched on open and on an explicit refresh only — never polled (the
 * 30s server cache makes opens cheap). Model strings are Claude-Code-log
 * derived: rendered via textContent, treated as untrusted display text.
 */
import type { SessionInfo, UiLaunchDefaults, UsageResponse } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import * as st from '../state.ts';
import { el, button, trapTab, fmtCount } from './util.ts';
import { PERMS, MODELS, isModelId } from './launch-args.ts';
import type { Perm } from './launch-args.ts';
import { getDefaults, setDefaults, getStatusBar, setStatusBar, statusBarDefaults } from './defaults.ts';
import type { StatusBarCfg } from './defaults.ts';
import {
  onStatusUpdate,
  renderPreviewStrip,
  statusBarConfigChanged,
  refreshTelemetryNow,
} from './statusbar.ts';

export interface SettingsPanel {
  open(): void;
  close(): void;
  toggle(): void;
  isOpen(): boolean;
}

export function initSettings(modalHost: HTMLElement, anchor: HTMLElement): SettingsPanel {
  // ---- scrim + card --------------------------------------------------------
  const scrim = el('div', 'modal-scrim');
  scrim.hidden = true;
  const modal = el('div', 'modal settings-modal');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'app settings');

  // ---- header (plain label, the shortcuts/dir-browser modal sibling) -------
  const hd = el('header', 'modal-hd');
  const closeX = button('drawer-x', '×', () => close());
  closeX.setAttribute('aria-label', 'close settings');
  closeX.title = 'close (esc)';
  hd.append(el('span', 'drawer-label', 'SETTINGS'), el('span', 'drawer-gap'), closeX);

  const bodyEl = el('div', 'settings-body');

  // ======================================================================
  // Section 1 — DEFAULTS (model · permission mode · startup command)
  // ======================================================================
  const defSect = el('section', 'settings-sect');
  defSect.append(el('div', 'drawer-label', 'LAUNCH DEFAULTS'));
  defSect.append(
    el(
      'div',
      'settings-note',
      'pre-select the launch dialog · a per-launch change always wins · a project default beats these',
    ),
  );

  // Default model — a select mirroring the dialog's model list, plus an
  // explicit "no default" that falls the dialog back to its hardcoded first.
  const modelField = el('label', 'settings-field');
  modelField.append(el('span', 'launch-lb', 'Default model'));
  const modelSel = el('select');
  modelSel.name = 'defaultModel';
  const none = el('option', '', 'no default');
  none.value = '';
  modelSel.append(none);
  for (const m of MODELS) {
    const opt = el('option', '', m);
    opt.value = m;
    modelSel.append(opt);
  }
  modelField.append(modelSel);

  // Default permission mode — the dialog's own 2×2 permission cards.
  const permField = el('div', 'settings-field');
  permField.append(el('span', 'launch-lb', 'Default permission mode'));
  const permGrid = el('div', 'perm-grid');
  permGrid.setAttribute('role', 'group');
  permGrid.setAttribute('aria-label', 'default permission mode');
  let perm: Perm = 'default';
  const permButtons = new Map<Perm, HTMLButtonElement>();
  for (const p of PERMS) {
    const card = button(`perm-card${p.danger ? ' is-danger' : ''}`, '', () => {
      setPerm(p.mode);
      commit();
    });
    card.append(el('span', 'perm-mode', p.mode), el('span', 'perm-desc', p.desc));
    if (p.danger) card.title = 'new sessions default to all permission prompts disabled';
    permButtons.set(p.mode, card);
    permGrid.append(card);
  }
  permField.append(permGrid);

  function setPerm(mode: Perm): void {
    perm = mode;
    for (const [m, b] of permButtons) {
      b.classList.toggle('is-sel', m === mode);
      b.setAttribute('aria-pressed', m === mode ? 'true' : 'false');
    }
  }

  // Auto-run startup command — full-width mono line, typed into every new
  // claude session once it is ready (empty = off; claude-mode launches only).
  const startField = el('label', 'settings-field');
  const startLb = el('span', 'launch-lb', 'Auto-run startup command ');
  startLb.append(el('em', 'field-hint', 'typed into new claude sessions · empty = off'));
  startField.append(startLb);
  const startInput = el('input');
  startInput.name = 'startupCommand';
  startInput.placeholder = '/caveman';
  startInput.spellcheck = false;
  startInput.autocomplete = 'off';
  startField.append(startInput);

  defSect.append(modelField, permField, startField);

  // ======================================================================
  // Section 2 — USAGE (read-only, approximate, local)
  // ======================================================================
  const useSect = el('section', 'settings-sect');
  const useHd = el('div', 'settings-usage-hd');
  const refreshBtn = button('btn settings-refresh', 'refresh', () => void loadUsage());
  refreshBtn.title = 'recompute usage from the local logs';
  const useUpdated = el('span', 'settings-usage-updated');
  useHd.append(
    el('span', 'drawer-label', 'USAGE'),
    el('span', 'drawer-gap'),
    useUpdated,
    refreshBtn,
  );
  useSect.append(useHd);
  useSect.append(
    el(
      'div',
      'settings-note',
      'approximate · read from Claude Code’s local session logs · the app cannot see or change account-side limits',
    ),
  );
  const usageBody = el('div', 'settings-usage');
  usageBody.setAttribute('aria-live', 'polite');
  useSect.append(usageBody);

  // ======================================================================
  // Section 3 — TERMINAL STATUS BAR (per-pane telemetry toggles)
  // ======================================================================
  const sbSect = el('section', 'settings-sect');
  sbSect.append(el('div', 'drawer-label', 'TERMINAL STATUS BAR'));
  sbSect.append(
    el(
      'div',
      'settings-note',
      'pick what each session shows in the status bar at the bottom of its terminal · cost and context are approximate, read from Claude Code’s local session logs',
    ),
  );

  // Live preview: the real .pane-status strip, boxed. Shows the focused/first
  // running session's LIVE telemetry, or representative samples when none runs.
  const sbPreview = el('div', 'pane-status settings-sb-preview');
  sbPreview.setAttribute('aria-hidden', 'true'); // the toggle rows are the accessible controls
  sbSect.append(sbPreview);

  // Eight real toggles (UiStatusBar order) + a ninth DISABLED "Usage limit"
  // row (deferred — no honest local source; keeps the prototype's 9-row shape).
  interface SbRow {
    key: keyof StatusBarCfg;
    label: string;
    sample: string;
  }
  const SB_ROWS: SbRow[] = [
    { key: 'model', label: 'Model', sample: 'opus' },
    { key: 'mode', label: 'Permission mode', sample: 'acceptEdits' },
    { key: 'branch', label: 'Git branch', sample: '⎇ main' },
    { key: 'time', label: 'Session time', sample: '08:42' },
    { key: 'cost', label: 'Cost spent', sample: '$0.42' },
    { key: 'context', label: 'Context window', sample: 'ctx 62k/200k' },
    { key: 'diff', label: 'Lines changed', sample: '+128 −41' },
    { key: 'skill', label: 'Active skill', sample: 'skill: edit' },
  ];
  const sbRows = el('div', 'status-rows');
  sbRows.setAttribute('role', 'group');
  sbRows.setAttribute('aria-label', 'terminal status bar items');
  const sbRowEls = new Map<keyof StatusBarCfg, HTMLButtonElement>();
  const sbBoxes = new Map<keyof StatusBarCfg, HTMLElement>();
  for (const r of SB_ROWS) {
    const row = button('status-row', '', () => toggleStatusRow(r.key));
    const box = el('span', 'status-box');
    box.setAttribute('aria-hidden', 'true');
    row.append(box, el('span', 'status-lb', r.label), el('span', 'status-sample', r.sample));
    sbRowEls.set(r.key, row);
    sbBoxes.set(r.key, box);
    sbRows.append(row);
  }
  // Disabled usage row — honest about the deferral, not toggleable.
  const usageDisRow = el('button', 'status-row');
  usageDisRow.type = 'button';
  usageDisRow.disabled = true;
  usageDisRow.setAttribute('aria-disabled', 'true');
  const usageDisBox = el('span', 'status-box');
  usageDisBox.setAttribute('aria-hidden', 'true');
  usageDisRow.append(
    usageDisBox,
    el('span', 'status-lb', 'Usage limit'),
    el('span', 'status-sample', 'not available from local logs'),
  );
  usageDisRow.title = 'account rate-limit % lives in live API headers, not the local logs';
  sbRows.append(usageDisRow);
  sbSect.append(sbRows);

  bodyEl.append(defSect, useSect, sbSect);

  // ---- footer --------------------------------------------------------------
  const ft = el('footer', 'modal-ft settings-ft');
  const resetBtn = button('btn', 'Reset to defaults', () => resetStatusBar());
  resetBtn.title = 'restore the status-bar items to their default on/off state';
  const doneBtn = button('btn', 'Close', () => close());
  ft.append(resetBtn, el('span', 'drawer-gap'), doneBtn);

  modal.append(hd, bodyEl, ft);
  scrim.append(modal);
  scrim.addEventListener('mousedown', (e) => {
    if (e.target === scrim) close();
  });
  trapTab(modal);
  modalHost.append(scrim);

  // ---- defaults form <-> store --------------------------------------------

  /** The three controls as a UiLaunchDefaults bag — omit "off"/"none" values. */
  function readForm(): UiLaunchDefaults {
    const d: UiLaunchDefaults = {};
    if (isModelId(modelSel.value)) d.model = modelSel.value;
    if (perm !== 'default') d.permissionMode = perm; // absent === 'default' baseline
    if (startInput.value.trim() !== '') d.startupCommand = startInput.value;
    return d;
  }

  function seedForm(): void {
    const g = getDefaults();
    modelSel.value = isModelId(g.model) ? g.model : '';
    setPerm(g.permissionMode ?? 'default');
    startInput.value = g.startupCommand ?? '';
  }

  function equalDefaults(a: UiLaunchDefaults, b: UiLaunchDefaults): boolean {
    return (
      a.model === b.model &&
      a.permissionMode === b.permissionMode &&
      a.startupCommand === b.startupCommand
    );
  }

  /**
   * Persist the form if it changed the stored defaults: update the in-memory
   * store (so the launch dialog sees it on the next open) AND fire-and-forget
   * a merged PUT (theme + any other bag key preserved). Idempotent — a no-op
   * when nothing changed, so close() can call it safely.
   */
  function commit(): void {
    const next = readForm();
    if (equalDefaults(next, getDefaults())) return;
    setDefaults(next);
    void api.updatePrefs({ defaults: getDefaults() }).catch(() => {
      // Non-fatal: the in-memory store still holds it for this run.
    });
  }

  modelSel.addEventListener('change', commit);
  startInput.addEventListener('change', commit); // fires on blur / Enter

  // ---- usage fetch + render ------------------------------------------------

  let usageToken = 0;

  function setUsageMsg(text: string, kind: 'wait' | 'err' | 'empty'): void {
    usageBody.replaceChildren(el('div', `settings-usage-msg is-${kind}`, text));
  }

  async function loadUsage(): Promise<void> {
    const mine = ++usageToken;
    refreshBtn.disabled = true;
    setUsageMsg('reading local logs…', 'wait');
    try {
      const u = await api.getUsage();
      if (mine !== usageToken) return; // a newer refresh superseded this one
      renderUsage(u);
    } catch (e) {
      if (mine !== usageToken) return;
      useUpdated.textContent = '';
      setUsageMsg(`usage unavailable: ${e instanceof Error ? e.message : String(e)}`, 'err');
    } finally {
      if (mine === usageToken) refreshBtn.disabled = false;
    }
  }

  function fmtUpdated(iso: string): string {
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return '';
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `updated ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`;
  }

  /** A `label → value` ledger row (value right-aligned, mono). */
  function ledgerRow(name: string, value: string, entries?: string): HTMLElement {
    const row = el('div', 'settings-led-row');
    row.append(el('span', 'settings-led-name', name)); // textContent — untrusted model strings
    if (entries !== undefined) row.append(el('span', 'settings-led-sub', entries));
    row.append(el('span', 'settings-led-val', value));
    return row;
  }

  function renderUsage(u: UsageResponse): void {
    useUpdated.textContent = fmtUpdated(u.updatedAt);
    const frag = document.createDocumentFragment();

    // Totals: headline total + token-type breakdown + window meta.
    const totals = el('div', 'settings-usage-totals');
    const head = el('div', 'settings-usage-total');
    head.append(
      el('span', 'settings-usage-total-n', fmtCount(u.totals.total)),
      el('span', 'settings-usage-total-lb', 'tokens'),
    );
    totals.append(head);
    totals.append(
      el(
        'div',
        'settings-usage-break',
        `in ${fmtCount(u.totals.input)} · out ${fmtCount(u.totals.output)} · cache +${fmtCount(u.totals.cacheCreation)} · read ${fmtCount(u.totals.cacheRead)}`,
      ),
    );
    const metaBits = [
      `${u.windowDays}-day window`,
      `${fmtCount(u.sessionCount)} sessions`,
      `${fmtCount(u.entryCount)} entries`,
    ];
    if (u.malformedLines > 0) metaBits.push(`${fmtCount(u.malformedLines)} malformed skipped`);
    totals.append(el('div', 'settings-usage-meta', metaBits.join(' · ')));
    frag.append(totals);

    // By day.
    frag.append(el('div', 'settings-led-lb', 'BY DAY'));
    if (u.days.length === 0) {
      frag.append(el('div', 'settings-usage-msg is-empty', 'no usage in this window'));
    } else {
      const table = el('div', 'settings-led');
      // Descending (most recent first) reads like a log tail.
      for (const d of [...u.days].reverse()) {
        table.append(ledgerRow(d.date, fmtCount(d.tokens.total)));
      }
      frag.append(table);
    }

    // By model (model strings are log-derived → textContent, untrusted).
    frag.append(el('div', 'settings-led-lb', 'BY MODEL'));
    if (u.models.length === 0) {
      frag.append(el('div', 'settings-usage-msg is-empty', 'no models in this window'));
    } else {
      const table = el('div', 'settings-led');
      for (const m of u.models) {
        table.append(
          ledgerRow(m.model, fmtCount(m.tokens.total), `${fmtCount(m.entryCount)}×`),
        );
      }
      frag.append(table);
    }

    usageBody.replaceChildren(frag);
  }

  // ---- status bar toggles + live preview -----------------------------------

  /** Reflect one toggle's stored state onto its row (checkbox fill + aria-pressed). */
  function syncStatusRow(key: keyof StatusBarCfg): void {
    const on = getStatusBar()[key];
    const row = sbRowEls.get(key);
    const box = sbBoxes.get(key);
    if (row === undefined || box === undefined) return;
    row.setAttribute('aria-pressed', on ? 'true' : 'false');
    box.textContent = on ? '✓' : '';
  }

  function seedStatusRows(): void {
    for (const r of SB_ROWS) syncStatusRow(r.key);
  }

  /** The focused (else first) RUNNING session, for the live preview; null if none. */
  function focusedRunningSession(): SessionInfo | null {
    const v = st.activeView();
    if (v !== null) {
      const fid = v.sessions[v.focused];
      const f = fid !== undefined ? st.state.sessions.get(fid) : undefined;
      if (f !== undefined && f.status === 'running') return f;
    }
    for (const s of st.state.sessions.values()) if (s.status === 'running') return s;
    return null;
  }

  function renderSbPreview(): void {
    renderPreviewStrip(sbPreview, focusedRunningSession());
  }

  /** Persist the current toggles (merged PUT preserves defaults + theme). */
  function persistStatusBar(): void {
    void api.updatePrefs({ statusBar: getStatusBar() }).catch(() => {
      // Non-fatal: the in-memory store still holds it for this run.
    });
  }

  function toggleStatusRow(key: keyof StatusBarCfg): void {
    const cur = getStatusBar();
    setStatusBar({ ...cur, [key]: !cur[key] });
    persistStatusBar();
    syncStatusRow(key);
    renderSbPreview();
    statusBarConfigChanged(); // live re-render of open panes (+ the 1s tick on/off)
  }

  function resetStatusBar(): void {
    setStatusBar(statusBarDefaults());
    persistStatusBar();
    seedStatusRows();
    renderSbPreview();
    statusBarConfigChanged();
  }

  // Keep the preview live while the panel is open (telemetry poll / time tick).
  onStatusUpdate(() => {
    if (!scrim.hidden) renderSbPreview();
  });

  // ---- open / close --------------------------------------------------------
  let restoreTo: HTMLElement | null = null;

  function open(): void {
    if (!scrim.hidden) return;
    restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    seedForm();
    seedStatusRows();
    renderSbPreview();
    refreshTelemetryNow(); // freshen the preview against live sessions
    scrim.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    void loadUsage();
    modelSel.focus();
  }

  function close(): void {
    if (scrim.hidden) return;
    commit(); // flush any un-blurred edit (idempotent when unchanged)
    usageToken++; // cancel an in-flight usage fetch
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
