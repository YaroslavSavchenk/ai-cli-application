/** Tiny DOM helpers shared by the UI modules. No framework — by decision. */

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
 * Permission tag from argv. `--dangerously-skip-permissions` reads "bypass";
 * `--permission-mode <mode>` reads the mode. Danger (red tag) for both
 * bypass forms; null for default/absent (no tag shown).
 */
export function permFromArgs(args: string[]): { label: string; danger: boolean } | null {
  if (args.includes('--dangerously-skip-permissions')) return { label: 'bypass', danger: true };
  const i = args.indexOf('--permission-mode');
  const next = i !== -1 ? args[i + 1] : undefined;
  const v =
    typeof next === 'string' && next !== ''
      ? next
      : args.find((a) => a.startsWith('--permission-mode='))?.slice('--permission-mode='.length);
  if (typeof v !== 'string' || v === '' || v === 'default') return null;
  return { label: v, danger: v === 'bypassPermissions' };
}

/**
 * Group a non-negative integer with thin thousands separators for the usage
 * ledger (`1234567` -> `1,234,567`). Non-finite/negative inputs render as the
 * app's empty-value glyph so a malformed count never prints `NaN`.
 */
export function fmtCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  return Math.trunc(n).toLocaleString('en-US');
}

/** `HH:MM:SS` since an ISO timestamp (statusline `up …`; hours don't wrap). */
export function fmtUptime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
