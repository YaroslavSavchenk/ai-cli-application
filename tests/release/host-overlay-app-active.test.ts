/**
 * D8 in the Windows host (`.claude/plans/nocturne/PLAN-D8.md`, decision 24 of
 * `.claude/plans/PLAN-NOCTURNE.md`): while the app window is the ACTIVE window
 * the host tells the peek-mascot page so, and the page steps its mascots back.
 * Host -> page is exactly `{"type":"app-active","active":true|false}`, posted
 * on the overlay view only when the state changes, and again after every
 * successful load of the page. While hidden the page reports `"rects":[]`,
 * which must still parse and must give the empty (click-through) region.
 *
 * How: a source read, the idiom of `tests/release/host-overlay-stray.test.ts`
 * — the C# host cannot run where `npm test` runs. Comments are stripped and
 * whitespace collapsed before a pin matches, so a comment can never satisfy
 * one. The mascot-count regex is rebuilt from its C# constants and run here.
 *
 * NOT claimed: that Windows delivers the foreground events or that the page
 * reacts — that is the DEV check on Windows (PLAN-D8 § Phases, phase 3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSource } from '../helpers/helpers.ts';
import { csharpMember } from '../helpers/host-sources.ts';

const OVERLAY = 'AiSessionManagerHost-overlay.cs';
const WINDOW = 'AiSessionManagerHost-overlay-window.cs';
const cs = readSource('launcher', 'host', OVERLAY);
const windowCs = readSource('launcher', 'host', WINDOW);

const isAppWindow = csharpMember(cs, 'private static bool IsAppWindow(', OVERLAY);
const tell = csharpMember(cs, 'private static void TellOverlayAppActive(', OVERLAY);
const post = csharpMember(cs, 'private static void PostAppActive(', OVERLAY);
const navigated = csharpMember(cs, 'private static void OverlayWebView_NavigationCompleted(', OVERLAY);
const foreground = csharpMember(windowCs, 'private static void Foreground_Changed(', WINDOW);
const countHandler = csharpMember(windowCs, 'private static void HandleMascotCount(', WINDOW);

// --- C# string constants, evaluated -----------------------------------------

/**
 * The value of a `const string` / `static readonly Regex` initialiser in `cs`:
 * a `+` chain of verbatim (`@"…"`), regular (`"…"`) literals and the names of
 * other constants. Enough for the shapes these files use, nothing more.
 */
function csValue(name: string): string {
  const m = new RegExp(
    `private (?:const string|static readonly Regex) ${name} =\\s*(?:new Regex\\()?([\\s\\S]*?)(?:,\\s*RegexOptions\\.[A-Za-z]+\\)|);`,
  ).exec(cs);
  assert.ok(m, `${name} is not a constant of ${OVERLAY}`);
  const expr = m[1]!;
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i]!;
    if (/[\s+]/.test(c)) {
      i += 1;
    } else if (c === '@' && expr[i + 1] === '"') {
      let j = i + 2;
      for (;;) {
        if (expr[j] === '"' && expr[j + 1] === '"') {
          out += '"';
          j += 2;
        } else if (expr[j] === '"') {
          break;
        } else {
          out += expr[j];
          j += 1;
        }
      }
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (expr[j] !== '"') {
        if (expr[j] === '\\') j += 1;
        out += expr[j];
        j += 1;
      }
      i = j + 1;
    } else {
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(expr.slice(i));
      assert.ok(id, `${name}: unexpected text at "${expr.slice(i, i + 20)}"`);
      out += csValue(id[0]);
      i += id[0].length;
    }
  }
  return out;
}

/** A .NET pattern as a JS RegExp: `\z` (end of input) is JS `$` without the m flag. */
function dotnetRegex(name: string): RegExp {
  return new RegExp(csValue(name).replace(/\\z$/, '$'), 'g');
}

// --- the contract strings ----------------------------------------------------

test('the two app-active strings are exactly the frozen contract', () => {
  assert.equal(csValue('AppActiveMessage'), '{"type":"app-active","active":true}');
  assert.equal(csValue('AppInactiveMessage'), '{"type":"app-active","active":false}');
  assert.deepEqual(JSON.parse(csValue('AppActiveMessage')), { type: 'app-active', active: true });
  assert.deepEqual(JSON.parse(csValue('AppInactiveMessage')), { type: 'app-active', active: false });
});

test('the overlay view is posted to in one place only, with one of the two strings', () => {
  assert.equal(cs.split('PostWebMessageAsString(').length - 1, 1, `${OVERLAY} posts in more than one place`);
  assert.ok(
    post.includes('core.PostWebMessageAsString(active ? AppActiveMessage : AppInactiveMessage);'),
    `PostAppActive posts something else:\n${post}`,
  );
});

// --- active = the app window or a window it owns -----------------------------

