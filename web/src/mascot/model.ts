/**
 * Claude peek mascot — the pure state machine behind the mascots that peek
 * around the right edge of the screen when the app needs the user's input
 * (design handoff: `design_handoff_claude_peek_mascot/README.md`, high
 * fidelity, recreate 1:1).
 *
 * No DOM, no timers of its own: every value the rules need is handed in
 * (`setTimeout`/`clearTimeout`/`random` are constructor options), so
 * `node --test` drives all of it without a browser and without waiting on
 * real clocks. The view (./view.ts) renders `snapshot()` and calls `poke()`;
 * nothing else touches this state.
 *
 * What the model owns, in the handoff's own words:
 * - `count: 0..3` — the number of pending inputs, clamped, driven by the app.
 * - one mood per slot (`idle` | `laugh` | `wave`), each with its own timeout
 *   back to `idle` (1400 ms / 1300 ms).
 * - `straining` — set when the count transitions TO 3, cleared after 3400 ms.
 *
 * What it does NOT own: sessions. This page is driven purely by a number; the
 * wiring to real pending inputs is a later plan part.
 */

/** Never more than three mascots, whatever the app asks for. */
export const MAX_COUNT = 3;

/** How long a click reaction lasts before the slot returns to `idle`. */
export const LAUGH_MS = 1400;
export const WAVE_MS = 1300;

/** How long slot 0 strains under the weight after the count reaches 3. */
export const STRAIN_MS = 3400;

/** A slot's mood. `idle` is also "no click reaction running". */
export type Mood = 'idle' | 'laugh' | 'wave';

/** Which left-arm artwork a mascot draws. */
export type Arm = 'down' | 'up' | 'waving';

/** Which face artwork a mascot draws. */
export type Face = 'normal' | 'happy' | 'strain';

/** The animation on the reaction layer while a slot is idle. */
export const BOB_ANIM = 'bob 3s ease-in-out infinite';

/** The animation on the reaction layer while slot 0 is straining. */
export const STRAIN_ANIM = 'strain 1.1s ease-in-out infinite';

/** The two click reactions, with the animation and duration of each. */
export const REACTIONS = {
  laugh: { anim: 'laugh 1.4s ease-in-out 1', dur: LAUGH_MS },
  wave: { anim: 'waveBody 1.3s ease-in-out 1', dur: WAVE_MS },
} as const satisfies Record<Exclude<Mood, 'idle'>, { anim: string; dur: number }>;

/** The reactions a click picks from, in the order the random draw sees them. */
export const REACTION_KEYS: readonly Exclude<Mood, 'idle'>[] = ['laugh', 'wave'];

/**
 * A pose = where a slot stands and how it entered. Straight from the
 * handoff's pose table; the two count-dependent values (slot 1's `bottom`,
 * the appended `shove` at count 3) are computed by `poses()`.
 */
export interface Pose {
  /** CSS `right` on the position layer — negative: the edge clips the body. */
  right: string;
  /** CSS `bottom` on the position layer. */
  bottom: string;
  /** Stacking order. #0 in front, #2 middle, #1 behind. */
  z: number;
  /** CSS `transform` on the tilt layer. */
  tilt: string;
  /** Which left arm the pose uses when the mascot is not waving. */
  arm: Exclude<Arm, 'waving'>;
  /** CSS `animation` on the position layer: the entrance. */
  enter: string;
}

/** Everything the view needs to draw one visible mascot. */
export interface SlotView extends Pose {
  /** 0-based slot index; also what `poke()` takes. */
  slot: number;
  /** The left arm actually drawn (a waving mascot overrides the pose). */
  arm: Exclude<Arm, 'waving'>;
  /** The left-arm artwork to draw. */
  armVariant: Arm;
  /** The face artwork to draw. */
  face: Face;
  /** CSS `animation` on the reaction layer: idle bob, strain, or a reaction. */
  anim: string;
}

/** What the view renders from. One entry per VISIBLE slot. */
export interface MascotState {
  /** The clamped count, i.e. `slots.length`. */
  count: number;
  slots: SlotView[];
}

/** An opaque timer handle — whatever the injected `setTimeout` returns. */
export type TimerHandle = unknown;

/** The seams: clocks and randomness, so tests own both. */
export interface MascotModelOptions {
  setTimeout?: (fn: () => void, ms: number) => TimerHandle;
  clearTimeout?: (handle: TimerHandle) => void;
  /** Returns [0,1) — the laugh/wave draw. */
  random?: () => number;
  /** Called after every state change, with the fresh snapshot. */
  onChange?: (state: MascotState) => void;
}

/**
 * Clamp whatever the app hands in to a whole 0..3. A count is a number of
 * pending inputs: anything that is not a finite number is no inputs at all.
 */
export function clampCount(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(MAX_COUNT, Math.floor(n)));
}

/**
 * The pose table (handoff §Poses). `count` matters twice: slot 1 stands
 * higher when a third mascot squeezes in below it, and slots 0 and 1 get the
 * `shove` animation appended while there are three.
 */
