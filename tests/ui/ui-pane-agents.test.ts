/**
 * `web/src/ui/pane-agents.ts` — the "Background agents" table as DOM, driven
 * against the fake document (part A3's renderer, made real by part B7;
 * `.claude/plans/nocturne/PLAN-B7.md`).
 *
 * `tests/ui/ui-pane-a3.test.ts` pins the table's structural rules from the
 * SOURCE, because until B7 there were no rows to render. There are now, so
 * this file plants them and reads the tree back — the browser check the spec
 * scopes to `/verify-terminal` covers pixels, this one covers structure:
 *
 *   1. AN EMPTY LIST IS NO TABLE AT ALL (`null`), not an empty one — the A3
 *      rule, here as behaviour rather than as a regex over the source.
 *   2. THE SHAPE: a header carrying the two A3 literals, then one `.pane-agent`
 *      per row in the order given, each with its dot, name, task, time and
 *      tokens, and nothing else.
 *   3. THE TEXT IS TEXT. Every string on a row crossed a file another process
 *      wrote (Claude Code's transcripts), so it must land as a text node —
 *      `el()` never parses markup — and it must land VERBATIM.
 *   4. THE DOT IS A CLASS, hidden from the accessibility tree: it repeats what
 *      the time column already says, and a screen reader reading "bullet" per
 *      row is noise.
 *   5. THE COUNT LINE (B11): `+N working` and `+N finished` as two separate
 *      words in one `.pane-agents-more` row under the rows; a 0 is not drawn,
 *      and with both 0 the row is not there at all.
 *
 * NOT claimed here: colour, size, legibility on a light custom ground — those
 * are `.claude/skills/verify-terminal/SKILL.md` and the B9 screenshot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { byClass, descendants, installDom, textsOf, type FakeElement } from '../helpers/fake-dom.ts';

installDom();

const { renderAgents } = (await import(
  new URL('../../web/src/ui/pane-agents.ts', import.meta.url).href
)) as typeof import('../../web/src/ui/pane-agents.ts');

type Row = Parameters<typeof renderAgents>[0]['rows'][number];

/** The renderer's input with no count line (B11: `agentTable`'s shape). */
const only = (rows: Row[]) => ({ rows, moreWorking: 0, moreFinished: 0 });

const ROWS: Row[] = [
  { name: 'backend-pty', task: 'Wire the agents watcher', time: '2m 10s', tokens: '12.4k', dot: 'running' },
  { name: 'terminal-ui', task: 'Feed the table', time: '42s', tokens: '999', dot: 'running' },
  { name: 'test-engineer', task: '', time: '1h 05m', tokens: '1.2M', dot: 'finished' },
];

/** The table for `rows`, asserted non-null (the renderer's own null case is its own test). */
function table(rows: Row[]): FakeElement {
  const t = renderAgents(only(rows)) as unknown as FakeElement | null;
  assert.notEqual(t, null, 'a non-empty list must render a table');
  return t as FakeElement;
}

test('an empty list renders NO table — the block is absent, not blank', () => {
  assert.equal(renderAgents(only([])), null);
});

test('the table is a header plus one row per agent, in the order given', () => {
  const t = table(ROWS);
  assert.equal(t.className, 'pane-agents');
  const head = byClass(t, 'pane-agents-hd');
  assert.equal(head.length, 1, 'exactly one header');
  assert.equal(head[0]?.textContent, 'Background agentsTokens', 'the A3 header literals');
  // B12: Claude Code's mark ONCE, in the header — every row is its subagent.
  const marks = descendants(t).filter((n) => n.getAttribute('data-tool') !== null);
  assert.deepEqual(marks.map((m) => m.getAttribute('data-tool')), ['claude'], 'one mark, never per row');
  assert.equal(marks[0]?.getAttribute('aria-hidden'), 'true');
  assert.ok(byClass(head[0] as FakeElement, 'pane-agents-tool').length === 1, 'and it sits in the header');
  const rows = byClass(t, 'pane-agent');
  assert.equal(rows.length, ROWS.length, 'one row per agent, none added or dropped');
  assert.deepEqual(textsOf(t, 'pane-agent-name'), ['backend-pty', 'terminal-ui', 'test-engineer']);
  assert.deepEqual(textsOf(t, 'pane-agent-time'), ['2m 10s', '42s', '1h 05m']);
  assert.deepEqual(textsOf(t, 'pane-agent-tokens'), ['12.4k', '999', '1.2M']);
  assert.deepEqual(textsOf(t, 'pane-agent-task'), ['Wire the agents watcher', 'Feed the table', '']);
});

