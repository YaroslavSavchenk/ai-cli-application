/**
 * server/sessions-output.ts — scanOutput, the ONE pass over PTY output that
 * finds a REAL bell (not an OSC terminator) and, since the Nocturne C2 fix
 * after the DEV check (.claude/plans/nocturne/PLAN-C2.md § Fix after the DEV
 * check), whether the last window title a chunk completed (OSC 0 / OSC 2) is
 * Claude Code's idle mark: `✳` alone or `✳ ` then anything. BEL and ST
 * terminators, titles and escapes split across chunks, the 256-character cap
 * (past it: discarded, not cut — and read as NOT idle, like a title with a
 * control character or a stray ESC), a bell inside or after a title, and OSCs
 * that are no title (OSC 8 links, OSC 133 marks, OSC 1).
 *
 * How: the pure function on hand-built chunks — the cheapest seam that proves
 * a parser. The spinner glyph is `◐`, the one measured in a real Claude Code
 * PTY (2.1.283).
 *
 * Why it matters: the bell raises `attention` on every attached browser, and
 * the idle title turns a running turn into "Waiting for you" plus a mascot
 * after 3 s. A title read wrong either way is a false mascot or a missing one.
 *
 * The same rules checked together over generated, randomly cut output — and
 * the bell against the scanner this one replaced — are
 * `tests/server/sessions-output-scan-model.test.ts`.
 *
 * NOT claimed here: that SessionManager keeps the idle stamp right
 * (`tests/server/sessions-title.test.ts`); the verdict built on it
 * (`tests/server/agents-title.test.ts`); the bell reaching the wire from a real
 * PTY (`tests/server/sessions.test.ts`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newOutputScan, scanOutput, type OutputScan } from '../../server/sessions-output.ts';

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;
const IDLE = '✳ Claude Code';
const SPIN = '◐ Claude Code';

/** Scan `chunks` in order on one fresh state; every chunk's result. */
function scanAll(chunks: string[]): OutputScan[] {
  const state = newOutputScan();
  return chunks.map((c) => scanOutput(c, state));
}

/** One chunk on a fresh state. */
function scan1(chunk: string): OutputScan {
  return scanOutput(chunk, newOutputScan());
}

test('title scan: OSC 0 and OSC 2, BEL- or ST-terminated — idle is `✳` alone or `✳ ` then anything', () => {
  for (const [num, end] of [['0', BEL], ['2', BEL], ['0', ST], ['2', ST]] as const) {
    const what = `OSC ${num} ${end === BEL ? 'BEL' : 'ST'}`;
    assert.deepEqual(scan1(`${ESC}]${num};${IDLE}${end}`), { bell: false, titleIdle: true }, what);
    assert.deepEqual(scan1(`${ESC}]${num};${SPIN}${end}`), { bell: false, titleIdle: false }, what);
  }
  const cases: [string, boolean][] = [
    ['✳', true],
    ['✳ ', true],
    ['✳x', false],
    [' ✳ x', false],
    ['', false],
    ['you@host: ~/projects', false],
    ['◑ AskUserQuestion tool test', false],
  ];
  for (const [title, idle] of cases) {
    assert.equal(scan1(`${ESC}]0;${title}${BEL}`).titleIdle, idle, JSON.stringify(title));
  }
  assert.equal(scan1('plain output, no escape at all\r\n').titleIdle, undefined, 'no title: no fact');
});

test('title scan: the LAST title a chunk completes is the one that counts', () => {
  assert.equal(scan1(`${ESC}]0;${IDLE}${BEL}text${ESC}]0;${SPIN}${BEL}`).titleIdle, false);
  assert.equal(scan1(`${ESC}]0;${SPIN}${BEL}text${ESC}]0;${IDLE}${BEL}`).titleIdle, true);
  // An unfinished title does not stand in for the finished one before it.
  const [first, second] = scanAll([`${ESC}]0;${IDLE}${BEL}${ESC}]0;◐`, ` x${BEL}`]);
  assert.equal(first?.titleIdle, true);
  assert.equal(second?.titleIdle, false);
});

