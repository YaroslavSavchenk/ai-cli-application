/**
 * server/sessions-output.ts — scanOutput checked against two references over
 * generated PTY output (Nocturne C2, the fix after the DEV check,
 * .claude/plans/nocturne/PLAN-C2.md § Fix after the DEV check):
 *
 *   1. a reference parser of the WHOLE stream, written the other way round
 *      (find each OSC's end first, then judge its body with a regex): every
 *      chunk must report the bell and the last window title the whole stream
 *      puts inside it, wherever the stream was cut — so the scan never depends
 *      on where node-pty happened to split a read;
 *   2. the bell scanner it replaced, `scanForBell`, frozen below byte-exact
 *      from commit 1ca8809 (server/sessions-output.ts): on a whole sequence
 *      the bell is the same, and on a cut stream the ONLY differences are the
 *      two split-escape misreads the spec names — an `ESC ]` and an `ESC \`
 *      whose ESC ended a chunk.
 *
 * How: the pure function on strings made of escape fragments, title pieces
 * and whole titles, cut at random places — a seeded generator, so a failure
 * names a case that reproduces. Every step also checks that the scan state
 * keeps no title text (a length, a flag, and an OSC number of at most three
 * digits).
 *
 * Why it matters: the bell raises `attention` on every attached browser and
 * the idle title turns a running turn into "Waiting for you" plus a mascot.
 * The hand-written cases in `tests/server/sessions-output-scan.test.ts` pin
 * each rule; this file is the net under all of them together, across chunks.
 *
 * NOT claimed here: the reference is this file's reading of the spec, not a
 * terminal's — xterm.js ends an OSC at ANY ESC, CAN or SUB and knows the
 * 8-bit C1 forms (U+009C ST, U+009D OSC); neither scanner does, and the
 * generator emits no C1 character. SessionManager's stamp is
 * `tests/server/sessions-title.test.ts`; a real PTY's bell,
 * `tests/server/sessions.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newOutputScan, scanOutput, type OutputScan, type OutputScanState } from '../../server/sessions-output.ts';

const ESC = '\x1b';
const BEL = '\x07';

/**
 * The bell scanner before the C2 fix, byte-exact from commit 1ca8809
 * (`git show 1ca8809:server/sessions-output.ts`). Frozen here as the parity
 * reference; it is not the app's code any more.
 */
function scanForBell(data: string, session: { inOsc: boolean }): boolean {
  let bell = false;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (session.inOsc) {
      if (c === 0x07) session.inOsc = false;
      else if (c === 0x1b && data.charCodeAt(i + 1) === 0x5c) {
        session.inOsc = false;
        i++;
      }
    } else if (c === 0x1b && data.charCodeAt(i + 1) === 0x5d) {
      session.inOsc = true;
      i++;
    } else if (c === 0x07) {
      bell = true;
    }
  }
  return bell;
}

/** A title at exactly the scan's cap (256 characters) that reads idle. */
const AT_CAP = `✳ ${'x'.repeat(254)}`;

/**
 * What the generator glues together: lone escape bytes, OSC openers (titles
 * and not), terminators, title pieces with and without the idle mark,
 * characters that discard a title, a CSI, filler long enough to cross the cap,
 * and whole titles so idle ones are common.
 */
const PIECES = [
  ESC,
  ']',
  '\\',
  BEL,
  BEL,
  '0',
  '2',
  '1',
  ';',
  '0;',
  '✳',
  '✳',
  ' ',
  'a',
  '\t',
  '\x7f',
  `${ESC}]0;`,
  `${ESC}]0;`,
  `${ESC}]2;`,
  `${ESC}]1;`,
  `${ESC}]133;A`,
  `${ESC}]8;;`,
  `${ESC}\\`,
  `${ESC}[1m`,
  '✳ ',
  '✳ ',
  '◐ ',
  'Claude Code',
  'x'.repeat(120),
  AT_CAP,
  `${ESC}]0;✳ Claude Code${BEL}`,
  `${ESC}]0;✳ Claude Code${ESC}\\`,
  `${ESC}]2;✳${BEL}`,
  `${ESC}]0;◐ Claude Code${BEL}`,
];

/** Strings to generate, and random cuts per string. */
const CASES = 6_000;
const CUTS_PER_CASE = 4;
/** The most chunks one cut makes (up to CUTS - 1 cut points, duplicates merge). */
const MAX_CUTS = 5;

