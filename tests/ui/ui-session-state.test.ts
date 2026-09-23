/**
 * `web/src/ui/session-state.ts` — the ONE readout of what a session is doing
 * (Nocturne B11, `.claude/plans/nocturne/PLAN-B11.md`). The pane dot + pill,
 * the drawer row and the tab dot all read it (the counts — `N waiting for
 * you`, the Sessions badge — are BEL-only and do not), so this file pins it
 * once:
 *
 *   1. THE ORDER — attn (BEL) > exited > waiting > working > running, over
 *      every combination of `status`, `attention` and `turn`.
 *   2. PULSE ONLY WHERE THE STATE IS KNOWN — no `turn` is `running` (still
 *      green), never `working` (pulsing).
 *   3. THE WORDS and THE CLASSES, one per readout.
 *   4. THE LOOK, by source (app.css): is-work pulses on --color-ok, is-wait is
 *      --color-attn with NO animation, and the work pulse stops under
 *      prefers-reduced-motion. That the pulse is visible is a browser check.
 *
 * DOM-free module, imported directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { SessionInfo, SessionTurn } from '../../shared/protocol.ts';
import {
  readoutClass,
  readoutWord,
  sessionReadout,
  type SessionReadout,
} from '../../web/src/ui/session-state.ts';
import { readSource, readSources } from '../helpers/helpers.ts';
import { readAppCss } from '../helpers/tokens-helpers.ts';

type S = Pick<SessionInfo, 'status' | 'attention' | 'turn'>;
const s = (status: SessionInfo['status'], attention: boolean, turn?: SessionTurn): S =>
  turn === undefined ? { status, attention } : { status, attention, turn };

test('the order over every combination: attn > exited > waiting > working > running', () => {
  const cases: [S, SessionReadout][] = [
    [s('running', false), 'running'],
    [s('running', false, 'working'), 'working'],
    [s('running', false, 'waiting'), 'waiting'],
    [s('running', true), 'attn'],
    [s('running', true, 'working'), 'attn'],
    [s('running', true, 'waiting'), 'attn'],
    [s('exited', false), 'exited'],
    [s('exited', false, 'working'), 'exited'],
    [s('exited', false, 'waiting'), 'exited'],
    // A BEL on a session that then exited still says what it asked.
    [s('exited', true), 'attn'],
    [s('exited', true, 'waiting'), 'attn'],
  ];
  for (const [input, want] of cases) {
    assert.equal(sessionReadout(input), want, JSON.stringify(input));
  }
});

test('no turn readout never pulses: an absent or unknown turn is still-green running', () => {
  assert.equal(sessionReadout(s('running', false)), 'running');
  // A value the protocol does not know (a newer server) is not a claim of work.
  assert.equal(sessionReadout({ status: 'running', attention: false, turn: 'thinking' as SessionTurn }), 'running');
  assert.equal(readoutClass('running'), 'is-run');
  assert.equal(readoutClass('working'), 'is-work');
});

test('one word per readout — Working twice, because running and working say the same to the user', () => {
  assert.equal(readoutWord('attn'), 'Needs your answer');
  assert.equal(readoutWord('waiting'), 'Waiting for you');
  assert.equal(readoutWord('working'), 'Working');
  assert.equal(readoutWord('running'), 'Working');
  assert.equal(readoutWord('exited'), 'Finished');
});

test('one class per readout, matching app.css', () => {
  const all: SessionReadout[] = ['attn', 'waiting', 'working', 'running', 'exited'];
  assert.deepEqual(all.map(readoutClass), ['is-attn', 'is-wait', 'is-work', 'is-run', 'is-exit']);
});

test('app.css: is-work pulses green, is-wait is still amber, reduced motion stops the work pulse', () => {
  const css = readAppCss();
  const rule = (sel: string): string => {
    const re = new RegExp(`(^|\\n)${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`);
    const m = re.exec(css);
    assert.ok(m !== null, `${sel} exists`);
    return m[2] as string;
  };
  const work = rule('.dot.is-work');
  assert.match(work, /background:\s*var\(--color-ok\)/);
  assert.match(work, /animation:\s*pulse var\(--t-pulse\) infinite/);
  const wait = rule('.dot.is-wait');
  assert.match(wait, /background:\s*var\(--color-attn\)/);
  assert.equal(/animation/.test(wait), false, 'waiting is STILL');
  assert.equal(/animation/.test(rule('.dot.is-run')), false, 'no turn readout is still');
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.dot\.is-work\s*\{\s*animation:\s*none;/,
  );
});

test('panes.ts: the pane dot AND the pill both take the one readout (class and word), by source', () => {
  // panes.ts imports xterm, so updateHeader cannot run under node --test; this
  // pins that the header derives dot class, pill class and pill word from
  // sessionReadout → readoutClass / readoutWord, not from a local ternary.
  const src = readSources('web/src/ui/panes.ts', 'web/src/ui/panes-status.ts');
  const start = src.indexOf('function updateHeader(');
  assert.ok(start !== -1, 'non-vacuity: updateHeader exists');
  const body = src.slice(start, src.indexOf('\nfunction ', start + 1));
  const readoutVar = /const (\w+)(?:: SessionReadout)? = [^;]*\bsessionReadout\(info\)/.exec(body)?.[1];
  assert.ok(readoutVar !== undefined, 'the readout comes from sessionReadout(info)');
  const clsVar = new RegExp(`const (\\w+) = readoutClass\\(${readoutVar}\\);`).exec(body)?.[1];
  assert.ok(clsVar !== undefined, 'the class comes from readoutClass(readout)');
  assert.match(body, new RegExp(`pay\\.dot\\.className = \`dot pane-dot \\$\\{${clsVar}\\}\`;`));
  assert.match(body, new RegExp(`pay\\.state\\.className = \`pane-state \\$\\{${clsVar}\\}\`;`));
  assert.match(body, new RegExp(`readoutWord\\(${readoutVar}\\)`));
  assert.equal(/'is-(run|attn|exit|work|wait)'/.test(body), false, 'no class literal of its own');
  assert.equal(/'(Working|Needs your answer|Finished|Waiting for you)'/.test(body), false, 'no state word of its own');
});

test('app.css: the pill and the drawer meta say waiting in amber, and the pill does not pulse', () => {
  const css = readAppCss();
  assert.match(css, /\.pane-state\.is-wait\s*\{[^}]*color:\s*var\(--color-attn\)/);
  assert.match(css, /\.sess-meta\.is-attn,\s*\.sess-meta\.is-wait\s*\{[^}]*color:\s*var\(--color-attn\)/);
  const pill = /\.pane-state\.is-wait\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
  assert.equal(/animation/.test(pill), false, 'waiting is STILL');
});
