/**
 * Claude peek mascot — the view. Renders a `MascotState` snapshot into a root
 * element as the fixed 220x340 stage from the design handoff
 * (`design/peek-mascot/README.md`) with one mascot per visible
 * slot.
 *
 * Three nested layers per mascot, exactly as the handoff specifies, because
 * each one carries a different transform and they must not fight:
 *   position layer  right/bottom/z-index + the ENTRANCE animation + the
 *                   bottom/right transition (`.pm-pos`)
 *   tilt layer      the pose's static rotation, origin 80% 100% (`.pm-tilt`)
 *   reaction layer  the idle bob / strain / click reaction, origin
 *                   center bottom, and the click target (`.pm-react`)
 *
 * NODES ARE KEPT, NOT REBUILT. A re-render writes a style property only when
 * its value actually changed, because in CSS assigning `animation` restarts
 * it: if a mood change rewrote the position layer, slot 1's climb would
 * replay every time slot 0 laughs, and its `bottom` move when slot 2 appears
 * would jump instead of running the .7s transition. Only the three variable
 * pieces of artwork (outline path, left arm, face) are rebuilt, and only when
 * their variant changes — which is also what (re)starts the wave and blink
 * animations inside them.
 *
 * The stage is `aria-hidden`: the mascots are decorative art — a click makes
 * one laugh or wave, and in the host then brings the app to that session,
 * which the app itself also offers — and the page carries no text. The real
 * interface is the controller API in ./main.ts.
 */
import type { Arm, Face, MascotState, SlotView } from './model.ts';
import type { BoxRect } from './feed.ts';

/**
 * Margin around each mascot's box in `rects()`, CSS px. The host clips its
 * window to these rects (PLAN-C1 § The window: a window region), and a region
 * clips DRAWING as well as clicks — the waving arm, the laugh's hop and the
 * strain's squash all reach past the reaction layer's own box, so the margin
 * is what keeps them from being cut off.
 */
const RECT_MARGIN = 16;

/** The stage's size (handoff: a fixed 220 x 340 box). */
const STAGE_W = 220;
const STAGE_H = 340;

const SVG_NS = 'http://www.w3.org/2000/svg';

/** The mascot's five colours (handoff §Design Tokens). Its own, not app tokens. */
const BODY = '#d97757';
const SHADE = '#c96442';
const HIGHLIGHT = '#eb9878';
const INK = '#2d2b26';
const SWEAT = '#9cc7e8';

/** The dark silhouette drawn under the body, one path per arm variant. */
const OUTLINE: Record<Arm, string> = {
  down: 'M4 5 H13 V6 H14 V8 H15 V12 H14 V13 H13 V14 H12 V17 H10 V14 H7 V17 H5 V14 H4 V13 H3 V13 H1 V8 H3 V6 H4 Z',
  up: 'M4 5 H13 V6 H14 V8 H15 V12 H14 V13 H13 V14 H12 V17 H10 V14 H7 V17 H5 V14 H4 V13 H3 V9 H1 V2 H3 V6 H4 Z',
  waving: 'M4 5 H13 V6 H14 V8 H15 V12 H14 V13 H13 V14 H12 V17 H10 V14 H7 V17 H5 V14 H4 V13 H3 V6 H4 Z',
};

/** `[x, y, width, height, fill]` — one pixel-grid rect of the artwork. */
type Rect = [number, number, number, number, string];

/** Body, trunk shading and highlight (handoff step 2). */
const BODY_RECTS: Rect[] = [
  [4, 5, 9, 1, BODY],
  [3, 6, 11, 7, BODY],
  [4, 13, 9, 1, SHADE],
  [4, 6, 2, 1, HIGHLIGHT],
  [4, 7, 1, 1, HIGHLIGHT],
  [12, 7, 1, 6, SHADE],
];

/** Right arm, feet and soles (handoff steps 4 and 5). */
const TRAILING_RECTS: Rect[] = [
  [14, 8, 1, 4, SHADE],
  [5, 14, 2, 2, BODY],
  [10, 14, 2, 2, BODY],
  [5, 16, 2, 1, SHADE],
  [10, 16, 2, 1, SHADE],
];

/** Left arm, per variant (handoff step 3). The waving one animates itself. */
const ARM_RECTS: Record<Exclude<Arm, 'waving'>, Rect[]> = {
  down: [
    [1, 8, 2, 4, BODY],
    [1, 12, 2, 1, HIGHLIGHT],
  ],
  up: [
    [1, 3, 2, 6, BODY],
    [1, 2, 2, 1, HIGHLIGHT],
  ],
};

const WAVING_ARM_RECTS: Rect[] = [
  [0.5, 2.5, 2.5, 7, INK],
  [1, 4, 2, 5, BODY],
  [1, 3, 2, 1, HIGHLIGHT],
];

/** Faces (handoff step 6). `normal`'s eyes blink; the mouth does not. */
const HAPPY_RECTS: Rect[] = [
  [5, 8, 1, 1, INK],
  [6, 7, 1, 1, INK],
  [7, 8, 1, 1, INK],
  [9, 8, 1, 1, INK],
  [10, 7, 1, 1, INK],
  [11, 8, 1, 1, INK],
  [6, 11, 5, 1, INK],
  [5, 10, 1, 1, INK],
  [11, 10, 1, 1, INK],
];

