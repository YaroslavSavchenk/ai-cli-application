/**
 * `web/src/mascot/model.ts` — the pure state machine behind the Claude peek
 * mascots (design handoff `design/peek-mascot/README.md`,
 * marked HIGH FIDELITY: "Colors, pixel grid, sizes, positions, timings and
 * easing are final. Recreate 1:1"). This file is where that "1:1" is pinned as
 * values: the pose table per count, the two reaction animations and their
 * durations, and the three timing rules (1400 ms laugh, 1300 ms wave, 3400 ms
 * strain).
 *
 * WHY here and not in a DOM test: the model takes `setTimeout`/`clearTimeout`/
 * `random` as constructor options, so every timing and every random draw is a
 * VALUE a test hands in — no clock to wait on, no flake, and the rules stay
 * pinned while the renderer (./view.ts) and the page (./main.ts) change. The
 * timer double also answers the question a real clock cannot: is a timer for a
 * mascot that left the screen still armed?
 *
 * NOT claimed here: that anything is drawn (that is
 * `tests/ui/ui-mascot-view.test.ts`), that any CSS animation runs, that the page
 * mounts, or that a single real pending input ever moves the count — nothing
 * wires the count to sessions yet; the page is driven by a number. What the
 * mascots LOOK like on a screen is a human's call
 * (`.claude/skills/verify-terminal/SKILL.md` covers the terminal; this page
 * needs an eye of its own).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOB_ANIM,
  LAUGH_MS,
  MAX_COUNT,
  MascotModel,
  REACTIONS,
  REACTION_KEYS,
  STRAIN_ANIM,
  STRAIN_MS,
  WAVE_MS,
  clampCount,
  poses,
  type MascotState,
  type Pose,
  type TimerHandle,
} from '../../web/src/mascot/model.ts';

// ---------------------------------------------------------------------------
// Harness: a clock the test owns
// ---------------------------------------------------------------------------

interface Armed {
  id: number;
  at: number;
  ms: number;
  fn: () => void;
}

/**
 * A scheduler with no real time in it. `advance(ms)` fires everything due in
 * that window, in due order; `pending` is what is still armed — which is how a
 * leaked timer is caught (a real clock would only show it by waiting).
 */
class Clock {
  now = 0;
  private seq = 0;
  private readonly armed = new Map<number, Armed>();
  /** Every delay ever requested, in order — the durations the handoff fixes. */
  readonly delays: number[] = [];

  readonly setTimeout = (fn: () => void, ms: number): TimerHandle => {
    this.seq += 1;
    const id = this.seq;
    this.armed.set(id, { id, at: this.now + ms, ms, fn });
    this.delays.push(ms);
    return id;
  };

  readonly clearTimeout = (handle: TimerHandle): void => {
    if (typeof handle === 'number') this.armed.delete(handle);
  };

  get pending(): number {
    return this.armed.size;
  }

  /** The delays of the timers still armed, ascending by due time. */
  pendingDelays(): number[] {
    return [...this.armed.values()].sort((a, b) => a.at - b.at || a.id - b.id).map((t) => t.ms);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      let next: Armed | null = null;
      for (const t of this.armed.values()) {
        if (t.at > end) continue;
        if (next === null || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
      }
      if (next === null) break;
      this.armed.delete(next.id);
      this.now = next.at;
      next.fn();
    }
    this.now = end;
  }
}

/** A random() that reads a script, and repeats its last value forever. */
function draws(...values: number[]): () => number {
  let i = 0;
  return () => {
    const v = values[Math.min(i, values.length - 1)] ?? 0;
    i += 1;
    return v;
  };
}

interface Harness {
  model: MascotModel;
  clock: Clock;
  /** Every snapshot handed to `onChange`, in order. */
  changes: MascotState[];
}

function makeModel(random: () => number = draws(0)): Harness {
  const clock = new Clock();
  const changes: MascotState[] = [];
  const model = new MascotModel({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    random,
    onChange: (state) => changes.push(state),
  });
  return { model, clock, changes };
}

