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

/** hh:mm from an ISO timestamp, for dense list metadata. */
export function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--:--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
