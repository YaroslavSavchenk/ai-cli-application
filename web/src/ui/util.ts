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
 *
 * `opts.ask` makes the arming itself conditional: it is asked at CLICK time
 * (never frozen into the button when it was built), and a `false` answer runs
 * the action at once — no arm, no label change. Left out, the button always
 * arms, which is what a door without a preference behind it wants.
 */
export function armButton(
  btn: HTMLButtonElement,
  confirmLabel: string,
  action: () => void,
  opts?: { ask?: () => boolean },
): void {
  // The button's own CONTENT comes back on disarm, not just its text: an icon
  // button (B8, a pane header's End session) holds an SVG and no text at all.
  // While armed, the visible confirm label IS the name — an aria-label would
  // keep announcing the unarmed action over it — so it steps aside and returns.
  const original = Array.from(btn.childNodes);
  const label = btn.getAttribute('aria-label');
  let timer: number | null = null;
  const disarm = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    delete btn.dataset.armed;
    btn.replaceChildren(...original);
    if (label !== null) btn.setAttribute('aria-label', label);
  };
  btn.addEventListener('click', () => {
    if (opts?.ask !== undefined && !opts.ask()) {
      disarm();
      action();
      return;
    }
    if (btn.dataset.armed === '1') {
      disarm();
      action();
      return;
    }
    btn.dataset.armed = '1';
    btn.textContent = confirmLabel;
    if (label !== null) btn.removeAttribute('aria-label');
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
 *
 * `tabIndex >= 0` excludes the unselected members of a roving-tabindex
 * radiogroup (the New session dialog's Tool, Shell and Permissions card grids,
 * whose inert cards are permanently tabindex -1 too): they are buttons the
 * browser's own Tab order skips, so counting them as the first/last stop would
 * break the wrap at exactly the edges this exists to handle.
 */
export function trapTab(container: HTMLElement): void {
  container.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(
      container.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((n) => n.offsetParent !== null && n.tabIndex >= 0);
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
 * One modal at a time, and the element the keyboard goes back to when it
 * closes. The card is taken off the screen by REMOVING its scrim rather than
 * hiding it (the idiom every dialog here uses), which also takes `trapTab`'s
 * listener with it; focus then returns to the opener, if it is still on the
 * page. The folder picker and the delete confirmation each hold one (Q1: they
 * carried the same close function twice).
 */
export class ModalSlot {
  #scrim: HTMLElement | null = null;
  #restore: HTMLElement | null = null;

  isOpen(): boolean {
    return this.#scrim !== null;
  }

  /** `scrim` is the open modal now; `restore` gets the keyboard back on close. */
  hold(scrim: HTMLElement, restore: HTMLElement | null): void {
    this.#scrim = scrim;
    this.#restore = restore;
  }

  /** Take the card off the screen and hand the keyboard back. A no-op when none is open. */
  close(): void {
    const scrim = this.#scrim;
    if (scrim === null) return;
    scrim.remove();
    this.#scrim = null;
    const back = this.#restore;
    this.#restore = null;
    if (back !== null && back.isConnected) back.focus();
  }
}

/** Server-supplied error text, or the given fallback. Never a body dump. */
export function errorText(body: unknown, fallback: string): string {
  if (body !== null && typeof body === 'object') {
    const e = (body as { error?: unknown }).error;
    if (typeof e === 'string' && e !== '') return e;
  }
  return fallback;
}

/** Call it, and turn a synchronous throw into the rejection it should be. */
export function promiseOf<T>(call: () => Promise<T>): Promise<T> {
  try {
    return call();
  } catch (err) {
    return Promise.reject(err);
  }
}