/** Just the pose half of a snapshot slot, for comparison with the table. */
function poseOf(state: MascotState, slot: number): Pose {
  const s = state.slots[slot]!;
  return { right: s.right, bottom: s.bottom, z: s.z, tilt: s.tilt, arm: s.arm, enter: s.enter };
}

// ---------------------------------------------------------------------------
// The handoff's own constants
// ---------------------------------------------------------------------------

test('the timings and animation strings are the handoff\'s, to the character', () => {
  assert.equal(MAX_COUNT, 3, 'handoff: "Never more than 3 mascots"');
  assert.equal(LAUGH_MS, 1400);
  assert.equal(WAVE_MS, 1300);
  assert.equal(STRAIN_MS, 3400);
  assert.equal(BOB_ANIM, 'bob 3s ease-in-out infinite');
  assert.equal(STRAIN_ANIM, 'strain 1.1s ease-in-out infinite');
  assert.deepEqual(REACTIONS, {
    laugh: { anim: 'laugh 1.4s ease-in-out 1', dur: 1400 },
    wave: { anim: 'waveBody 1.3s ease-in-out 1', dur: 1300 },
  });
  assert.deepEqual([...REACTION_KEYS], ['laugh', 'wave']);
});

// ---------------------------------------------------------------------------
// clampCount
// ---------------------------------------------------------------------------

test('clampCount: a count of pending inputs is a whole 0..3', () => {
  assert.equal(clampCount(0), 0);
  assert.equal(clampCount(1), 1);
  assert.equal(clampCount(2), 2);
  assert.equal(clampCount(3), 3);
  // Over the ceiling: three mascots, whatever the app asks for.
  assert.equal(clampCount(4), 3);
  assert.equal(clampCount(9999), 3);
  assert.equal(clampCount(Infinity), 0, 'not a finite number of inputs -> no inputs');
  // Under it: a negative number of pending inputs is none.
  assert.equal(clampCount(-1), 0);
  assert.equal(clampCount(-0.5), 0);
  assert.equal(clampCount(-Infinity), 0);
  // Fractions floor, never round: 2.9 inputs is 2 answered mascots.
  assert.equal(clampCount(2.9), 2);
  assert.equal(clampCount(0.9), 0);
  assert.equal(clampCount(3.9), 3);
  // Junk is no inputs at all, never a throw.
  assert.equal(clampCount(NaN), 0);
  assert.equal(clampCount(Number('x')), 0);
});

test('setCount clamps what the app hands in', () => {
  const { model } = makeModel();
  model.setCount(99);
  assert.equal(model.getCount(), 3);
  assert.equal(model.snapshot().slots.length, 3);
  model.setCount(-4);
  assert.equal(model.getCount(), 0);
  assert.deepEqual(model.snapshot(), { count: 0, slots: [] });
  model.setCount(2.7);
  assert.equal(model.getCount(), 2);
});

// ---------------------------------------------------------------------------
// The pose table (handoff §Poses)
// ---------------------------------------------------------------------------

/** The table as the README prints it, for counts other than 3. */
const POSE_1: Pose = {
  right: '-50px',
  bottom: '14px',
  z: 3,
  tilt: 'rotate(-22deg)',
  arm: 'down',
  enter: 'slideIn 1.4s cubic-bezier(.25,.8,.3,1) both',
};
const POSE_2: Pose = {
  right: '-40px',
  bottom: '58px',
  z: 1,
  tilt: 'rotate(-8deg)',
  arm: 'up',
  enter: 'climb 1.6s cubic-bezier(.4,.1,.4,1) both',
};
const POSE_3: Pose = {
  right: '-16px',
  bottom: '52px',
  z: 2,
  tilt: 'rotate(6deg)',
  arm: 'down',
  enter: 'squeeze 2.6s ease-in-out both',
};

test('poses: count 1 and 2 are the table verbatim, no shove anywhere', () => {
  for (const count of [0, 1, 2]) {
    assert.deepEqual(poses(count), [POSE_1, POSE_2, POSE_3], `count ${count}`);
  }
});