export function poses(count: number): Pose[] {
  const three = count === MAX_COUNT;
  return [
    {
      right: '-50px',
      bottom: '14px',
      z: 3,
      tilt: 'rotate(-22deg)',
      arm: 'down',
      enter: three
        ? 'slideIn 1.4s cubic-bezier(.25,.8,.3,1) both, shove .4s ease-in-out 0.4s 5'
        : 'slideIn 1.4s cubic-bezier(.25,.8,.3,1) both',
    },
    {
      right: '-40px',
      bottom: three ? '110px' : '58px',
      z: 1,
      tilt: 'rotate(-8deg)',
      arm: 'up',
      enter: three
        ? 'climb 1.6s cubic-bezier(.4,.1,.4,1) both, shove .4s ease-in-out 0.5s 5'
        : 'climb 1.6s cubic-bezier(.4,.1,.4,1) both',
    },
    {
      right: '-16px',
      bottom: '52px',
      z: 2,
      tilt: 'rotate(6deg)',
      arm: 'down',
      enter: 'squeeze 2.6s ease-in-out both',
    },
  ];
}

/**
 * The mascot state machine. One instance per page; `destroy()` clears every
 * timer it ever set.
 */
export class MascotModel {
  private count = 0;
  private moods: Mood[] = ['idle', 'idle', 'idle'];
  private straining = false;
  private moodTimers: (TimerHandle | null)[] = [null, null, null];
  private strainTimer: TimerHandle | null = null;
  private destroyed = false;

  private readonly setT: (fn: () => void, ms: number) => TimerHandle;
  private readonly clearT: (handle: TimerHandle) => void;
  private readonly random: () => number;
  private readonly onChange: ((state: MascotState) => void) | null;

  constructor(options: MascotModelOptions = {}) {
    this.setT = options.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearT = options.clearTimeout ?? ((handle) => clearTimeout(handle as never));
    this.random = options.random ?? Math.random;
    this.onChange = options.onChange ?? null;
  }

  /** The clamped count currently on screen. */
  getCount(): number {
    return this.count;
  }

  /**
   * Drive the mascots. Two transitions matter beyond the number itself:
   * going UP to 3 starts the strain (3400 ms), and going DOWN unmounts the
   * highest slots — their mood and its pending timer go with them, so a
   * mascot that was laughing when it left never comes back mid-laugh.
   */
  setCount(next: number): void {
    if (this.destroyed) return;
    const count = clampCount(next);
    if (count === this.count) return;
    const before = this.count;
    this.count = count;
    for (let i = count; i < MAX_COUNT; i++) this.resetSlot(i);
    if (count === MAX_COUNT && before < MAX_COUNT) {
      this.straining = true;
      this.clearT(this.strainTimer);
      this.strainTimer = this.setT(() => {
        this.strainTimer = null;
        this.straining = false;
        this.emit();
      }, STRAIN_MS);
    }
    this.emit();
  }

  /**
   * A click on slot `i`: pick laugh or wave at random and return to idle
   * after its duration. A slot that is already reacting ignores the click
   * (handoff: "Ignore clicks while reacting").
   */
  poke(slot: number): void {
    if (this.destroyed) return;
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.count) return;
    if (this.moods[slot] !== 'idle') return;
    const draw = Math.floor(this.random() * REACTION_KEYS.length);
    const index = Math.min(REACTION_KEYS.length - 1, Math.max(0, draw));
    const pick = REACTION_KEYS[index]!;
    this.moods[slot] = pick;
    this.clearT(this.moodTimers[slot]);
    this.moodTimers[slot] = this.setT(() => {
      this.moodTimers[slot] = null;
      this.moods[slot] = 'idle';
      this.emit();
    }, REACTIONS[pick].dur);
    this.emit();
  }

  /** What the view draws right now. A fresh object every call. */
  snapshot(): MascotState {
    const table = poses(this.count);
    const slots: SlotView[] = [];
    for (let i = 0; i < this.count; i++) {
      const pose = table[i]!;
      const mood = this.moods[i]!;
      // Only slot 0 strains, and only while it is not busy reacting.
      const strain = i === 0 && this.straining && mood === 'idle';
      const reaction = mood === 'idle' ? null : REACTIONS[mood];
      slots.push({
        ...pose,
        slot: i,
        armVariant: mood === 'wave' ? 'waving' : pose.arm,
        face: mood === 'laugh' ? 'happy' : strain ? 'strain' : 'normal',
        anim: reaction ? reaction.anim : strain ? STRAIN_ANIM : BOB_ANIM,
      });
    }
    return { count: this.count, slots };
  }

  /** Clear every timer. The model answers nothing after this. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (let i = 0; i < MAX_COUNT; i++) {
      this.clearT(this.moodTimers[i]);
      this.moodTimers[i] = null;
    }
    this.clearT(this.strainTimer);
    this.strainTimer = null;
  }

  /** An unmounted slot keeps no mood and no pending timeout. */
  private resetSlot(i: number): void {
    this.clearT(this.moodTimers[i]);
    this.moodTimers[i] = null;
    this.moods[i] = 'idle';
  }

  private emit(): void {
    if (this.destroyed) return;
    this.onChange?.(this.snapshot());
  }
}
