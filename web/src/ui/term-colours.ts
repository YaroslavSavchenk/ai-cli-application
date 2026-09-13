/**
 * Settings page "Terminal colours" (Nocturne A7 — LOOK only; part B9 wires it).
 *
 * Not in the v3 handoff: the user asked for it (2026-09-10) and settled its
 * shape on 2026-09-13 (plan open decision 10), so the page is designed in the
 * Nocturne idiom the rest of Settings uses — a lead line, a preview, a row of
 * scheme cards, two fields, one text button.
 *
 * WHAT IT DOES NOT DO IN A7. The selection is LOCAL to this page: it moves the
 * preview and the selected card, and nothing else. It does not write `:root`,
 * it does not touch a terminal, it does not write prefs. Part B9 connects it to
 * ui/theme.ts (which already owns `--term-bg` + the `--xt-*` slots,
 * `refreshAllTerminalThemes()` and the prefs copy). Hence the one honesty line
 * at the bottom.
 *
 * THE INLINE COLOURS ARE DATA, NOT STYLING. Every colour this module sets
 * through `style.setProperty` is a VALUE the user picked (or a preset's own
 * hex) — the same role `--split-col` plays in ui/panes.ts. The page's looks
 * live in app.css like everything else; only the chosen hexes are inline,
 * because a stylesheet cannot know them.
 *
 * Ground and text only, never the ANSI palette, and the three status colours
 * (running / attention / danger) are never themed — they carry meaning, not
 * taste.
 */
import { el, button } from './util.ts';
import {
  CUSTOM,
  PRESETS,
  coloursOf,
  initialState,
  isHex6,
  presetColours,
  reduce,
  type TcState,
} from './term-colours-model.ts';

/**
 * The sample the preview paints: one bright line, one output line, one quiet
 * line — the three ink steps a terminal really uses. `step` names which colour
 * the line takes; it is not a class, because the colour is inline DATA.
 */
const SAMPLE: { step: 'cmd' | 'out' | 'dim'; text: string }[] = [
  { step: 'cmd', text: 'Updating the pane header to the new layout' },
  { step: 'out', text: 'Two files changed, 41 added and 19 removed' },
  { step: 'dim', text: 'Ready for your next message' },
];

export interface TermColoursPage {
  /** The page element, appended into the settings body once. */
  root: HTMLElement;
}

