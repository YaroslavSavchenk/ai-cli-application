/**
 * The output side of a session, as pure building blocks: the tail of the
 * scrollback ring an attach replays (PLAN-QUALITY P1), the scan for a REAL
 * bell (not an OSC terminator) and — Nocturne C2's DEV-check fix — for Claude
 * Code's idle window title, and, Nocturne D6, the early-exit verdict and the
 * first line it reads (`earlyExitLine`, `firstOutputLine`).
 *
 * Split from server/sessions.ts (PLAN-RESTRUCTURE O8, 2026-09-23), moved
 * byte-exact; its importers take it straight from here. Nocturne D9 P1
 * moved the ring buffer itself and the final-output rescue on to
 * server/pty-table.ts (the PTY layer a pty-host process will own). Sibling
 * pieces: server/sessions.ts (SessionManager: argv/env composition, the
 * session lifecycle), server/sessions-env.ts (the environment a PTY is spawned
 * with), server/pty-table.ts (spawn, ring, rescue, kill ladder).
 */
import { clean } from './sanitise.ts';
import type { RingBuffer } from './pty-table.ts';
import { EARLY_EXIT_LINE_MAX, EARLY_EXIT_MS } from '../shared/protocol.ts';

/**
 * The part of the ring an attach replays: its last `maxLines` lines, cut
 * right AFTER a `\n` (PLAN-QUALITY P1, 2026-09-23). The ring keeps 1 MiB, but
 * the browser terminal keeps only `SCROLLBACK_LINES` plus one screen
 * (`REPLAY_MAX_LINES`, shared/protocol.ts); everything older was parsed and
 * thrown away on every attach, tab switch and reload.
 *
 * Lines are counted as the terminal counts rows: `n` newlines make `n + 1`
 * lines, the last one being the (possibly empty) line the cursor is on. A
 * `\n`-line wider than the pane wraps into several rows, so this can only
 * send MORE rows than the terminal keeps, never fewer — except for scrolling
 * that comes without a `\n` (VT, FF, ESC D, CSI S), rare in CLI output.
 *
 * Why cut after a newline, and on bytes: 0x0A never occurs inside a UTF-8
 * multi-byte sequence nor inside the CSI/SGR sequences CLIs print, so the
 * replay starts on a clean line and a clean character. CRLF output keeps its
 * `\r` with the dropped line; the replay starts with the next line's text.
 *
 * Fallback when the ring holds `maxLines` lines or fewer — including a ring
 * with no newline at all (one 1 MiB line): the whole ring, exactly as before
 * P1, bounded by SCROLLBACK_MAX_BYTES. Anywhere else there is no safe cut: a
 * byte offset could land inside an escape sequence or a character.
 *
 * Known and accepted (P0): terminal modes set before the cut — alternate
 * screen, colours, cursor visibility, bracketed paste — are not replayed.
 * That was already true once the 1 MiB ring wrapped; the live stream and the
 * next repaint of a TUI restore them.
 */
export function replayTail(ring: RingBuffer, maxLines: number): Buffer {
  // Q12: walk the chunks backwards and copy only what is replayed — no copy
  // of the whole 1 MiB ring first on every attach, tab switch or reload. A
  // newline is one byte, so a chunk seam (even one inside a character, as a
  // restored mirror has) never hides one.
  if (maxLines <= 0) return Buffer.alloc(0);
  const taken: Buffer[] = [];
  let lines = 0;
  for (const chunk of ring.chunksNewestFirst()) {
    let pos = chunk.byteLength;
    while (pos > 0) {
      // `pos === 0` must not reach lastIndexOf: a negative offset counts from the END.
      const nl = chunk.lastIndexOf(0x0a, pos - 1);
      if (nl === -1) break;
      lines += 1;
      if (lines === maxLines) {
        taken.push(chunk.subarray(nl + 1));
        return Buffer.concat(taken.reverse());
      }
      pos = nl;
    }
    taken.push(chunk);
  }
  return ring.toBuffer();
}

/** How much of the ring's head an early exit reads for its first line (Nocturne D6). */
const EARLY_EXIT_HEAD_BYTES = 16 * 1024;

/**
 * Bidirectional formatting characters — LRM/RLM, ALM, the embeddings and
 * overrides U+202A–202E, the isolates U+2066–2069. `clean` keeps them (they
 * are not C0/C1), yet one of them in a line reorders what follows it on
 * screen and in a log viewer, so the text a user reads is not the text that
 * was printed (the "Trojan Source" trick). Untrusted program output never
 * carries them into a banner, a runtime field or server.log.
 */
