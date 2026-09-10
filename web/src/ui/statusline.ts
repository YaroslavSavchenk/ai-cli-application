/**
 * Statusline (Nocturne A2): a 26px readout, left to right —
 * `N sessions` (the ones still running), `N panes`, an amber `N waiting for
 * you` when any session is, spacer, `Latency N ms` (the presence ping round
 * trip), `Up 2h 15m` (server uptime, ticked locally every 15 s) and a
 * Keyboard shortcuts button.
 *
 * Transient flash notices (a rejected drop, a failed kill) ride on the right,
 * before the latency readout: they are information the user asked for by
 * acting, and nothing else on screen carries them.
 *
 * Deliberately NOT here (dropped with the Legacy statusline in A2): the ws
 * round-trip in isolation, the focused-session readout (name, size and
 * connection state — the pane header says all three), `pty ok`, and the `?`
 * key glyph. Connection state is the top bar's dot.
 */
import * as st from '../state.ts';
import { el, fmtUptime } from './util.ts';

interface Deps {
  openShortcuts(): void;
}

let root: HTMLElement | null = null;
let deps: Deps | null = null;
let flashMsg: string | null = null;
let flashTimer: number | null = null;
/** Mutable `Up …` span — a 15 s ticker updates it (the readout only changes per minute) without a full rebuild. */
let upSeg: HTMLElement | null = null;

function upText(): string {
  return st.state.serverStartedAt !== null ? `Up ${fmtUptime(st.state.serverStartedAt)}` : 'Up —';
}

export function flash(msg: string): void {
  flashMsg = msg;
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    flashMsg = null;
    flashTimer = null;
    render();
  }, 3000);
  render();
}

export function initStatusline(container: HTMLElement, d: Deps): { render(): void } {
  root = container;
  deps = d;
  // Minute resolution, so a 15 s tick is the coarsest that still moves the
  // readout within a minute of the rollover (a 1 s tick was 59 no-ops out of
  // 60). The first paint comes from `render()`, not from this timer.
  window.setInterval(() => {
    if (upSeg !== null && st.state.serverStartedAt !== null) upSeg.textContent = upText();
  }, 15_000);
  return { render };
}

export function render(): void {
  if (root === null || deps === null) return;
  const nodes: HTMLElement[] = [];

  // ALIVE sessions only (v3: `sessions.filter(x => x.status !== 'exited')`).
  // A finished session stays listed in the drawer until it is dismissed; the
  // statusline counts what is still running, not what is still on file.
  let sessions = 0;
  for (const s of st.state.sessions.values()) if (s.status !== 'exited') sessions += 1;
  nodes.push(el('span', 'status-seg', `${sessions} ${sessions === 1 ? 'session' : 'sessions'}`));

  const v = st.activeView();
  const panes = v === null ? 0 : v.sessions.length;
  nodes.push(el('span', 'status-seg', `${panes} ${panes === 1 ? 'pane' : 'panes'}`));

  const attn = st.attentionCount();
  if (attn > 0) nodes.push(el('span', 'status-attn', `${attn} waiting for you`));

  nodes.push(el('span', 'status-gap'));

  if (flashMsg !== null) nodes.push(el('span', 'status-flash', flashMsg));

  const lat = st.state.wsLatencyMs;
  nodes.push(el('span', 'status-seg', lat !== null ? `Latency ${lat} ms` : 'Latency —'));

  upSeg = el('span', 'status-seg', upText());
  nodes.push(upSeg);

  const hadFocus =
    document.activeElement instanceof HTMLElement &&
    document.activeElement.getAttribute('data-k') === 'status-help';
  const hint = el('button', 'status-hint', 'Keyboard shortcuts');
  hint.type = 'button';
  hint.setAttribute('data-k', 'status-help');
  hint.title = 'Keyboard shortcuts (? or ctrl+alt+/)';
  hint.setAttribute('aria-haspopup', 'dialog');
  hint.addEventListener('click', () => deps?.openShortcuts());
  nodes.push(hint);

  root.replaceChildren(...nodes);
  if (hadFocus) hint.focus();
}