test('title scan: a title split across chunks at EVERY position is read whole, and only once it ends', () => {
  for (const end of [BEL, ST]) {
    for (const title of [IDLE, SPIN, '✳']) {
      const seq = `before${ESC}]0;${title}${end}after`;
      for (let cut = 1; cut < seq.length; cut++) {
        const results = scanAll([seq.slice(0, cut), seq.slice(cut)]);
        const facts = results.map((r) => r.titleIdle).filter((t) => t !== undefined);
        const what = `${JSON.stringify(title)} cut at ${cut} (${end === BEL ? 'BEL' : 'ST'})`;
        assert.deepEqual(facts, [title.startsWith('✳')], what);
        assert.equal(results.some((r) => r.bell), false, `${what}: no bell`);
      }
    }
  }
  // Three pieces, the ESC of `ESC ]` and of `ESC \` each alone at a chunk end.
  const pieces = scanAll([`x${ESC}`, `]0;${IDLE}${ESC}`, `\\y`]);
  assert.deepEqual(pieces.map((r) => r.titleIdle), [undefined, undefined, true]);
});

test('title scan: past 256 characters a title is DISCARDED — never cut into a false idle, it reads NOT idle — and its BEL is still no bell', () => {
  const at = (len: number): string => `✳ ${'x'.repeat(len - 2)}`;
  assert.equal(at(256).length, 256);
  assert.equal(scan1(`${ESC}]0;${at(256)}${BEL}`).titleIdle, true, '256 characters is still read');
  assert.deepEqual(scan1(`${ESC}]0;${at(257)}${BEL}`), { bell: false, titleIdle: false }, '257 is discarded: not idle');
  assert.deepEqual(scan1(`${ESC}]2;${at(400)}${ST}`), { bell: false, titleIdle: false }, 'OSC 2, ST');
  // Split across chunks the cap holds the same; the fact comes when the OSC ends.
  const long = `${ESC}]0;${at(300)}${BEL}`;
  assert.deepEqual(scanAll([long.slice(0, 150), long.slice(150)]).map((r) => r.titleIdle), [undefined, false]);
  // A title after the discarded one is read again.
  assert.equal(scan1(`${ESC}]0;${at(400)}${BEL}${ESC}]0;${IDLE}${BEL}`).titleIdle, true);
});

test('title scan: a BEL that ENDS a title is no bell; a BEL before or after one is', () => {
  assert.deepEqual(scan1(`${ESC}]0;${IDLE}${BEL}`), { bell: false, titleIdle: true });
  assert.deepEqual(scan1(`${ESC}]0;${IDLE}${BEL}${BEL}`), { bell: true, titleIdle: true });
  assert.deepEqual(scan1(`${BEL}${ESC}]0;${SPIN}${BEL}`), { bell: true, titleIdle: false });
  assert.deepEqual(scan1(`${ESC}]0;${IDLE}${ST}${BEL}`), { bell: true, titleIdle: true });
  // The bell after a title in the NEXT chunk.
  assert.deepEqual(scanAll([`${ESC}]0;${IDLE}${BEL}`, BEL]).map((r) => r.bell), [false, true]);
});

test('title scan: an OSC that is no title says nothing — OSC 8 links, OSC 133 marks, OSC 1, a number without `;`', () => {
  for (const seq of [
    `${ESC}]8;;https://example.com/✳ ${ST}✳ link${ESC}]8;;${ST}`,
    `${ESC}]133;A${BEL}`,
    `${ESC}]133;D;0${ST}`,
    `${ESC}]1;${IDLE}${BEL}`,
    `${ESC}]10;?${BEL}`,
    `${ESC}]02;${IDLE}${BEL}`,
    `${ESC}]0${BEL}`,
    `${ESC}];${IDLE}${BEL}`,
    `${ESC}]1000;${IDLE}${BEL}`,
  ]) {
    assert.deepEqual(scan1(seq), { bell: false, titleIdle: undefined }, JSON.stringify(seq));
  }
});