test('poses: count 3 raises slot 1 and appends the two shoves', () => {
  assert.deepEqual(poses(3), [
    { ...POSE_1, enter: 'slideIn 1.4s cubic-bezier(.25,.8,.3,1) both, shove .4s ease-in-out 0.4s 5' },
    {
      ...POSE_2,
      bottom: '110px',
      enter: 'climb 1.6s cubic-bezier(.4,.1,.4,1) both, shove .4s ease-in-out 0.5s 5',
    },
    POSE_3,
  ]);
});

test('a snapshot draws exactly `count` slots, each with its pose', () => {
  const { model } = makeModel();

  model.setCount(1);
  let state = model.snapshot();
  assert.equal(state.count, 1);
  assert.equal(state.slots.length, 1);
  assert.deepEqual(poseOf(state, 0), POSE_1);
  assert.deepEqual(
    state.slots.map((s) => s.slot),
    [0],
  );

  model.setCount(2);
  state = model.snapshot();
  assert.equal(state.slots.length, 2);
  assert.deepEqual(poseOf(state, 0), POSE_1);
  assert.deepEqual(poseOf(state, 1), POSE_2, 'slot 1 stands at 58px while there are two');

  model.setCount(3);
  state = model.snapshot();
  assert.equal(state.slots.length, 3);
  assert.equal(poseOf(state, 1).bottom, '110px', 'slot 2 pushes slot 1 up');
  assert.deepEqual(
    state.slots.map((s) => s.enter),
    [
      'slideIn 1.4s cubic-bezier(.25,.8,.3,1) both, shove .4s ease-in-out 0.4s 5',
      'climb 1.6s cubic-bezier(.4,.1,.4,1) both, shove .4s ease-in-out 0.5s 5',
      'squeeze 2.6s ease-in-out both',
    ],
  );
  assert.deepEqual(
    state.slots.map((s) => s.z),
    [3, 1, 2],
    'z-order: #0 in front, #2 middle, #1 behind',
  );

  // …and back down: the 110px and the shoves go with the third mascot.
  model.setCount(2);
  state = model.snapshot();
  assert.deepEqual(poseOf(state, 0), POSE_1);
  assert.deepEqual(poseOf(state, 1), POSE_2);
});

test('an idle mascot bobs, with the pose\'s own arm and a normal face', () => {
  const { model } = makeModel();
  model.setCount(3);
  const state = model.snapshot();
  assert.deepEqual(
    state.slots.map((s) => [s.armVariant, s.face]),
    [
      ['down', 'strain'],
      ['up', 'normal'],
      ['down', 'normal'],
    ],
    'slot 0 is straining right after the count reached 3',
  );
  assert.deepEqual(
    state.slots.map((s) => s.anim),
    [STRAIN_ANIM, BOB_ANIM, BOB_ANIM],
  );
});

// ---------------------------------------------------------------------------
// Click reactions
// ---------------------------------------------------------------------------

test('a click laughs for 1400 ms, then the slot is idle again', () => {
  const { model, clock } = makeModel(draws(0)); // 0 -> REACTION_KEYS[0] = laugh
  model.setCount(1);

  model.poke(0);
  let slot = model.snapshot().slots[0]!;
  assert.equal(slot.anim, 'laugh 1.4s ease-in-out 1');
  assert.equal(slot.face, 'happy');
  assert.equal(slot.armVariant, 'down', 'a laugh does not move the arm');
  assert.deepEqual(clock.pendingDelays(), [1400]);

  clock.advance(1399);
  assert.equal(model.snapshot().slots[0]!.anim, 'laugh 1.4s ease-in-out 1', 'still laughing at 1399');

  clock.advance(1);
  slot = model.snapshot().slots[0]!;
  assert.equal(slot.anim, BOB_ANIM);
  assert.equal(slot.face, 'normal');
  assert.equal(clock.pending, 0, 'the reaction timer does not re-arm itself');
});