test('active = the main window, or a window whose root owner is the main window; never the overlay', () => {
  assert.match(cs, /private const uint GaRootOwner = 3;/);
  assert.match(cs, /\[DllImport\("user32\.dll"\)\]\s*private static extern IntPtr GetAncestor\(IntPtr hwnd, uint flags\);/);
  assert.match(cs, /\[DllImport\("user32\.dll"\)\]\s*private static extern IntPtr GetForegroundWindow\(\);/);
  assert.ok(isAppWindow.includes('Form main = _form;'), isAppWindow);
  assert.ok(
    isAppWindow.includes('&& hwnd == overlay.Handle) { return false; }'),
    `the overlay is not excluded:\n${isAppWindow}`,
  );
  assert.ok(
    isAppWindow.includes('IntPtr app = main.Handle; return hwnd == app || GetAncestor(hwnd, GaRootOwner) == app;'),
    `the root-owner test is loosened or gone:\n${isAppWindow}`,
  );
  assert.ok(
    isAppWindow.includes('if (hwnd == IntPtr.Zero || main == null || main.IsDisposed || !main.IsHandleCreated) { return false; }'),
    `no foreground / no main window must read as not active:\n${isAppWindow}`,
  );
});

test('the state is read from the window in front now, inside its own try', () => {
  assert.ok(
    tell.includes('try { PostAppActive(IsAppWindow(GetForegroundWindow())); } catch (Exception ex) { Log('),
    tell,
  );
  assert.match(tell, /"\); non-fatal\."\);/);
});

// --- post on change only -----------------------------------------------------

test('a post goes out only when the state changes, and only to a live overlay', () => {
  assert.match(cs, /private static bool\? _appActivePosted;/);
  const guard = 'if (_appActivePosted.HasValue && _appActivePosted.Value == active) { return; }';
  const live = 'if (overlay == null || overlay.IsDisposed || cc == null) { return; }';
  const send = 'core.PostWebMessageAsString(active ? AppActiveMessage : AppInactiveMessage); _appActivePosted = active;';
  for (const piece of [live, guard, 'if (core == null) { return; }', send]) {
    assert.ok(post.includes(piece), `PostAppActive lost "${piece}":\n${post}`);
  }
  assert.ok(post.indexOf(live) < post.indexOf(guard) && post.indexOf(guard) < post.indexOf(send), post);
  // A failed post leaves the state unknown, so the next change posts again.
  assert.ok(post.includes('catch (Exception ex) { _appActivePosted = null; Log('), post);
  assert.match(post, /"\); non-fatal\."\);/);
});

// --- the foreground hook -----------------------------------------------------

test('every foreground change feeds the state, whether a mascot shows or not, before the raise', () => {
  const order = [
    'try { if (_overlay == null) { return; }',
    'TellOverlayAppActive();',
    'if (_overlayRects == null) { return; }',
    'RaiseOverlay();',
    'catch (Exception ex) { Log(',
  ];
  let at = -1;
  for (const piece of order) {
    const next = foreground.indexOf(piece, at + 1);
    assert.ok(next > at, `Foreground_Changed: "${piece}" missing or out of order:\n${foreground}`);
    at = next;
  }
  assert.ok(!foreground.includes('_overlay == null || _overlayRects == null'), 'the rects gate is back in front of the state');
});

// --- the page's load ----------------------------------------------------------

test('every successful load of the page is told the state afresh', () => {
  assert.match(cs, /core\.NavigationCompleted \+= OverlayWebView_NavigationCompleted;/);
  assert.ok(
    navigated.includes(
      'if (e == null || !e.IsSuccess) { return; } _appActivePosted = null; TellOverlayAppActive(); }',
    ),
    `NavigationCompleted must reset and post on success only:\n${navigated}`,
  );
});

// --- page -> host: "rects":[] while hidden -------------------------------------

test('mascot-count accepts an empty rects list, and up to three rects, nothing looser', () => {
  const count = dotnetRegex('MascotCountMessage');
  const ok = (s: string) => new RegExp(count.source).test(s);
  assert.ok(ok('{"type":"mascot-count","count":2,"rects":[]}'), 'a hidden page reports its count with []');
  assert.ok(ok('{"type":"mascot-count","count":0,"rects":[]}'));
  assert.ok(ok('{"type":"mascot-count","count":1,"rects":[[120,10,132,160]]}'));
  assert.ok(ok('{"type":"mascot-count","count":3,"rects":[[1,2,3,4],[5,6,7,8],[9,10,11.5,1e2]]}'));
  assert.ok(!ok('{"type":"mascot-count","count":3,"rects":[[1,2,3,4],[1,2,3,4],[1,2,3,4],[1,2,3,4]]}'));
  assert.ok(!ok('{"type":"mascot-count","count":2,"rects":[ ]}'));
  assert.ok(!ok('{"type":"mascot-count","count":2,"rects":[],}'));
  assert.ok(!ok('{"type":"mascot-count","count":4,"rects":[]}'));
  assert.ok(!ok('{"type":"mascot-count","count":2,"rects":[]}\n'));
  assert.equal(new RegExp(count.source).exec('{"type":"mascot-count","count":2,"rects":[]}')!.groups!.rects, undefined);
  // The rect loop then sees nothing: no match in an empty group.
  assert.equal(''.match(dotnetRegex('MascotRectItem')), null);
});

test('a count without a usable rect is the empty region (ShowMascotRects(null))', () => {
  assert.ok(countHandler.includes('foreach (Match r in MascotRectItem.Matches(m.Groups["rects"].Value))'), countHandler);
  assert.ok(countHandler.endsWith('ShowMascotRects(rects.Count == 0 ? null : rects.ToArray()); }'), countHandler);
});
