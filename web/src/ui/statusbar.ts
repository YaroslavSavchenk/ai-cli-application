/**
 * Per-pane terminal status strip: the render + the telemetry poll.
 *
 * The strip is a vim-statusline descendant — a thin row under each terminal
 * (the hero) showing configurable per-session telemetry. Honesty rule: an
 * item shows ONLY when its toggle is ON *and* a real value exists; the whole
 * strip is absent when zero items would show (no empty 22px bar). Nothing is
 * ever fabricated in a live pane.
 *
 * Two data provenances, deliberately kept apart:
 *   - model & mode & time are CLIENT-SIDE — model/mode from the session's own
 *     launch argv (modelFromArgs/permFromArgs; always known, no poll), time
 *     computed from SessionInfo.createdAt and ticked each second.
 *   - branch/cost/context/diff/skill come from GET /api/telemetry, polled ~3s
 *     while ≥1 pane is visible (paused when hidden / no panes). Last-known is
 *     cached per session id so an EXITED pane keeps its final values (the
 *     endpoint omits exited sessions). Failed polls are silent — last values
 *     stand.
 *
 * Untrusted strings (branch, skill, model are git/Claude-log derived) are set
 * via textContent only — never innerHTML.
 */
import type { SessionInfo, TelemetryItem } from '../../../shared/protocol.ts';
import * as api from '../api.ts';
import { el, modelFromArgs, permFromArgs, fmtDur } from './util.ts';
import { getStatusBar, type StatusBarCfg } from './defaults.ts';

const POLL_MS = 3000;
const TICK_MS = 1000;

/** Last-known telemetry per session id (exited sessions retain their final values). */
const cache = new Map<string, TelemetryItem>();

/** Re-render subscribers (the pane strips; the settings preview while open). */
const listeners = new Set<() => void>();

let visibleIds: string[] = [];
let pollTimer: number | null = null;
let tickTimer: number | null = null;
let inFlight = false;

// ---------------------------------------------------------------------------
// Item model
// ---------------------------------------------------------------------------

type Role = 'neutral' | 'skill' | 'danger';
interface Item {
  text: string;
  role: Role;
}

/** Everything one strip needs, decoupled from SessionInfo so a sample can stand in. */
interface StatusInputs {
  /** Model id (launch argv). */
  model: string | null;
  /** Permission mode (launch argv); null for the default/absent mode. */
  perm: { label: string; danger: boolean } | null;
  /** Elapsed-time item shows only for a running session. */
  running: boolean;
  /** createdAt in ms for the time item, or null (no valid timestamp). */
  createdAtMs: number | null;
  /** Poll-sourced fields (branch/add/del/cost/context/skill). */
  tel: TelemetryItem;
}

function kTokens(n: number): number {
  return Math.round(n / 1000);
}

/**
 * Build the ordered items for the given config + inputs. Order mirrors the
 * prototype (model · mode · skill · cost · context · time · branch · diff);
 * `usage` is intentionally gone (deferred — no honest local source). Each
 * item is gated on its toggle AND a real value.
 */
export function buildItems(cfg: StatusBarCfg, inp: StatusInputs): Item[] {
  const out: Item[] = [];
  const t = inp.tel;
  if (cfg.model && inp.model !== null) out.push({ text: inp.model, role: 'neutral' });
  if (cfg.mode && inp.perm !== null) {
    out.push({ text: inp.perm.label, role: inp.perm.danger ? 'danger' : 'neutral' });
  }
  if (cfg.skill && typeof t.skill === 'string' && t.skill !== '') {
    out.push({ text: `skill: ${t.skill}`, role: 'skill' });
  }
  if (cfg.cost && typeof t.costUsd === 'number' && Number.isFinite(t.costUsd)) {
    out.push({ text: `~$${t.costUsd.toFixed(2)}`, role: 'neutral' });
  }
  if (
    cfg.context &&
    typeof t.contextTokens === 'number' &&
    Number.isFinite(t.contextTokens) &&
    typeof t.contextMax === 'number' &&
    Number.isFinite(t.contextMax) &&
    t.contextMax > 0
  ) {
    out.push({ text: `ctx ${kTokens(t.contextTokens)}k/${kTokens(t.contextMax)}k`, role: 'neutral' });
  }
  if (cfg.time && inp.running && inp.createdAtMs !== null) {
    out.push({ text: fmtDur(Date.now() - inp.createdAtMs), role: 'neutral' });
  }
  if (cfg.branch && typeof t.branch === 'string' && t.branch !== '') {
    out.push({ text: `⎇ ${t.branch}`, role: 'neutral' });
  }
  if (cfg.diff) {
    const add = t.add ?? 0;
    const del = t.del ?? 0;
    if (add > 0 || del > 0) out.push({ text: `+${add} −${del}`, role: 'neutral' });
  }
  return out;
}

