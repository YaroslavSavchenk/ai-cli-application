/**
 * `web/src/ui/statusline.ts` — the bar redraws only when what it says changed
 * (Quality Q12, `.claude/plans/PLAN-QUALITY.md`). Every notify of any kind
 * used to rebuild every segment and a new `Keyboard shortcuts` button with a
 * new listener: the 3 s session poll, the 5 s latency pong.
 *
 * How: the real module on the DOM double, against the real state store;
 * `replaceChildren` on the bar's container is counted, and the button node's
 * identity says whether it was rebuilt.
 *
 * Why it matters: a rebuild under the keyboard hands focus to a fresh button
 * every few seconds, and the counts must still move the moment they change.
 *
 * NOT claimed: how the bar looks (browser; `web/DESIGN.md`).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, installDom, type FakeElement } from '../helpers/fake-dom.ts';
import { mkRuntime } from '../helpers/helpers.ts';
import { sessionInfo } from '../helpers/session-info.ts';

const dom = installDom();
const st = await import('../../web/src/state.ts');
const bar = await import('../../web/src/ui/statusline.ts');

const root = dom.doc.createElement('div') as unknown as FakeElement;
let replaces = 0;
const replace = root.replaceChildren.bind(root);
root.replaceChildren = (...nodes: Parameters<FakeElement['replaceChildren']>): void => {
  replaces += 1;
  replace(...nodes);
};
bar.initStatusline(root as unknown as HTMLElement, { openShortcuts: () => {} });

const hint = (): FakeElement => {
  const [b] = byClass(root, 'status-hint');
  assert.ok(b !== undefined, 'the Keyboard shortcuts button is drawn');
  return b;
};
const segs = (): string[] => byClass(root, 'status-seg').map((n) => n.textContent);

beforeEach(() => {
  st.setSessions([sessionInfo({ id: 's1' }), sessionInfo({ id: 's2' })]);
  st.setWsLatency(12);
  bar.render();
  replaces = 0;
});

test('a render with nothing new keeps every node, the button and its listener included', () => {
  const before = hint();
  for (let i = 0; i < 5; i++) bar.render();
  assert.equal(replaces, 0, 'no redraw');
  assert.equal(hint(), before, 'the same button node');
});

test('each thing the bar says redraws it the moment it changes', () => {
  const cases: [string, () => void, string][] = [
    ['the latency', () => st.setWsLatency(40), 'Latency 40 ms'],
    ['the session count', () => st.markExited('s2', 0), '1 session'],
    ['the uptime', () => st.setRuntime(mkRuntime(new Date().toISOString())), 'Up 0m'],
  ];
  for (const [what, change, text] of cases) {
    replaces = 0;
    change();
    bar.render();
    assert.equal(replaces, 1, `${what}: one redraw`);
    assert.ok(segs().some((s) => s.startsWith(text)), `${what}: ${segs().join(' / ')}`);
  }
  replaces = 0;
  st.setAttention('s1', true);
  bar.render();
  assert.equal(replaces, 1, 'a BEL: one redraw');
  assert.deepEqual(byClass(root, 'status-attn').map((n) => n.textContent), ['1 waiting for you']);
});

test('a flash redraws, and so does its end', () => {
  bar.flash('Could not end it');
  assert.equal(replaces, 1);
  assert.deepEqual(byClass(root, 'status-flash').map((n) => n.textContent), ['Could not end it']);
  const timer = dom.win.timers.at(-1);
  assert.ok(timer !== undefined, 'the flash armed its 3 s timer');
  timer.fn();
  assert.equal(replaces, 2, 'the flash leaving is a change too');
  assert.deepEqual(byClass(root, 'status-flash'), []);
});

test('a render with nothing new leaves the keyboard on the button', () => {
  const b = hint();
  b.focus();
  bar.render();
  assert.equal(dom.doc.activeElement, b, 'the same node still holds it');
});