const STRAIN_RECTS: Rect[] = [
  [5, 8, 1, 1, INK],
  [6, 9, 2, 1, INK],
  [11, 8, 1, 1, INK],
  [9, 9, 2, 1, INK],
  [6, 11, 5, 1, INK],
  [7, 12, 1, 1, INK],
  [9, 12, 1, 1, INK],
  [12, 6, 1, 1, SWEAT],
];

const NORMAL_EYE_RECTS: Rect[] = [
  [6, 8, 1, 2, INK],
  [10, 8, 1, 2, INK],
];

function rect(r: Rect): SVGRectElement {
  const el = document.createElementNS(SVG_NS, 'rect');
  el.setAttribute('x', String(r[0]));
  el.setAttribute('y', String(r[1]));
  el.setAttribute('width', String(r[2]));
  el.setAttribute('height', String(r[3]));
  el.setAttribute('fill', r[4]);
  return el;
}

function appendRects(parent: SVGElement, rects: Rect[]): void {
  for (const r of rects) parent.appendChild(rect(r));
}

/** The nodes of one mascot, plus the last values written to them. */
interface SlotNodes {
  pos: HTMLDivElement;
  tilt: HTMLDivElement;
  react: HTMLDivElement;
  outline: SVGPathElement;
  /** Stable placeholder: the left arm keeps its place in the draw order. */
  arm: SVGGElement;
  /** Stable placeholder: the face is drawn last, over everything. */
  face: SVGGElement;
  drawn: Partial<SlotView>;
  /**
   * True while the position layer's entrance runs. Bumped `entry` makes a
   * finished watch from an OLDER entrance (count 2 -> 3 restarts it) a no-op.
   */
  entering: boolean;
  entry: number;
}

/** What the view needs from its owner. */
export interface MascotViewOptions {
  /** A click on a mascot. The owner forwards it to the model's `poke`. */
  onPoke: (slot: number) => void;
  /**
   * A mascot's entrance finished — `rects()` changed although no state did.
   * The page re-reports to the host on it (Nocturne C1).
   */
  onSettle?: () => void;
}

export class MascotView {
  private readonly stage: HTMLDivElement;
  private readonly onPoke: (slot: number) => void;
  private readonly onSettle: (() => void) | null;
  private readonly slots = new Map<number, SlotNodes>();

  constructor(root: HTMLElement, options: MascotViewOptions) {
    this.onPoke = options.onPoke;
    this.onSettle = options.onSettle ?? null;
    this.stage = document.createElement('div');
    this.stage.className = 'pm-stage';
    this.stage.setAttribute('aria-hidden', 'true');
    root.appendChild(this.stage);
  }

  /** Draw a snapshot. Safe to call on every state change. */
  render(state: MascotState): void {
    for (const [index, nodes] of this.slots) {
      if (index >= state.slots.length) {
        nodes.pos.remove();
        this.slots.delete(index);
      }
    }
    for (const slot of state.slots) this.drawSlot(slot);
  }