test('title scan: the OSC number comes FIRST — a space, a letter or a `;` before it makes the OSC no title, whatever `0;` follows', () => {
  for (const lead of [' ', 'x', ';', '1;', '?']) {
    const seq = `${ESC}]${lead}0;${IDLE}${BEL}`;
    assert.deepEqual(scan1(seq), { bell: false, titleIdle: undefined }, JSON.stringify(seq));
  }
});

test('title scan: a control character or a stray ESC inside a title discards it — it reads NOT idle; the OSC still ends where it ends', () => {
  assert.deepEqual(scan1(`${ESC}]0;✳ a\tb${BEL}`), { bell: false, titleIdle: false }, 'a tab');
  assert.deepEqual(scan1(`${ESC}]0;✳ a\x7fb${BEL}`), { bell: false, titleIdle: false }, 'a DEL');
  // ESC not followed by `\` is no terminator: the OSC runs on to the BEL, which is not a bell.
  assert.deepEqual(scan1(`${ESC}]0;✳ a${ESC}[1mb${BEL}`), { bell: false, titleIdle: false });
  // The same with the ESC alone at a chunk end.
  assert.deepEqual(
    scanAll([`${ESC}]0;✳ a${ESC}`, `[1mb${BEL}${BEL}`]).map((r) => [r.bell, r.titleIdle]),
    [[false, undefined], [true, false]],
  );
  // A discarded title AFTER an idle one in the same chunk is the last word: not idle.
  assert.equal(scan1(`${ESC}]0;${IDLE}${BEL}${ESC}]0;✳ a\tb${BEL}`).titleIdle, false);
  // A stray ESC inside an OSC that is no title keeps it no title.
  assert.deepEqual(scan1(`${ESC}]133;A${ESC}[1m${BEL}`), { bell: false, titleIdle: undefined }, 'OSC 133');
  // …and inside the OSC number: what follows it (`;✳ x`) is no title either.
  assert.deepEqual(scan1(`${ESC}]0${ESC};✳ x${BEL}`), { bell: false, titleIdle: undefined }, 'ESC inside the number');
});

test('title scan: the control-character edges — NUL and 0x1f discard a title, space and `~` do not, DEL does', () => {
  for (const [ch, idle] of [['\x00', false], ['\x1f', false], ['\x01', false], [' ', true], ['~', true], ['\x7f', false]] as const) {
    const what = `U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
    assert.deepEqual(scan1(`${ESC}]0;✳ a${ch}b${BEL}`), { bell: false, titleIdle: idle }, what);
    // As the title's second character, where the idle form wants its space.
    assert.equal(scan1(`${ESC}]0;✳${ch}b${BEL}`).titleIdle, ch === ' ', `${what} second`);
  }
});

test('title scan: an OSC that is no title AFTER a title in the same chunk leaves that title the last word', () => {
  for (const other of [`${ESC}]1;◐ icon${BEL}`, `${ESC}]133;A${BEL}`, `${ESC}]8;;https://example.com/${ST}`, `${ESC}]10;?${ST}`]) {
    assert.deepEqual(scan1(`${ESC}]0;${IDLE}${BEL}${other}`), { bell: false, titleIdle: true }, `idle, then ${JSON.stringify(other)}`);
    assert.deepEqual(scan1(`${ESC}]0;${SPIN}${ST}${other}`), { bell: false, titleIdle: false }, `spinner, then ${JSON.stringify(other)}`);
  }
  // The other OSC's end alone in the next chunk says nothing about the title.
  assert.deepEqual(scanAll([`${ESC}]0;${IDLE}${BEL}${ESC}]1;x`, BEL]).map((r) => r.titleIdle), [true, undefined]);
});

