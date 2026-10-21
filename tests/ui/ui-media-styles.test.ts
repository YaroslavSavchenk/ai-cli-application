/**
 * The media viewer's stylesheet rules (Nocturne D7,
 * `.claude/plans/nocturne/PLAN-D7.md`): the `media viewer` section of app.css
 * (`web/src/styles/app-pane-kinds.css`) — Fit shrinks a picture or a video to
 * the pane and NEVER scales it up past its own pixels; 100 % lifts the limit
 * and lets the stage scroll.
 *
 * How: the stylesheet read as text (`tests/helpers/tokens-helpers.ts`), the
 * seam for a CSS rule — the DOM double has no layout. The rule bodies are
 * taken by their exact selector inside the one section that owns them.
 *
 * Why it matters: `width: 100%` instead of `max-width: 100%` still looks right
 * on every picture larger than the pane, and silently blows a 16 × 16 icon up
 * to a blurred wall — the reader then misjudges the file they are looking at.
 *
 * NOT claimed: the rendered result (the browser, `/verify-terminal`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mySections, stripComments } from '../helpers/tokens-helpers.ts';

const [section] = mySections(['media viewer']);
const css = stripComments(section!.body);

/** The declarations of the rule whose selector is exactly `sel`, as a map. */
function decls(sel: string): Map<string, string> {
  const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter((m) => m[1]!.trim() === sel);
  assert.equal(rules.length, 1, `exactly one \`${sel}\` rule in the media viewer section`);
  const out = new Map<string, string>();
  for (const d of rules[0]![2]!.split(';')) {
    const i = d.indexOf(':');
    if (i > 0) out.set(d.slice(0, i).trim(), d.slice(i + 1).trim().replace(/\s+/g, ' '));
  }
  return out;
}

test('Fit bounds a picture and a video by the pane and never sizes them up', () => {
  for (const sel of ['.pane-mimg', '.pane-mvideo']) {
    const d = decls(sel);
    assert.equal(d.get('max-width'), '100%', `${sel}: shrinks to the pane's width`);
    assert.equal(d.get('max-height'), '100%', `${sel}: shrinks to the pane's height`);
    for (const grow of ['width', 'height', 'min-width', 'min-height', 'flex-grow', 'transform', 'zoom']) {
      assert.equal(d.has(grow), false, `${sel}: no \`${grow}\` — that would scale a small one up`);
    }
    assert.equal(d.get('flex'), 'none', `${sel}: the flex stage never stretches it either`);
  }
  assert.equal(decls('.pane-mimg').get('object-fit'), 'contain', 'the aspect ratio is kept');
});

test('100 % lifts the bounds and lets the stage scroll; fitted, the stage never scrolls', () => {
  const actual = decls('.pane-mstage.is-actual .pane-mimg');
  assert.equal(actual.get('max-width'), 'none');
  assert.equal(actual.get('max-height'), 'none');
  assert.equal(decls('.pane-mstage').get('overflow'), 'hidden');
  assert.equal(decls('.pane-mstage.is-actual').get('overflow'), 'auto');
});