test('a click can wave instead: 1300 ms, waving arm, normal face', () => {
  const { model, clock } = makeModel(draws(0.99)); // floor(0.99 * 2) = 1 -> wave
  model.setCount(1);

  model.poke(0);
  const slot = model.snapshot().slots[0]!;
  assert.equal(slot.anim, 'waveBody 1.3s ease-in-out 1');
  assert.equal(slot.armVariant, 'waving');
  assert.equal(slot.face, 'normal', 'the handoff gives the wave a normal face');
  assert.deepEqual(clock.pendingDelays(), [1300]);

  clock.advance(1299);
  assert.equal(model.snapshot().slots[0]!.armVariant, 'waving', 'a wave ends at 1300, not before');

  clock.advance(1);
  assert.equal(model.snapshot().slots[0]!.armVariant, 'down');
  assert.equal(model.snapshot().slots[0]!.anim, BOB_ANIM);
  assert.equal(clock.pending, 0);
});

test('the draw picks each reaction: the seam decides, nothing else', () => {
  // 0.0 and 0.49 are the laugh half, 0.5 and 0.999 the wave half.
  const picks: string[] = [];
  for (const value of [0, 0.49, 0.5, 0.999]) {
    const { model } = makeModel(draws(value));
    model.setCount(1);
    model.poke(0);
    picks.push(model.snapshot().slots[0]!.anim);
  }
  assert.deepEqual(picks, [
    'laugh 1.4s ease-in-out 1',
    'laugh 1.4s ease-in-out 1',
    'waveBody 1.3s ease-in-out 1',
    'waveBody 1.3s ease-in-out 1',
  ]);
});

test('a second click while a slot is reacting is ignored', () => {
  const { model, clock, changes } = makeModel(draws(0, 0.99));
  model.setCount(1);
  model.poke(0); // laugh
  const after = changes.length;

  clock.advance(700);
  model.poke(0);
  assert.equal(changes.length, after, 'no state change: the click never landed');
  assert.equal(model.snapshot().slots[0]!.anim, 'laugh 1.4s ease-in-out 1', 'still the first laugh');
  assert.deepEqual(clock.pendingDelays(), [1400], 'and no second timer was armed');

  // Once it is idle again the next click is taken, and takes the next draw.
  clock.advance(700);
  model.poke(0);
  assert.equal(model.snapshot().slots[0]!.anim, 'waveBody 1.3s ease-in-out 1');
});

test('poke ignores a slot that is not on screen', () => {
  const { model, clock, changes } = makeModel();
  model.setCount(1);
  const after = changes.length;
  for (const slot of [1, 2, 3, -1, 0.5, NaN]) model.poke(slot);
  assert.equal(changes.length, after);
  assert.equal(clock.pending, 0);
  assert.equal(model.snapshot().slots[0]!.anim, BOB_ANIM);
});

test('two mascots react independently', () => {
  const { model, clock } = makeModel(draws(0, 0.99));
  model.setCount(2);
  model.poke(0); // laugh, 1400
  model.poke(1); // wave, 1300
  assert.deepEqual(
    model.snapshot().slots.map((s) => s.anim),
    ['laugh 1.4s ease-in-out 1', 'waveBody 1.3s ease-in-out 1'],
  );
  clock.advance(1300);
  assert.deepEqual(
    model.snapshot().slots.map((s) => s.anim),
    ['laugh 1.4s ease-in-out 1', BOB_ANIM],
  );
  clock.advance(100);
  assert.deepEqual(
    model.snapshot().slots.map((s) => s.anim),
    [BOB_ANIM, BOB_ANIM],
  );
});

// ---------------------------------------------------------------------------
// Straining (handoff: "Count goes to 3")
// ---------------------------------------------------------------------------

