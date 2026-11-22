/**
 * Claude peek mascot — presence (Nocturne D8, `.claude/plans/nocturne/PLAN-D8.md`).
 * While the app window is the active window the mascots step back behind the
 * screen edge; when it stops being active they peek out again with their
 * existing entrance. Which mascots EXIST stays the model's (./model.ts) and
 * the feed's (./feed.ts) business: this only decides whether they are drawn.
 *
 * The rules are pure (`nextPresence`, `drawnState` in ./model.ts); this class
 * holds the one piece of state they need — where the mascots are — and runs
 * the steps in the order the host relies on:
 * - stepping back: the region first widens to the whole stage (the slide
 *   leaves the settled box), and only when the slide has ENDED does the host
 *   hear the real count with `"rects":[]` — an empty region, click-through,
 *   so nothing invisible blocks a click;
 * - coming back: the mascots are drawn and the host hears their rects in the
 *   same task, before the browser paints the entrance's first frame;
 * - while away, a count change is reported with `"rects":[]` too.
 *
 * Until the page hears anything it assumes the app is NOT active (C1's
 * behaviour); outside the host it never hears anything.
 */
import { drawnState, nextPresence, type MascotModel, type MascotState, type Presence } from './model.ts';
import type { MascotView } from './view.ts';

interface MascotPresenceOptions {
  model: Pick<MascotModel, 'snapshot' | 'isReacting'>;
  view: Pick<MascotView, 'render' | 'retreat' | 'comeBack'>;
  /** Tell the host the count and the rects as they are now. */
  report: () => void;
}

export class MascotPresence {
  #presence: Presence = 'out';
  #active = false;
  readonly #opts: MascotPresenceOptions;

  constructor(opts: MascotPresenceOptions) {
    this.#opts = opts;
  }

  /** The host's word (or the `?demo` toggle): is the app the active window? */
  setActive(active: boolean): void {
    this.#active = active;
    this.#step();
  }

  /** The model changed: draw what this presence shows, then see whether it may move on. */
  changed(state: MascotState): void {
    const drawn = drawnState(state, this.#presence);
    if (drawn !== null) this.#opts.view.render(drawn);
    // A reaction that just ended may be what an active app was waiting for.
    this.#step();
    this.#opts.report();
  }

  #step(): void {
    const { model, view, report } = this.#opts;
    const next = nextPresence(this.#presence, this.#active, model.isReacting());
    if (next === this.#presence) return;
    this.#presence = next;
    if (next === 'leaving') {
      view.retreat(() => this.#retreated());
      // Reported after retreat(): the rects are the whole stage while it
      // slides (or, under reduced motion, already none — it ended at once).
      report();
      return;
    }
    // next === 'out' (nextPresence never jumps to 'away').
    view.comeBack();
    view.render(model.snapshot());
    report();
  }

  #retreated(): void {
    if (this.#presence !== 'leaving') return;
    this.#presence = 'away';
    this.changed(this.#opts.model.snapshot());
  }
}
