/** Tiny DOM helpers shared by the UI modules. No framework — by decision. */
import { PERM_SHORT, isPerm } from './launch-args.ts';

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className !== undefined && className !== '') node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(className: string, label: string, onClick?: () => void): HTMLButtonElement {
  const b = el('button', className, label);
  b.type = 'button';
  if (onClick !== undefined) b.addEventListener('click', onClick);
  return b;
}

/**
 * Armed two-step destructive confirm on a persistent button: first click
 * arms it (inverted, confirm label) for 3s, second click fires. In-place and
 * keyboard-reachable — no native confirm() modal.
 */
export function armButton(btn: HTMLButtonElement, confirmLabel: string, action: () => void): void {
  const original = btn.textContent ?? '';
  let timer: number | null = null;
  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    delete btn.dataset.armed;
    btn.textContent = original;
  };
  btn.addEventListener('click', () => {
    if (btn.dataset.armed === '1') {
      disarm();
      action();
      return;
    }
    btn.dataset.armed = '1';
    btn.textContent = confirmLabel;
    timer = window.setTimeout(disarm, 3000);
  });
}

/**
 * Armed-confirm state for lists that are re-rendered (rows are rebuilt on
 * every poll, so the armed flag lives outside the DOM, keyed by entity id).
 */
export class ArmedSet {
  #until = new Map<string, number>();

  /** Returns true when the action should fire; false when it just armed. */
  trigger(id: string, rerender: () => void): boolean {
    const now = Date.now();
    const until = this.#until.get(id);
    if (until !== undefined && until > now) {
      this.#until.delete(id);
      return true;
    }
    this.#until.set(id, now + 3000);
    window.setTimeout(() => {
      const u = this.#until.get(id);
      if (u !== undefined && u <= Date.now()) {
        this.#until.delete(id);
        rerender();
      }
    }, 3100);
    rerender();
    return false;
  }

  isArmed(id: string): boolean {
    const until = this.#until.get(id);
    return until !== undefined && until > Date.now();
  }
}

/**
 * Minimal Tab-wrap focus trap for a dialog-like container. Keeps Tab /
 * Shift+Tab cycling inside it; everything else (incl. Esc) is untouched —
 * dismissal is handled by the caller's own keydown dispatch.
 */
export function trapTab(container: HTMLElement): void {
  container.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((n) => n.offsetParent !== null);
    if (focusable.length === 0) return;
    const first = focusable[0] as HTMLElement;
    const last = focusable[focusable.length - 1] as HTMLElement;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

/**
 * Model tag from a session's argv (`--model x` / `--model=x`) — tags derive
 * client-side from SessionInfo.args; the protocol carries no tag fields.
 */
export function modelFromArgs(args: string[]): string | null {
  const i = args.indexOf('--model');
  const next = args[i + 1];
  if (i !== -1 && typeof next === 'string' && next !== '') return next;
  const eq = args.find((a) => a.startsWith('--model='));
  const v = eq?.slice('--model='.length);
  return v !== undefined && v !== '' ? v : null;
}

/**
 * Permission tag from argv, in the UI's plain words (`PERM_SHORT`, the narrow-
 * chip forms): both bypass forms read "no prompts", `acceptEdits` reads
 * "auto edits", `plan` reads "read-only". Danger (red tag) for both bypass
 * forms; null for default/absent (no tag shown at all — unchanged). A mode
 * outside the known four (only reachable from a custom command the user typed)
 * is shown verbatim: inventing a translation for it would be dishonest.
 */
export function permFromArgs(args: string[]): { label: string; danger: boolean } | null {
  if (args.includes('--dangerously-skip-permissions')) {
    return { label: PERM_SHORT.bypassPermissions, danger: true };
  }
  const i = args.indexOf('--permission-mode');
  const next = i !== -1 ? args[i + 1] : undefined;
  const v =
    typeof next === 'string' && next !== ''
      ? next
      : args.find((a) => a.startsWith('--permission-mode='))?.slice('--permission-mode='.length);
  if (typeof v !== 'string' || v === '' || v === 'default') return null;
  return { label: isPerm(v) ? PERM_SHORT[v] : v, danger: v === 'bypassPermissions' };
}

/** `HH:MM:SS` since an ISO timestamp (statusline `up …`; hours don't wrap). */
export function fmtUptime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** English month abbreviations for `fmtAgo`'s fallback date (locale-independent). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * How long ago an ISO timestamp was, in the drawer's short vocabulary:
 * `just now` (< 1 min) · `5 min ago` (< 1 h) · `3 h ago` (< 1 day) ·
 * `yesterday` (< 2 days) · `4 d ago` (< 7 days) · else a short date
 * (`6 Sep`, plus the year when it is not the current one).
 *
 * `now` is injectable so the formatter is testable without a clock stub. An
 * unparseable timestamp yields the app's empty-value glyph rather than a lie;
 * a timestamp in the future reads `just now` (clock skew is not an event).
 */
export function fmtAgo(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const sec = Math.floor((now - t) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min ago`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 2) return 'yesterday';
  if (days < 7) return `${days} d ago`;
  const d = new Date(t);
  const short = `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''}`;
  return d.getFullYear() === new Date(now).getFullYear() ? short : `${short} ${d.getFullYear()}`;
}

/**
 * A count for a badge or header — capped at `9+` past nine (user's request
 * 2026-09-08: a full number there is "far too unwieldy"). Every history count
 * the UI shows goes through this so they never disagree.
 */
export function fmtCount(n: number): string {
  return n > 9 ? '9+' : String(n);
}

/** Last path segment of an absolute path — a folder the app cannot name is still a folder. */
export function baseName(path: string): string {
  const parts = path.split('/').filter((p) => p !== '');
  return parts[parts.length - 1] ?? path;
}