test('one row carries exactly five cells: dot, name, task, time, tokens', () => {
  const row = byClass(table(ROWS), 'pane-agent')[0] as FakeElement;
  assert.deepEqual(
    row.children.map((c) => (c as FakeElement).className),
    ['pane-agent-dot is-running', 'pane-agent-name', 'pane-agent-task', 'pane-agent-time', 'pane-agent-tokens'],
  );
});

test('the dot is the state, and it is hidden from the accessibility tree', () => {
  const dots = byClass(table(ROWS), 'pane-agent-dot');
  assert.deepEqual(
    dots.map((d) => d.className),
    ['pane-agent-dot is-running', 'pane-agent-dot is-running', 'pane-agent-dot is-finished'],
  );
  for (const d of dots) {
    assert.equal(d.getAttribute('aria-hidden'), 'true', 'the time column already says it');
    assert.equal(d.textContent, '', 'a dot is a shape, not a character');
  }
});

test('a name and a task from a transcript land as TEXT, verbatim — never as markup', () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const t = table([{ name: nasty, task: `a & b <${nasty}>`, time: '0s', tokens: '0', dot: 'finished' }]);
  const name = byClass(t, 'pane-agent-name')[0] as FakeElement;
  const task = byClass(t, 'pane-agent-task')[0] as FakeElement;
  assert.equal(name.textContent, nasty, 'the name is the string itself');
  assert.equal(task.textContent, `a & b <${nasty}>`);
  // One TEXT node and no element: nothing was parsed into markup.
  assert.equal(name.children.length, 1);
  assert.equal((name.children[0] as FakeElement).tagName, undefined, 'a text node, not an element');
  assert.deepEqual(byClass(t, 'pane-agent-name').length, 1);
});

test('a single agent is a whole table — the first subagent makes it appear', () => {
  const t = table([ROWS[0] as Row]);
  assert.equal(byClass(t, 'pane-agent').length, 1);
  assert.equal(byClass(t, 'pane-agents-hd').length, 1);
});

// ---------------------------------------------------------------------------
// B11: the count line
// ---------------------------------------------------------------------------

test('both counts: one quiet line under the rows, two separate words, no separator', () => {
  const t = renderAgents({ rows: ROWS, moreWorking: 2, moreFinished: 10 }) as unknown as FakeElement;
  const more = byClass(t, 'pane-agents-more');
  assert.equal(more.length, 1, 'exactly one count line');
  assert.deepEqual(textsOf(t, 'pane-agents-more-n'), ['+2 working', '+10 finished']);
  assert.equal((more[0] as FakeElement).children.length, 2, 'two words, nothing between them');
  // Under the rows: the line is the box's last child.
  assert.equal(t.children[t.children.length - 1], more[0], 'the count line comes after every row');
});

test('a count of 0 is not drawn; both 0 means no count line at all', () => {
  const w = renderAgents({ rows: ROWS, moreWorking: 3, moreFinished: 0 }) as unknown as FakeElement;
  assert.deepEqual(textsOf(w, 'pane-agents-more-n'), ['+3 working']);
  const f = renderAgents({ rows: ROWS, moreWorking: 0, moreFinished: 11 }) as unknown as FakeElement;
  assert.deepEqual(textsOf(f, 'pane-agents-more-n'), ['+11 finished']);
  const none = table(ROWS);
  assert.equal(byClass(none, 'pane-agents-more').length, 0, 'no line for two zeros');
});