function inputsFromSession(info: SessionInfo | undefined, sessionId: string): StatusInputs {
  const created = info !== undefined ? new Date(info.createdAt).getTime() : NaN;
  return {
    model: info !== undefined ? modelFromArgs(info.args) : null,
    perm: info !== undefined ? permFromArgs(info.args) : null,
    running: info === undefined || info.status === 'running',
    createdAtMs: Number.isNaN(created) ? null : created,
    tel: cache.get(sessionId) ?? {},
  };
}

/** span.pane-status-item with the role class; text via textContent (untrusted-safe). */
function makeItemEl(it: Item): HTMLElement {
  const cls =
    it.role === 'skill'
      ? 'pane-status-item is-skill'
      : it.role === 'danger'
        ? 'pane-status-item is-danger'
        : 'pane-status-item';
  return el('span', cls, it.text);
}

// ---------------------------------------------------------------------------
// Public render entry points
// ---------------------------------------------------------------------------

/**
 * Render one pane's strip in place. Hides the strip (no empty bar) when there
 * is no session or zero items would show. Called by ui/panes.ts on every slot
 * update and by the shared re-render below (poll / tick / config change).
 */
export function renderPaneStatus(
  strip: HTMLElement,
  info: SessionInfo | undefined,
  sessionId: string | null,
): void {
  const items =
    sessionId === null ? [] : buildItems(getStatusBar(), inputsFromSession(info, sessionId));
  if (items.length === 0) {
    strip.hidden = true;
    strip.replaceChildren();
    return;
  }
  strip.hidden = false;
  strip.replaceChildren(...items.map(makeItemEl));
}

/** Representative sample inputs for the settings preview when no session runs. */
function sampleInputs(): StatusInputs {
  return {
    model: 'opus',
    perm: { label: 'acceptEdits', danger: false },
    running: true,
    createdAtMs: Date.now() - 522_000, // → 08:42
    tel: {
      branch: 'main',
      add: 128,
      del: 41,
      costUsd: 0.42,
      contextTokens: 62_000,
      contextMax: 200_000,
      skill: 'edit',
    },
  };
}

/**
 * Render the settings live-preview strip: the focused/first RUNNING session's
 * live telemetry, or representative samples when none runs. Empty (nothing
 * enabled) shows the honest "status bar hidden" hint rather than a bare row.
 */
export function renderPreviewStrip(strip: HTMLElement, info: SessionInfo | null): void {
  const inp = info !== null ? inputsFromSession(info, info.id) : sampleInputs();
  const items = buildItems(getStatusBar(), inp);
  if (items.length === 0) {
    strip.replaceChildren(el('span', 'pane-status-item is-hint', 'status bar hidden'));
    return;
  }
  strip.replaceChildren(...items.map(makeItemEl));
}

// ---------------------------------------------------------------------------
// Re-render subscription + telemetry poll
// ---------------------------------------------------------------------------

/** Subscribe to re-render pulses (poll result, 1s time tick, config change). */
export function onStatusUpdate(cb: () => void): void {
  listeners.add(cb);
}

function emit(): void {
  for (const cb of listeners) cb();
}

function shouldPoll(): boolean {
  return visibleIds.length > 0 && !document.hidden;
}

function syncTimers(): void {
  if (shouldPoll()) {
    if (pollTimer === null) pollTimer = window.setInterval(() => void pollOnce(), POLL_MS);
  } else if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  // The 1s tick only exists to advance the time item; skip it when time is off.
  const wantTick = shouldPoll() && getStatusBar().time;
  if (wantTick) {
    if (tickTimer === null) tickTimer = window.setInterval(() => emit(), TICK_MS);
  } else if (tickTimer !== null) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

async function pollOnce(): Promise<void> {
  if (inFlight || !shouldPoll()) return;
  inFlight = true;
  try {
    const res = await api.getTelemetry();
    for (const [id, item] of Object.entries(res.sessions)) cache.set(id, item);
    emit();
  } catch {
    // Fail-soft: keep last-known values, nothing user-facing.
  } finally {
    inFlight = false;
  }
}

/** Set up the poll's visibility/focus triggers. Call once at boot. */
export function initTelemetry(): void {
  document.addEventListener('visibilitychange', () => {
    syncTimers();
    if (!document.hidden) void pollOnce(); // refresh the moment the window is shown
  });
  window.addEventListener('focus', () => void pollOnce());
}

/**
 * The active view's mounted session ids (ui/panes.ts feeds this on every
 * render). Drives the poll on/off and freshens once when the visible set
 * changes (tab switch / new pane).
 */
export function setVisiblePanes(ids: string[]): void {
  const changed = ids.join(' ') !== visibleIds.join(' ');
  visibleIds = ids;
  syncTimers();
  if (changed) void pollOnce();
}

/** The settings panel toggled/reset a config: re-tick and re-render everywhere. */
export function statusBarConfigChanged(): void {
  syncTimers();
  emit();
}

/** Force an immediate poll (settings-open, to freshen the preview). */
export function refreshTelemetryNow(): void {
  void pollOnce();
}
