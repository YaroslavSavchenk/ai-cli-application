/**
 * The peek-mascot overlay's stray-window fix in the Windows host
 * (`launcher/host/AiSessionManagerHost.cs`, Nocturne C1 fix after release,
 * `.claude/plans/nocturne/PLAN-C1.md` § Fix after release): under WebView2
 * visual hosting the browser process makes a top-level `Chrome_WidgetWin_1`
 * at the overlay's bounds, layered with alpha 0 but without
 * `WS_EX_TRANSPARENT`, so it swallows clicks (WebView2Feedback #5668). The
 * host ORs `WS_EX_TRANSPARENT` into exactly that window.
 *
 * How: a source read, the idiom of `tests/release/host-webmessage.test.ts` —
 * the C# host cannot run where `npm test` runs. Comments are stripped and
 * whitespace collapsed before anything is matched, so a comment can never
 * satisfy a pin.
 *
 * Why it matters: the MAIN app window's WebView2 lives in the SAME browser
 * process. A match rule loosened by one condition — any pid, a case-blind
 * class, one style bit, a near-enough rect — or a fix that does more than
 * that one bit (hide, move, another style) would reach into the main
 * window's windows, or into another app's, and nothing on screen would say
 * why.
 *
 * NOT claimed: that the compiled host finds and fixes the window at run time
 * — that was the scratch harness on Windows and is the live check in DEV
 * (the dev `host.log` says "made click-through" once).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSource } from '../helpers/helpers.ts';

const cs = readSource('launcher', 'host', 'AiSessionManagerHost.cs');

/** Comments out, whitespace collapsed: the code's shape. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The code of one `private static <type> Name(` member, up to the next member. */
function member(signature: string): string {
  const start = cs.indexOf(signature);
  assert.notEqual(start, -1, `${signature} not found in AiSessionManagerHost.cs`);
  const next = cs.indexOf('\n        private ', start + signature.length);
  return code(cs.slice(start, next === -1 ? cs.length : next));
}

const isStray = member('private static bool IsStrayInputWindow(');
const makeClickThrough = member('private static void MakeStrayInputWindowClickThrough(');

test('the stray-window constants are the exact Win32 values and class name', () => {
  for (const [what, re] of [
    ['the class', /private const string StrayInputWindowClass = "Chrome_WidgetWin_1";/],
    ['GWL_EXSTYLE', /private const int GwlExStyle = -20;/],
    ['WS_EX_TRANSPARENT', /private const long WsExTransparent = 0x00000020;/],
    ['WS_EX_LAYERED', /private const long WsExLayered = 0x00080000;/],
    ['WS_EX_NOACTIVATE', /private const long WsExNoActivate = 0x08000000;/],
  ] as const) {
    assert.match(cs, re, what);
  }
});

test('a window matches only in the overlay browser process, and pid 0 never matches', () => {
  assert.ok(
    isStray.includes('if (processId == 0 || processId != browserProcessId) { return false; }'),
    `the pid test is loosened or gone:\n${isStray}`,
  );
});

test('the class must match exactly, ordinal and case-sensitive', () => {
  assert.ok(
    isStray.includes(
      '|| !string.Equals(className.ToString(), StrayInputWindowClass, StringComparison.Ordinal)) { return false; }',
    ),
    `the class test is loosened or gone:\n${isStray}`,
  );
  assert.doesNotMatch(isStray, /IgnoreCase|ToLower|ToUpper|StartsWith|Contains\(/, 'no case-blind or partial class match');
});

test('a window matches only with BOTH layered and no-activate set', () => {
  assert.ok(
    isStray.includes('if ((exStyle & WsExLayered) == 0 || (exStyle & WsExNoActivate) == 0) { return false; }'),
    `the style test is loosened or gone:\n${isStray}`,
  );
});

test('a window matches only at the overlay bounds to the pixel', () => {
  assert.ok(
    isStray.endsWith(
      'return r.Left == bounds.Left && r.Top == bounds.Top && r.Right == bounds.Right && r.Bottom == bounds.Bottom; }',
    ),
    `the bounds test is loosened or gone:\n${isStray}`,
  );
  assert.doesNotMatch(isStray, /Math\.Abs|<=|>=|Contains|IntersectsWith/, 'no tolerance and no overlap test');
  // Four refusals and one final comparison: no early "yes".
  assert.equal(isStray.split('return false;').length - 1, 4, 'exactly four refusals');
  assert.doesNotMatch(isStray, /return true;/, 'no shortcut that accepts a window');
});

test('the fix sets WS_EX_TRANSPARENT and nothing else, on matched windows only', () => {
  // Matched first, then the one write.
  const gate = makeClickThrough.indexOf('if (!IsStrayInputWindow(hwnd, browserProcessId, bounds)) { continue; }');
  const write = makeClickThrough.indexOf('SetWindowLongPtr(hwnd, GwlExStyle, new IntPtr(exStyle | WsExTransparent))');
  assert.notEqual(gate, -1, `the match gate is gone:\n${makeClickThrough}`);
  assert.notEqual(write, -1, `the one style write changed:\n${makeClickThrough}`);
  assert.ok(gate < write, 'the match gate comes before the write');
  assert.equal(makeClickThrough.split('SetWindowLongPtr(').length - 1, 1, 'exactly one style write');
  assert.match(makeClickThrough, /uint browserProcessId = cc\.CoreWebView2\.BrowserProcessId;/);
  assert.match(makeClickThrough, /Rectangle bounds = overlay\.Bounds;/);
  // Never hidden, moved, re-ordered, re-parented or another style bit.
  assert.doesNotMatch(
    makeClickThrough,
    /ShowWindow|SetWindowPos|MoveWindow|SetParent|DestroyWindow|SetLayeredWindowAttributes|SwHide|SW_HIDE|WsExTopmost|WsExLayered|WsExNoActivate|& ~/,
    `the fix does more than set WS_EX_TRANSPARENT:\n${makeClickThrough}`,
  );
});