test('the count reaching 3 strains slot 0 for 3400 ms', () => {
  const { model, clock } = makeModel();
  model.setCount(2);
  assert.equal(clock.pending, 0, 'nothing strains below 3');

  model.setCount(3);
  assert.deepEqual(clock.pendingDelays(), [3400]);
  let state = model.snapshot();
  assert.equal(state.slots[0]!.anim, STRAIN_ANIM);
  assert.equal(state.slots[0]!.face, 'strain');
  assert.deepEqual(
    state.slots.slice(1).map((s) => [s.anim, s.face]),
    [
      [BOB_ANIM, 'normal'],
      [BOB_ANIM, 'normal'],
    ],
    'only slot 0 strains',
  );

  clock.advance(3399);
  assert.equal(model.snapshot().slots[0]!.face, 'strain', 'still straining at 3399');

  clock.advance(1);
  state = model.snapshot();
  assert.equal(state.slots[0]!.anim, BOB_ANIM);
  assert.equal(state.slots[0]!.face, 'normal');
  assert.equal(clock.pending, 0);
});

test('a jump straight from 0 to 3 strains too', () => {
  const { model, clock } = makeModel();
  model.setCount(3);
  assert.deepEqual(clock.pendingDelays(), [3400]);
  assert.equal(model.snapshot().slots[0]!.face, 'strain');
});

test('staying at 3 does not re-arm the strain', () => {
  const { model, clock } = makeModel();
  model.setCount(3);
  clock.advance(1000);
  model.setCount(3); // no-op
  model.setCount(5); // clamps to 3: also a no-op
  assert.deepEqual(clock.pendingDelays(), [3400], 'the one timer from the first transition');
  clock.advance(2400);
  assert.equal(model.snapshot().slots[0]!.face, 'normal', 'cleared 3400 ms after the transition');
});

test('dropping to 2 does not cancel the strain: it runs out on its own', () => {
  // Prototype behaviour (Claude Peek Mascot.dc.html: `remove()` touches only
  // the count) — slot 0 keeps straining under a weight that already left.
  const { model, clock } = makeModel();
  model.setCount(3);
  clock.advance(1000);

  model.setCount(2);
  assert.equal(model.snapshot().slots[0]!.face, 'strain', 'still strained at 2');
  assert.deepEqual(clock.pendingDelays(), [3400]);

  clock.advance(2400);
  assert.equal(model.snapshot().slots[0]!.face, 'normal');
  assert.equal(clock.pending, 0);
});

test('going back up to 3 restarts the strain and keeps one timer', () => {
  const { model, clock } = makeModel();
  model.setCount(3);
  clock.advance(3400);
  assert.equal(model.snapshot().slots[0]!.face, 'normal');

  model.setCount(1);
  model.setCount(3);
  assert.deepEqual(clock.pendingDelays(), [3400]);
  assert.equal(model.snapshot().slots[0]!.face, 'strain');
});

test('a reaction beats the strain, and the strain shows again after it', () => {
  const { model, clock } = makeModel(draws(0)); // laugh
  model.setCount(3);
  model.poke(0);
  let slot = model.snapshot().slots[0]!;
  assert.equal(slot.anim, 'laugh 1.4s ease-in-out 1');
  assert.equal(slot.face, 'happy', 'a laughing mascot is not drawn straining');

  clock.advance(1400);
  slot = model.snapshot().slots[0]!;
  assert.equal(slot.anim, STRAIN_ANIM, 'the strain has 2000 ms left and takes the layer back');
  assert.equal(slot.face, 'strain');
});

// ---------------------------------------------------------------------------
// Count decrease
// ---------------------------------------------------------------------------

test('a mascot that leaves takes its mood and its timer with it', () => {
  const { model, clock, changes } = makeModel(draws(0.99)); // wave
  model.setCount(3);
  model.poke(2);
  assert.equal(model.snapshot().slots[2]!.armVariant, 'waving');
  assert.deepEqual(clock.pendingDelays(), [1300, 3400], 'wave at 1300, strain at 3400');

  model.setCount(2);
  assert.deepEqual(clock.pendingDelays(), [3400], 'the wave timer went with slot 2');

  // The stale timer can never fire: slot 2 comes back idle, not mid-wave.
  const before = changes.length;
  clock.advance(1300);
  assert.equal(changes.length, before, 'nothing changed when the wave would have ended');
  model.setCount(3);
  assert.equal(model.snapshot().slots[2]!.armVariant, 'down');
  assert.equal(model.snapshot().slots[2]!.anim, BOB_ANIM);
});