/** mulberry32: a small seeded PRNG, so every generated case reproduces. */
function seeded(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Case {
  stream: string;
  /** Chunk boundaries, 0 first and stream.length last. */
  bounds: number[];
  chunks: string[];
}

/** Every generated stream with CUTS_PER_CASE random cuts each, from one fixed seed. */
function generate(seed: number): Case[] {
  const rnd = seeded(seed);
  const out: Case[] = [];
  for (let k = 0; k < CASES; k++) {
    const pieces = 1 + Math.floor(rnd() * 12);
    let stream = '';
    for (let p = 0; p < pieces; p++) stream += PIECES[Math.floor(rnd() * PIECES.length)];
    for (let c = 0; c < CUTS_PER_CASE; c++) {
      const cuts = new Set<number>();
      const n = Math.floor(rnd() * MAX_CUTS);
      for (let i = 0; i < n && stream.length > 1; i++) cuts.add(1 + Math.floor(rnd() * (stream.length - 1)));
      const bounds = [0, ...[...cuts].sort((x, y) => x - y), stream.length];
      out.push({ stream, bounds, chunks: bounds.slice(1).map((end, i) => stream.slice(bounds[i], end)) });
    }
  }
  return out;
}

const GENERATED = generate(0xc2c2);

type Event = { at: number; bell: true } | { at: number; bell: false; idle: boolean };

/**
 * The reference reading of a WHOLE stream: each real bell, and each OSC 0 /
 * OSC 2 title with where it ended (its BEL, or the `\` of its ST) and whether
 * it is Claude Code's idle mark. An OSC runs from `ESC ]` to its first BEL or
 * `ESC \`; its body is a title when it starts `0;` or `2;`; the title text is
 * discarded (not idle) when it holds a C0 control or DEL or is over 256 long.
 * An OSC left open at the end says nothing more.
 */
function reference(stream: string): Event[] {
  const events: Event[] = [];
  let i = 0;
  while (i < stream.length) {
    if (stream[i] === BEL) {
      events.push({ at: i, bell: true });
      i++;
      continue;
    }
    if (stream[i] === ESC && stream[i + 1] === ']') {
      const bodyStart = i + 2;
      let bodyEnd = -1;
      let endAt = -1;
      for (let j = bodyStart; j < stream.length; j++) {
        if (stream[j] === BEL) {
          [bodyEnd, endAt] = [j, j];
          break;
        }
        if (stream[j] === ESC && stream[j + 1] === '\\') {
          [bodyEnd, endAt] = [j, j + 1];
          break;
        }
      }
      if (bodyEnd === -1) return events;
      const body = stream.slice(bodyStart, bodyEnd);
      if (/^[02];/.test(body)) {
        const text = body.slice(2);
        const discarded = /[\x00-\x1f\x7f]/.test(text) || text.length > 256;
        events.push({ at: endAt, bell: false, idle: !discarded && (text === '✳' || text.startsWith('✳ ')) });
      }
      i = endAt + 1;
      continue;
    }
    i++;
  }
  return events;
}

/** What each chunk of `c` must report, from the reference reading of the whole stream. */
function expected(c: Case): OutputScan[] {
  const events = reference(c.stream);
  return c.chunks.map((_, k) => {
    const inside = events.filter((e) => e.at >= (c.bounds[k] as number) && e.at < (c.bounds[k + 1] as number));
    const titles = inside.filter((e): e is Extract<Event, { bell: false }> => !e.bell);
    return { bell: inside.some((e) => e.bell), titleIdle: titles.at(-1)?.idle };
  });
}

/** The scan state holds no title text: its only strings are the OSC kind and a number of at most three digits. */
function assertNoText(state: OutputScanState, what: string): void {
  assert.deepEqual(Object.keys(state).sort(), ['esc', 'inOsc', 'osc', 'oscNum', 'titleIdle', 'titleLen'], what);
  assert.ok(['num', 'title', 'dropped', 'skip'].includes(state.osc), `${what}: osc ${state.osc}`);
  assert.match(state.oscNum, /^\d{0,3}$/, `${what}: the OSC number kept`);
}

/** Old-scanner bells per chunk. */
function oldBells(chunks: string[]): boolean[] {
  const session = { inOsc: false };
  return chunks.map((ch) => scanForBell(ch, session));
}

/** New-scanner bells per chunk. */
function newBells(chunks: string[]): boolean[] {
  const state = newOutputScan();
  return chunks.map((ch) => scanOutput(ch, state).bell);
}

/** Whether a cut splits `ESC` from the `]` (open) or `\` (close) after it. */
function splits(chunks: string[]): { open: boolean; close: boolean } {
  let open = false;
  let close = false;
  for (let k = 0; k + 1 < chunks.length; k++) {
    if (!(chunks[k] as string).endsWith(ESC)) continue;
    if ((chunks[k + 1] as string).startsWith(']')) open = true;
    if ((chunks[k + 1] as string).startsWith('\\')) close = true;
  }
  return { open, close };
}

/**
 * The same stream with every run of ESC that ended a chunk moved to the start
 * of the next one: no escape pair is split any more, and no bell moves (an
 * ESC is never one). The old scanner read such a stream right.
 */
function rejoinEscapes(chunks: string[]): string[] {
  const out: string[] = [];
  let carry = '';
  for (let k = 0; k < chunks.length; k++) {
    const chunk = carry + (chunks[k] as string);
    const last = k === chunks.length - 1;
    const keep = last ? chunk : chunk.replace(/\x1b+$/, '');
    carry = chunk.slice(keep.length);
    out.push(keep);
  }
  return out;
}

test('scan model: generated output cut anywhere — every chunk reports the bell and the last title the WHOLE stream puts in it, and the state keeps no title text', () => {
  let titles = 0;
  let idle = 0;
  let bells = 0;
  let splitTitles = 0;
  for (const [n, c] of GENERATED.entries()) {
    const state = newOutputScan();
    const got = c.chunks.map((chunk, k) => {
      const r = scanOutput(chunk, state);
      assertNoText(state, `case ${n}, after chunk ${k}`);
      return r;
    });
    const want = expected(c);
    assert.deepEqual(got, want, `case ${n}: ${JSON.stringify(c.chunks)}`);
    for (const w of want) {
      if (w.bell) bells++;
      if (w.titleIdle !== undefined) titles++;
      if (w.titleIdle === true) idle++;
    }
    if (c.chunks.length > 1 && want.some((w) => w.titleIdle !== undefined)) splitTitles++;
  }
  // The generator must really reach the rules, or a green run proves nothing.
  const reach = { titles, idle, bells, splitTitles };
  for (const [what, count] of Object.entries(reach)) {
    assert.ok(count >= 500, `the generated cases hold at least 500 ${what}: ${JSON.stringify(reach)}`);
  }
});

test('bell parity: on a whole sequence, and on any cut that splits no `ESC ]` / `ESC \\`, the bell is exactly the old scanForBell\'s', () => {
  let unsplit = 0;
  for (const [n, c] of GENERATED.entries()) {
    assert.equal(scanOutput(c.stream, newOutputScan()).bell, scanForBell(c.stream, { inOsc: false }), `case ${n}: whole ${JSON.stringify(c.stream)}`);
    const { open, close } = splits(c.chunks);
    if (open || close) continue;
    unsplit++;
    assert.deepEqual(newBells(c.chunks), oldBells(c.chunks), `case ${n}: ${JSON.stringify(c.chunks)}`);
  }
  assert.ok(unsplit >= GENERATED.length / 2, `most cuts split no escape pair: ${unsplit} of ${GENERATED.length}`);
});

test('bell parity: the two split-escape misreads the spec names are the ONLY differences — rejoin each split ESC and the old scanner agrees everywhere', () => {
  const differed = { open: 0, close: 0 };
  for (const [n, c] of GENERATED.entries()) {
    const now = newBells(c.chunks);
    assert.deepEqual(now, oldBells(rejoinEscapes(c.chunks)), `case ${n}: ${JSON.stringify(c.chunks)}`);
    const before = oldBells(c.chunks);
    if (JSON.stringify(before) === JSON.stringify(now)) continue;
    const { open, close } = splits(c.chunks);
    assert.ok(open || close, `case ${n}: a difference with no split escape: ${JSON.stringify(c.chunks)}`);
    if (open) differed.open++;
    if (close) differed.close++;
  }
  // Both fixes are exercised: `ESC | ]` (the title's BEL was a false bell) and
  // `ESC | \` (the next real BEL was swallowed).
  assert.ok(differed.open > 0 && differed.close > 0, `both split forms differ somewhere: ${JSON.stringify(differed)}`);
});
