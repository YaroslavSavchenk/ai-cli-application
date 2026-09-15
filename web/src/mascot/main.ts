/**
 * Claude peek mascot — page entry. A SEPARATE page of the app
 * (`web/mascot.html`), not part of the shell: it holds nothing but the
 * mascots, calls no API, and renders on a transparent background, because the
 * Windows host will later show it in a transparent always-on-top overlay
 * window pinned to the edge of the monitor.
 *
 * The page is driven purely by a number. Everything outside it talks to one
 * controller:
 *
 *   window.aiSmMascot.setCount(2)   // 2 pending inputs -> 2 mascots
 *   window.aiSmMascot.getCount()
 *   window.aiSmMascot.destroy()
 *
 * Wiring that count to real sessions waiting for input is a later plan part;
 * nothing here knows what a session is.
 *
 * `?demo` adds a small dev-only control strip and the app's own background so
 * the page can be exercised by hand in a normal browser window (`&count=N`
 * sets the starting count). Without it: transparent, no controls, count 0.
 */
import './mascot.css';
import { MascotModel } from './model.ts';
import { MascotView } from './view.ts';

/** The one interface the rest of the world has to this page. */
export interface MascotController {
  /** How many inputs are waiting. Clamped to 0..3. */
  setCount(n: number): void;
  getCount(): number;
  /** Clear every timer and take the mascots out of the page. */
  destroy(): void;
}

declare global {
  interface Window {
    aiSmMascot?: MascotController;
  }
}

/** The app's own background (`--color-bg`), painted only in demo mode. */
const DEMO_BG = '#161826';

function mount(root: HTMLElement): MascotController {
  // The strip is built after the model, so the model's change callback reaches
  // it through this seam instead of the two knowing about each other.
  let onCount: ((count: number) => void) | null = null;

  const model = new MascotModel({
    onChange: (state) => {
      view.render(state);
      onCount?.(state.count);
    },
  });
  const view = new MascotView(root, { onPoke: (slot) => model.poke(slot) });

  view.render(model.snapshot());

  const params = new URLSearchParams(window.location.search);
  if (params.has('demo')) {
    onCount = demoStrip(root, model);
    document.body.style.background = DEMO_BG;
    const start = Number(params.get('count') ?? '0');
    model.setCount(start);
    onCount(model.getCount());
  }

  return {
    setCount: (n) => model.setCount(n),
    getCount: () => model.getCount(),
    destroy: () => {
      model.destroy();
      view.destroy();
    },
  };
}

/**
 * The dev-only strip: what the count is, and the two ways to change it.
 * Buttons, so the keyboard reaches them; no other affordance on the page is
 * interactive. Never rendered without `?demo`.
 */
function demoStrip(root: HTMLElement, model: MascotModel): (count: number) => void {
  const strip = document.createElement('div');
  strip.className = 'pm-demo';

  const label = document.createElement('span');
  strip.appendChild(label);

  const more = document.createElement('button');
  more.type = 'button';
  more.textContent = '+ input';
  more.addEventListener('click', () => model.setCount(model.getCount() + 1));
  strip.appendChild(more);

  const fewer = document.createElement('button');
  fewer.type = 'button';
  fewer.textContent = '− resolved';
  fewer.addEventListener('click', () => model.setCount(model.getCount() - 1));
  strip.appendChild(fewer);

  root.appendChild(strip);

  return (count: number) => {
    label.textContent = `Inputs waiting: ${count}`;
  };
}

const root = document.getElementById('mascot');
if (root instanceof HTMLElement) window.aiSmMascot = mount(root);