const BIDI_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;

/**
 * Terminal escape sequences, whole: CSI (`ESC [` … final byte), OSC and the
 * other string controls DCS/SOS/PM/APC (`ESC ] P X ^ _` … BEL or ST, or
 * unterminated to the end), a charset designation (`ESC ( B`), and any other
 * two-byte `ESC x`.
 */
const ESCAPE_SEQUENCE =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b[\]PX^_][\s\S]*?(?:\u0007|\u001b\\|$)|\u001b[()*+][\s\S]?|\u001b[\s\S]?/g;

/**
 * The first non-empty line of program output, as plain text a log line and a
 * pane banner may carry (Nocturne D6, PLAN-D6.md § Defaults): escape sequences
 * removed, then every bidi control (BIDI_CONTROLS) and every remaining control
 * character (server/sanitise.ts `clean`) — a line ends at `\r` as well as
 * `\n`, as a terminal draws it — at most `max` characters, '' when there is no
 * such line. Also the raw-text path of the `claude --version` probe.
 */
export function firstOutputLine(output: string, max: number): string {
  const plain = output.replace(ESCAPE_SEQUENCE, '').replace(BIDI_CONTROLS, '');
  for (const line of plain.split(/\r\n|\r|\n/)) {
    const text = clean(line, max);
    if (text !== '') return text;
  }
  return '';
}

/**
 * Nocturne D6 (PLAN-D6.md § Defaults): did this claude-kind session die right
 * after it started? Yes when it exited NON-ZERO within EARLY_EXIT_MS of its
 * spawn (`createdAt`, ISO) — then what it said first, read from the ring's
 * HEAD only (at most EARLY_EXIT_HEAD_BYTES) as `firstOutputLine`, and how long
 * it ran. Undefined for any other exit. The caller decides claude-ness and
 * that the user did not end it (a kill is not a refusal).
 */
export function earlyExitLine(
  createdAt: string,
  now: number,
  exitCode: number,
  ring: RingBuffer,
): { line: string; ranMs: number } | undefined {
  if (exitCode === 0) return undefined;
  const ranMs = now - Date.parse(createdAt);
  if (!(ranMs < EARLY_EXIT_MS)) return undefined;
  const line = firstOutputLine(ring.head(EARLY_EXIT_HEAD_BYTES).toString('utf8'), EARLY_EXIT_LINE_MAX);
  return { line, ranMs };
}

/**
 * Longest window title the scan follows (C2 DEV-check fix). Claude Code's are
 * `<glyph> <short topic>`, well under this; a longer one is DISCARDED, never
 * cut short — a title we did not read whole is not one we vouch for as idle.
 * A discarded title still reads as NOT idle: it is a new title all the same,
 * so an old idle stamp must not outlive it (a false 'waiting' while Claude
 * works).
 */
const TITLE_MAX = 256;

/** U+2733 EIGHT SPOKED ASTERISK: Claude Code's title glyph while it is idle. */
const IDLE_GLYPH = 0x2733;

/**
 * What the output scan carries from one chunk to the next, per session.
 * Holds no title TEXT — only how far the current one got and whether it still
 * looks idle.
 */
export interface OutputScanState {
  /** Inside an OSC string (ESC ] … BEL or ESC \). */
  inOsc: boolean;
  /** The chunk ended on an ESC: what it starts depends on the next chunk's first character. */
  esc: boolean;
  /**
   * Where the current OSC stands as a window title: reading its number
   * (`num`), reading an OSC 0 / OSC 2 title (`title`), an OSC 0 / OSC 2 title
   * discarded — a control character, a stray ESC, past TITLE_MAX — that ends
   * as NOT idle (`dropped`), or any other OSC, skipped to its end (`skip`).
   */
  osc: 'num' | 'title' | 'dropped' | 'skip';
  /** The OSC number read so far (at most 3 digits). */
  oscNum: string;
  /** Title characters read so far. */
  titleLen: number;
  /**
   * Whether the title so far matches Claude Code's idle form: `✳` alone, or
   * `✳ ` and more. False until a first character, so an empty title is not idle.
   */
  titleIdle: boolean;
}

/** A scan state for a session that has printed nothing yet. */
export function newOutputScan(): OutputScanState {
  return { inOsc: false, esc: false, osc: 'skip', oscNum: '', titleLen: 0, titleIdle: false };
}