test('title scan: an EMPTY title (`ESC ] 0 ;` then the end at once) is a title, and reads NOT idle — OSC 0 or 2, BEL or ST, whole or split', () => {
  for (const seq of [`${ESC}]0;${BEL}`, `${ESC}]2;${BEL}`, `${ESC}]0;${ST}`, `${ESC}]2;${ST}`]) {
    assert.deepEqual(scan1(seq), { bell: false, titleIdle: false }, JSON.stringify(seq));
    for (let cut = 1; cut < seq.length; cut++) {
      const facts = scanAll([seq.slice(0, cut), seq.slice(cut)]);
      assert.deepEqual(facts.map((r) => r.titleIdle), [undefined, false], `${JSON.stringify(seq)} cut at ${cut}`);
      assert.equal(facts.some((r) => r.bell), false, `${JSON.stringify(seq)} cut at ${cut}: no bell`);
    }
    // Right after an idle title — in the same chunk, and in the next — the empty one is the last word.
    assert.equal(scan1(`${ESC}]0;${IDLE}${BEL}${seq}`).titleIdle, false, `idle, then ${JSON.stringify(seq)}`);
    assert.deepEqual(scanAll([`${ESC}]0;${IDLE}${BEL}`, seq]).map((r) => r.titleIdle), [true, false], `idle | ${JSON.stringify(seq)}`);
  }
});

test('title scan: the scan state keeps no title text — a title cut mid-way leaves a length and a flag, a long OSC number at most three digits', () => {
  const state = newOutputScan();
  scanOutput(`${ESC}]0;✳ secret-topic`, state);
  assert.equal(JSON.stringify(state).includes('secret'), false, `no title text: ${JSON.stringify(state)}`);
  assert.equal(scanOutput(`${BEL}`, state).titleIdle, true, 'the title still ends idle');
  const digits = newOutputScan();
  const r = scanOutput(`${ESC}]${'0'.repeat(10_000)};✳ x`, digits);
  assert.ok(digits.oscNum.length <= 3, `the OSC number kept: ${digits.oscNum.length} digits`);
  assert.deepEqual([r, scanOutput(BEL, digits)], [{ bell: false, titleIdle: undefined }, { bell: false, titleIdle: undefined }], 'no title');
});

test('bell scan across chunks: `ESC ]` and `ESC \\` split in two still open and close the OSC', () => {
  // `ESC | ] 0;t BEL`: the BEL ends the OSC — no bell.
  assert.deepEqual(scanAll([`a${ESC}`, `]0;t${BEL}`]).map((r) => r.bell), [false, false]);
  // `… ESC | \ BEL`: the ST ends the OSC, so the BEL after it is real.
  assert.deepEqual(scanAll([`${ESC}]0;t${ESC}`, `\\${BEL}`]).map((r) => r.bell), [false, true]);
  // An ESC at a chunk end that turns out to be no `ESC ]`: a BEL after it is a bell.
  assert.deepEqual(scanAll([`a${ESC}`, `${BEL}`]).map((r) => r.bell), [false, true]);
  assert.deepEqual(scanAll([`a${ESC}`, `[31m${BEL}`]).map((r) => r.bell), [false, true]);
});

test('bell scan: unchanged for whole sequences — a bare BEL rings, an OSC terminator does not, other escapes are text', () => {
  assert.equal(scan1(`ding${BEL}`).bell, true);
  assert.equal(scan1(`${ESC}]0;you@host: ~${BEL}$ `).bell, false);
  assert.equal(scan1(`${ESC}]0;you@host: ~${BEL}$ ${BEL}`).bell, true);
  assert.equal(scan1(`${ESC}[31mred${ESC}[0m`).bell, false);
  // An OSC left open by one chunk swallows the next chunk's BEL as its terminator.
  assert.deepEqual(scanAll([`${ESC}]0;half`, `${BEL}`]).map((r) => r.bell), [false, false]);
});