test('dropping to 0 clears every mood timer', () => {
  const { model, clock } = makeModel(draws(0));
  model.setCount(3);
  model.poke(0);
  model.poke(1);
  model.poke(2);
  assert.deepEqual(clock.pendingDelays(), [1400, 1400, 1400, 3400]);

  model.setCount(0);
  assert.deepEqual(clock.pendingDelays(), [3400], 'only the strain, which is not a slot timer');
  assert.deepEqual(model.snapshot(), { count: 0, slots: [] });

  clock.advance(3400);
  assert.equal(clock.pending, 0);
  model.setCount(3);
  assert.deepEqual(
    model.snapshot().slots.map((s) => s.anim),
    [STRAIN_ANIM, BOB_ANIM, BOB_ANIM],
  );
});

test('a slot that stays keeps reacting across a count change', () => {
  const { model, clock } = makeModel(draws(0)); // laugh
  model.setCount(2);
  model.poke(0);
  model.setCount(1);
  assert.equal(model.snapshot().slots[0]!.anim, 'laugh 1.4s ease-in-out 1', 'slot 0 never left');
  clock.advance(1400);
  assert.equal(model.snapshot().slots[0]!.anim, BOB_ANIM);
});

// ---------------------------------------------------------------------------
// onChange
// ---------------------------------------------------------------------------

test('onChange fires on every state change and never on a no-op', () => {
  const { model, clock, changes } = makeModel(draws(0));

  model.setCount(1);
  assert.equal(changes.length, 1);
  assert.deepEqual(changes[0]!.count, 1);

  model.setCount(1);
  model.setCount(1.4); // clamps to 1
  assert.equal(changes.length, 1, 'the same count is not a change');

  model.poke(0);
  assert.equal(changes.length, 2, 'the reaction starts');
  clock.advance(1400);
  assert.equal(changes.length, 3, 'and ends');

  model.setCount(3);
  assert.equal(changes.length, 4);
  clock.advance(3400);
  assert.equal(changes.length, 5, 'the strain ending is a change of its own');

  model.setCount(0);
  assert.equal(changes.length, 6);
  model.setCount(-2);
  assert.equal(changes.length, 6, '0 -> 0 is nothing');
});

test('onChange hands over a snapshot of THAT moment, not a live view', () => {
  const { model, changes } = makeModel();
  model.setCount(2);
  model.setCount(1);
  assert.equal(changes.length, 2);
  assert.equal(changes[0]!.slots.length, 2, 'the first snapshot still shows two');
  assert.equal(changes[1]!.slots.length, 1);
  assert.notEqual(changes[0], changes[1]);
});

test('a model without an onChange still runs', () => {
  const clock = new Clock();
  const model = new MascotModel({ setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout });
  model.setCount(3);
  model.poke(0);
  clock.advance(3400);
  assert.equal(model.getCount(), 3);
  assert.equal(clock.pending, 0);
});

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

test('destroy clears every timer and the model goes quiet', () => {
  const { model, clock, changes } = makeModel(draws(0));
  model.setCount(3);
  model.poke(0);
  model.poke(1);
  model.poke(2);
  assert.equal(clock.pending, 4, '3 reactions + the strain');

  model.destroy();
  assert.equal(clock.pending, 0, 'handoff: "Clear all timeouts on unmount"');

  const after = changes.length;
  model.setCount(1);
  model.poke(0);
  clock.advance(10_000);
  assert.equal(changes.length, after, 'a destroyed model emits nothing');
  assert.equal(model.getCount(), 3, 'and changes nothing');
  assert.equal(clock.pending, 0);
});

test('destroy is idempotent', () => {
  const { model, clock } = makeModel();
  model.setCount(3);
  model.destroy();
  model.destroy();
  assert.equal(clock.pending, 0);
});