export function buildTermColours(titleId: string): TermColoursPage {
  let state: TcState = initialState();

  const root = el('section', 'sg-page');
  root.setAttribute('role', 'tabpanel');
  root.setAttribute('aria-labelledby', titleId);
  root.append(
    el('h2', 'sg-title', 'Terminal colours'),
    el(
      'p',
      'sg-lead',
      'Pick the ground and the text colour your terminals use. The rest of the app keeps its own colours.',
    ),
  );

  // ---- preview -------------------------------------------------------------
  // A picture of a terminal, so aria-hidden: the cards below carry the state a
  // screen reader needs (aria-checked), and reading three sample sentences out
  // loud would say nothing about colour.
  const prev = el('div', 'sg-tcprev');
  prev.setAttribute('aria-hidden', 'true');
  const lines = SAMPLE.map((s) => el('div', 'sg-tcline', s.text));
  prev.append(...lines);
  root.append(prev);

  // ---- schemes -------------------------------------------------------------
  const schemesLb = el('span', 'sg-lb', 'Schemes');
  schemesLb.id = 'sg-tc-schemes-lb';
  const grid = el('div', 'sg-tcgrid');
  grid.setAttribute('role', 'radiogroup');
  grid.setAttribute('aria-labelledby', schemesLb.id);
  const cards = new Map<string, HTMLButtonElement>();
  const swatches = new Map<string, HTMLElement>();
  for (const p of PRESETS) {
    const b = button('sg-tccard', '', () => apply({ k: 'preset', id: p.id }));
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', 'false');
    b.tabIndex = -1;
    const sw = el('span', 'sg-tcsw', 'Aa');
    sw.setAttribute('aria-hidden', 'true');
    b.append(sw, el('span', 'sg-tcname', p.name));
    cards.set(p.id, b);
    swatches.set(p.id, sw);
    grid.append(b);
  }
  // One tab stop, arrows move the choice — the A4 card-grid idiom.
  grid.addEventListener('keydown', (e: KeyboardEvent) => {
    const order = PRESETS.map((p) => p.id);
    // A custom pair selects NO card, so there is nothing to step from: a forward
    // key then lands on the first card and a backward key on the last. Stepping
    // from a pretended index 0 would make the first scheme unreachable by
    // ArrowRight.
    const cur = order.indexOf(state.id);
    const k = e.key;
    let i: number;
    if (k === 'ArrowRight' || k === 'ArrowDown') i = cur === -1 ? 0 : (cur + 1) % order.length;
    else if (k === 'ArrowLeft' || k === 'ArrowUp') i = cur === -1 ? order.length - 1 : (cur - 1 + order.length) % order.length;
    else if (k === 'Home') i = 0;
    else if (k === 'End') i = order.length - 1;
    else return;
    e.preventDefault();
    const id = order[i] as string;
    apply({ k: 'preset', id });
    cards.get(id)?.focus();
  });
  const schemes = el('div', 'sg-group');
  schemes.append(schemesLb, grid);
  root.append(schemes);

  // ---- custom: two fields, a native swatch plus the hex it stands for ------
  const customLb = el('span', 'sg-lb', 'Custom');
  const custom = el('div', 'sg-group');
  custom.append(customLb);

  interface Field {
    swatch: HTMLInputElement;
    hex: HTMLInputElement;
  }

  function colourField(name: string, id: string, onPick: (hex: string) => void): Field {
    const row = el('div', 'sg-tcfield');
    const lb = el('label', 'sg-tclb', name);
    lb.htmlFor = id;
    const swatch = el('input', 'sg-tcswatch');
    swatch.type = 'color';
    swatch.setAttribute('aria-label', `${name} swatch`);
    swatch.addEventListener('input', () => onPick(swatch.value));
    const hex = el('input', 'sg-tchex');
    hex.id = id;
    hex.type = 'text';
    hex.spellcheck = false;
    hex.maxLength = 7;
    hex.autocomplete = 'off';
    hex.addEventListener('input', () => {
      // The field keeps whatever is half-typed; only a complete six-digit
      // colour moves the preview, and an incomplete one is flagged, not lost.
      const ok = isHex6(hex.value);
      hex.classList.toggle('is-bad', !ok);
      hex.setAttribute('aria-invalid', ok ? 'false' : 'true');
      if (ok) onPick(hex.value);
    });
    row.append(lb, swatch, hex);
    custom.append(row);
    return { swatch, hex };
  }

  const groundF = colourField('Ground', 'sg-tc-ground', (hex) => apply({ k: 'ground', hex }));
  const textF = colourField('Text', 'sg-tc-text', (hex) => apply({ k: 'text', hex }));
  root.append(custom);

  const resetBtn = button('sg-textbtn', 'Reset to Nocturne', () => {
    apply({ k: 'reset' });
    // A reset that leaves the fields showing the old numbers would be a lie.
    groundF.hex.focus();
  });
  const resetRow = el('div', 'sg-actions');
  resetRow.append(resetBtn);
  root.append(resetRow);

  /**
   * PLACEHOLDER MARKER — DELETE WITH THE MOCK (part B9). Nothing on this page
   * reaches a terminal yet, and a colour page that changes nothing is exactly
   * the kind of surface a user trusts by mistake. One function, one call site.
   */
  function placeholderNote(): HTMLElement {
    return el('p', 'sg-note', 'Example colours until the app applies them to your terminals.');
  }
  root.append(placeholderNote());

  // ---- state -> DOM --------------------------------------------------------

  function render(): void {
    const c = coloursOf(state);
    // DATA, not styling: these four hexes are the user's choice (see the file
    // header). Everything about how the preview LOOKS is in app.css.
    prev.style.setProperty('background-color', c.ground);
    for (const [i, line] of lines.entries()) {
      const step = (SAMPLE[i] as { step: 'cmd' | 'out' | 'dim' }).step;
      line.style.setProperty('color', c[step]);
    }
    for (const p of PRESETS) {
      const b = cards.get(p.id);
      const sw = swatches.get(p.id);
      if (b === undefined || sw === undefined) continue;
      const on = state.id === p.id;
      b.classList.toggle('is-sel', on);
      b.setAttribute('aria-checked', on ? 'true' : 'false');
      // A card is only a tab stop while it is the chosen one; with a custom
      // pair selected the first card holds the stop so the row stays reachable.
      b.tabIndex = on || (state.id === CUSTOM && p === PRESETS[0]) ? 0 : -1;
      const pc = presetColours(p.id);
      sw.style.setProperty('background-color', pc.ground);
      sw.style.setProperty('color', pc.cmd);
    }
    // c.cmd IS state.text for a custom pair, and the preset's bright step
    // otherwise — so both fields always show what the preview draws.
    groundF.swatch.value = c.ground;
    textF.swatch.value = c.cmd;
    groundF.hex.value = c.ground;
    textF.hex.value = c.cmd;
    for (const f of [groundF, textF]) {
      f.hex.classList.remove('is-bad');
      f.hex.setAttribute('aria-invalid', 'false');
    }
  }

  function apply(a: Parameters<typeof reduce>[1]): void {
    state = reduce(state, a);
    render();
  }

  render();
  return { root };
}