  /**
   * Where each visible mascot is, slot order, in CSS px of the page, for the
   * host's click-through region: the reaction layer's box (its tilt included)
   * plus `RECT_MARGIN`, clipped to the page and rounded outward. While a
   * mascot's ENTRANCE runs it answers the whole stage instead — the climb and
   * the squeeze travel through space the settled box does not cover, and a
   * region clips drawing — and `onSettle` asks for the tight box after.
   */
  rects(): BoxRect[] {
    const out: BoxRect[] = [];
    const vw = typeof window === 'undefined' ? STAGE_W : window.innerWidth;
    const vh = typeof window === 'undefined' ? STAGE_H : window.innerHeight;
    const ordered = [...this.slots.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, nodes] of ordered) {
      let box = { left: vw - STAGE_W, top: (vh - STAGE_H) / 2, right: vw, bottom: (vh + STAGE_H) / 2 };
      if (!nodes.entering && typeof nodes.react.getBoundingClientRect === 'function') {
        const r = nodes.react.getBoundingClientRect();
        box = {
          left: r.left - RECT_MARGIN,
          top: r.top - RECT_MARGIN,
          right: r.right + RECT_MARGIN,
          bottom: r.bottom + RECT_MARGIN,
        };
      }
      const x0 = Math.max(0, Math.floor(box.left));
      const y0 = Math.max(0, Math.floor(box.top));
      const x1 = Math.min(vw, Math.ceil(box.right));
      const y1 = Math.min(vh, Math.ceil(box.bottom));
      if (x1 > x0 && y1 > y0) out.push([x0, y0, x1 - x0, y1 - y0]);
    }
    return out;
  }

  /** Remove everything this view put in the page. */
  destroy(): void {
    this.slots.clear();
    this.stage.remove();
  }

  private drawSlot(view: SlotView): void {
    const nodes = this.slots.get(view.slot) ?? this.createSlot(view.slot);
    const drawn = nodes.drawn;

    // Position layer. `animation` last: writing it restarts the entrance, so
    // it is only ever written when the string itself changed (count 2 <-> 3).
    if (drawn.right !== view.right) nodes.pos.style.right = view.right;
    if (drawn.bottom !== view.bottom) nodes.pos.style.bottom = view.bottom;
    if (drawn.z !== view.z) nodes.pos.style.zIndex = String(view.z);
    if (drawn.enter !== view.enter) {
      nodes.pos.style.animation = view.enter;
      this.watchEntrance(nodes);
    }
    if (drawn.tilt !== view.tilt) nodes.tilt.style.transform = view.tilt;
    if (drawn.anim !== view.anim) nodes.react.style.animation = view.anim;

    if (drawn.armVariant !== view.armVariant) {
      nodes.outline.setAttribute('d', OUTLINE[view.armVariant]);
      this.drawArm(nodes.arm, view.armVariant);
    }
    if (drawn.face !== view.face) this.drawFace(nodes.face, view.face);

    nodes.drawn = { ...view };
  }

  private createSlot(index: number): SlotNodes {
    const pos = document.createElement('div');
    pos.className = 'pm-pos';

    const tilt = document.createElement('div');
    tilt.className = 'pm-tilt';

    const react = document.createElement('div');
    react.className = 'pm-react';
    react.title = 'Click me';
    react.addEventListener('click', () => this.onPoke(index));

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', '100');
    svg.setAttribute('height', '120');
    svg.setAttribute('viewBox', '0 0 15 18');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('shape-rendering', 'crispEdges');
    svg.setAttribute('class', 'pm-art');

    // Draw order is the artwork: silhouette, body, left arm, right arm and
    // feet, face. Each `appendChild` below is one step of handoff §SVG.
    const outline = document.createElementNS(SVG_NS, 'path');
    outline.setAttribute('fill', INK);
    outline.setAttribute('stroke', INK);
    outline.setAttribute('stroke-width', '1');
    outline.setAttribute('stroke-linejoin', 'miter');
    svg.appendChild(outline);

    const body = document.createElementNS(SVG_NS, 'g');
    appendRects(body, BODY_RECTS);
    svg.appendChild(body);

    const arm = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(arm);

    const trailing = document.createElementNS(SVG_NS, 'g');
    appendRects(trailing, TRAILING_RECTS);
    svg.appendChild(trailing);

    const face = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(face);

    react.appendChild(svg);
    tilt.appendChild(react);
    pos.appendChild(tilt);
    this.stage.appendChild(pos);

    const nodes: SlotNodes = {
      pos,
      tilt,
      react,
      outline,
      arm,
      face,
      drawn: {},
      entering: false,
      entry: 0,
    };
    this.slots.set(index, nodes);
    return nodes;
  }

  /**
   * Follow the entrance that was just (re)started on this position layer and
   * say when it is over. The browser's own list of running animations is the
   * source: under `prefers-reduced-motion` the stylesheet removes them all,
   * the list is empty, and the mascot is settled the moment it is drawn.
   */
  private watchEntrance(nodes: SlotNodes): void {
    const entry = ++nodes.entry;
    const pos = nodes.pos as HTMLDivElement & { getAnimations?: () => Animation[] };
    const running = typeof pos.getAnimations === 'function' ? pos.getAnimations() : [];
    if (running.length === 0) {
      nodes.entering = false;
      return;
    }
    nodes.entering = true;
    void Promise.allSettled(running.map((a) => a.finished)).then(() => {
      if (nodes.entry !== entry || !this.slots.has(this.indexOf(nodes))) return;
      nodes.entering = false;
      this.onSettle?.();
    });
  }

  private indexOf(nodes: SlotNodes): number {
    for (const [i, n] of this.slots) if (n === nodes) return i;
    return -1;
  }

  private drawArm(host: SVGGElement, variant: Arm): void {
    host.replaceChildren();
    if (variant === 'waving') {
      // Its own group so the wave rotates around the shoulder, and so that
      // rebuilding it here is what starts the single 1.3s wave.
      const waving = document.createElementNS(SVG_NS, 'g');
      waving.style.transformOrigin = '2px 9px';
      waving.style.animation = 'wave 1.3s ease-in-out 1';
      appendRects(waving, WAVING_ARM_RECTS);
      host.appendChild(waving);
      return;
    }
    appendRects(host, ARM_RECTS[variant]);
  }

  private drawFace(host: SVGGElement, face: Face): void {
    host.replaceChildren();
    if (face === 'normal') {
      const eyes = document.createElementNS(SVG_NS, 'g');
      eyes.style.transformOrigin = '8.5px 9px';
      eyes.style.animation = 'blink 4s infinite';
      appendRects(eyes, NORMAL_EYE_RECTS);
      host.appendChild(eyes);
      host.appendChild(rect([8, 11, 1, 1, INK]));
      return;
    }
    appendRects(host, face === 'happy' ? HAPPY_RECTS : STRAIN_RECTS);
  }
}