/** What one chunk said. */
export interface OutputScan {
  /** A REAL bell — not the 0x07 that terminates an OSC string. */
  bell: boolean;
  /**
   * The LAST window title (OSC 0 or OSC 2) the chunk completed, as one fact:
   * true = Claude Code's idle mark (`✳` alone, or `✳ ` then anything), false =
   * any other title, a discarded one included; undefined = the chunk
   * completed no title.
   */
  titleIdle: boolean | undefined;
}

/**
 * Scan one chunk of PTY output for a REAL bell and for window titles, in ONE
 * pass over one OSC state machine.
 *
 * THE BELL: shells repaint window titles ("\x1b]0;user@host: dir\x07") on
 * every prompt, so counting the 0x07 that ends an OSC would raise spurious
 * attention on background sessions after any repaint (e.g. a resize). An OSC
 * ends at BEL or ST (ESC backslash).
 *
 * THE TITLE (C2 DEV-check fix, PLAN-C2 § Fix after the DEV check): Claude Code
 * sets OSC 0 to `✳ <topic>` while idle and to a spinner glyph while it works;
 * with a question or permission prompt on screen it is idle while its
 * transcript still says the turn runs. The title is untrusted program output:
 * only the one boolean leaves here, and no text is kept, not even across
 * chunks — the state holds a length and a match flag.
 *
 * Across chunks: OSC state, the OSC number, the title's progress, and an ESC
 * that ended the previous chunk (so `ESC ]` and `ESC \` split in two are still
 * a start and an end) all carry over in `state`.
 */
export function scanOutput(data: string, state: OutputScanState): OutputScan {
  let bell = false;
  let titleIdle: boolean | undefined;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (state.esc) {
      // The previous chunk ended on an ESC; this character completes it.
      state.esc = false;
      if (state.inOsc ? c === 0x5c : c === 0x5d) {
        if (state.inOsc) titleIdle = endOsc(state) ?? titleIdle;
        else startOsc(state);
        continue;
      }
      if (state.inOsc) dropOsc(state); // An ESC inside a title: not one we read.
    }
    if (state.inOsc) {
      if (c === 0x07) {
        titleIdle = endOsc(state) ?? titleIdle;
      } else if (c === 0x1b) {
        if (i + 1 >= data.length) state.esc = true;
        else if (data.charCodeAt(i + 1) === 0x5c) {
          titleIdle = endOsc(state) ?? titleIdle;
          i++;
        } else {
          dropOsc(state);
        }
      } else {
        oscChar(state, c);
      }
    } else if (c === 0x1b) {
      if (i + 1 >= data.length) state.esc = true;
      else if (data.charCodeAt(i + 1) === 0x5d) {
        startOsc(state);
        i++;
      }
    } else if (c === 0x07) {
      bell = true;
    }
  }
  return { bell, titleIdle };
}

function startOsc(state: OutputScanState): void {
  state.inOsc = true;
  state.osc = 'num';
  state.oscNum = '';
  state.titleLen = 0;
  state.titleIdle = false;
}

/** One character inside an OSC string (not its terminator). */
function oscChar(state: OutputScanState, c: number): void {
  if (state.osc === 'num') {
    if (c >= 0x30 && c <= 0x39 && state.oscNum.length < 3) state.oscNum += String.fromCharCode(c);
    else if (c === 0x3b && (state.oscNum === '0' || state.oscNum === '2')) state.osc = 'title';
    else state.osc = 'skip';
    return;
  }
  if (state.osc !== 'title') return;
  if (c < 0x20 || c === 0x7f || ++state.titleLen > TITLE_MAX) {
    state.osc = 'dropped'; // A control character, or past the cap: discarded whole.
    return;
  }
  if (state.titleLen === 1) state.titleIdle = c === IDLE_GLYPH;
  else if (state.titleLen === 2) state.titleIdle = state.titleIdle && c === 0x20;
}

/** A stray ESC inside an OSC: a title becomes a discarded one, an OSC number becomes no title. */
function dropOsc(state: OutputScanState): void {
  if (state.osc === 'title') state.osc = 'dropped';
  else if (state.osc === 'num') state.osc = 'skip';
}

/** The OSC ended: the title it completed as idle / not idle (a discarded one: not idle), or undefined when it was no title. */
function endOsc(state: OutputScanState): boolean | undefined {
  state.inOsc = false;
  const osc = state.osc;
  state.osc = 'skip';
  if (osc === 'title') return state.titleIdle;
  return osc === 'dropped' ? false : undefined;
}
