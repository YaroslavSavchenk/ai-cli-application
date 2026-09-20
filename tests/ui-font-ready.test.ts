/**
 * `web/src/ui/font-ready.ts` — WHEN the terminal's mono face is usable, and
 * what follows from that (Nocturne part A4b; `.claude/plans/PLAN-NOCTURNE.md`).
 *
 * The defect this guards (user report from the Windows dev window,
 * 2026-09-10): nothing waited for JetBrains Mono, so a `TerminalView` built
 * while the woff2 was still in flight measured the FALLBACK face (Cascadia
 * Mono on Windows) and kept its glyphs AND its cell width — which means the
 * cols/rows that pane reported to the PTY were wrong — until a reload.
 *
 * The module is deliberately DOM-free and dependency-free, so `node --test`
 * imports it directly and drives it against a fake FontFaceSet; this file is
 * also the guard that keeps it that way (a stray `document` here is an
 * import-time throw). What is pinned:
 *
 *   1. NOTHING TO WAIT FOR IS A VALID ANSWER: no font-loading API, an empty
 *      stack or an unusable size must end the wait immediately. A wait that
 *      cannot end is a terminal that never draws.
 *   2. ALREADY LOADED COSTS NOTHING: `load()` is not even called, so a warm
 *      boot adds no delay at all.
 *   3. THE WAIT IS BOUNDED: a face that never arrives times out, and a
 *      rejected load is the same story with a different word.
 *   4. THE RECOVERY IS EXACTLY ONCE AND ONLY WHEN OWED: a face that lands
 *      after terminals were built repaints them once; a face that was there
 *      all along, or that lands before any terminal exists, repaints nothing —
 *      a redraw for nothing would be a PTY resize for nothing.
 *   5. THE FACES WAITED FOR ARE THE FACES DECLARED: the weights (400 normal,
 *      700 = xterm's `fontWeightBold` default) are checked against
 *      `web/src/styles/fonts.css` and the family against `tokens.css`, so a
 *      renamed face or a dropped weight fails here instead of in a pane.
 *
 * NOT claimed here: that the glyphs actually changed on screen — "font loaded"
 * is not "font renders" (memory: google-fonts-subset-trap). That is a browser
 * check and was run for A4b with the woff2 route held back 3 s (see the report
 * and `.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';
import {
  allLoaded,
  ensureFontsLoaded,
  FONT_WAIT_MS,
  fontSpec,
  primaryFamily,
  quoteFamily,
  refreshDecision,
  TERMINAL_FONT_WEIGHTS,
  terminalFontSpecs,
  watchFontArrival,
  type FontFaceSetLike,
} from '../web/src/ui/font-ready.ts';

/**
 * A FontFaceSet the test owns completely: nothing loads until `settle()` (or
 * `fail()`) is called, and `loadingdone` fires only when `fire()` says so.
 */
class FakeFontSet implements FontFaceSetLike {
  readonly ready = new Set<string>();
  readonly asked: string[] = [];
  readonly listeners: Array<() => void> = [];
  #pending: Array<{ spec: string; resolve: () => void; reject: (e: Error) => void }> = [];
  /** Set to make check() throw, like a spec the browser refuses to parse. */
  checkThrows = false;

  check(spec: string): boolean {
    if (this.checkThrows) throw new Error('could not parse font spec');
    return this.ready.has(spec);
  }

  load(spec: string): Promise<unknown> {
    this.asked.push(spec);
    return new Promise((resolve, reject) => {
      this.#pending.push({ spec, resolve: () => resolve(undefined), reject });
    });
  }

  addEventListener(type: 'loadingdone', listener: () => void): void {
    if (type === 'loadingdone') this.listeners.push(listener);
  }

  /** The faces arrive. */
  settle(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const p of pending) {
      this.ready.add(p.spec);
      p.resolve();
    }
  }

  /** The faces do not arrive (404, decode error). */
  fail(): void {
    const pending = this.#pending;
    this.#pending = [];
    for (const p of pending) p.reject(new Error('font failed to load'));
  }

  /** The face becomes usable without anyone having awaited our load(). */
  arrive(...specs: string[]): void {
    for (const s of specs) this.ready.add(s);
  }

  fire(): void {
    for (const l of this.listeners) l();
  }
}

const STACK = '"JetBrains Mono", ui-monospace, SFMono-Regular, monospace';
const SPECS = ['400 12.5px "JetBrains Mono"', '700 12.5px "JetBrains Mono"'];

// ---------------------------------------------------------------------------
// specs: which faces, spelled how
// ---------------------------------------------------------------------------

test('primaryFamily takes the first family of a stack and unwraps its quotes', () => {
  assert.equal(primaryFamily(STACK), 'JetBrains Mono');
  assert.equal(primaryFamily("'Berkeley Mono' , monospace"), 'Berkeley Mono');
  assert.equal(primaryFamily('  monospace  '), 'monospace');
  assert.equal(primaryFamily(''), null, 'an empty stack means "nothing to wait for"');
  assert.equal(primaryFamily('   '), null);
  assert.equal(primaryFamily(','), null);
});

test('quoteFamily quotes a name with spaces but leaves a bare keyword alone', () => {
  assert.equal(quoteFamily('JetBrains Mono'), '"JetBrains Mono"');
  assert.equal(
    quoteFamily('monospace'),
    'monospace',
    'a quoted "monospace" is a family nobody has, not the generic keyword',
  );
  assert.equal(quoteFamily('Say "hi"'), '"Say \\"hi\\""');
});

test('terminalFontSpecs asks for exactly the weights the terminal draws with', () => {
  assert.deepEqual(terminalFontSpecs(STACK, 12.5), SPECS);
  assert.deepEqual(TERMINAL_FONT_WEIGHTS, [400, 700]);
  assert.equal(fontSpec('JetBrains Mono', 400, 12.5), '400 12.5px "JetBrains Mono"');
});

test('terminalFontSpecs answers [] for anything unusable — never a wait that cannot end', () => {
  assert.deepEqual(terminalFontSpecs('', 12.5), []);
  assert.deepEqual(terminalFontSpecs(STACK, Number.NaN), []);
  assert.deepEqual(terminalFontSpecs(STACK, 0), []);
  assert.deepEqual(terminalFontSpecs(STACK, -3), []);
});

test('the family and weights waited for are the ones fonts.css and tokens.css declare', () => {
  const styles = join(projectRoot, 'web', 'src', 'styles');
  const fonts = readFileSync(join(styles, 'fonts.css'), 'utf8');
  const tokens = readFileSync(join(styles, 'tokens.css'), 'utf8');
  const monoToken = /--font-mono:\s*([^;]+);/.exec(tokens);
  assert.ok(monoToken, 'tokens.css must define --font-mono');
  const family = primaryFamily(monoToken[1] as string);
  assert.ok(family !== null, '--font-mono must name a family');
  const faces = [...fonts.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1] as string);
  for (const weight of TERMINAL_FONT_WEIGHTS) {
    const found = faces.some(
      (f) =>
        new RegExp(`font-family:\\s*["']${family}["']`).test(f) &&
        new RegExp(`font-weight:\\s*(${weight}\\b|\\d+\\s+\\d+)`).test(f),
    );
    assert.ok(
      found,
      `fonts.css declares no ${family} @font-face at weight ${weight} — the terminal would wait for a face that can never load`,
    );
  }
});

// ---------------------------------------------------------------------------
// allLoaded
// ---------------------------------------------------------------------------

test('allLoaded says yes only when every spec is ready', () => {
  const fonts = new FakeFontSet();
  assert.equal(allLoaded(fonts, SPECS), 'no');
  fonts.arrive(SPECS[0] as string);
  assert.equal(allLoaded(fonts, SPECS), 'no', 'bold missing is still missing');
  fonts.arrive(SPECS[1] as string);
  assert.equal(allLoaded(fonts, SPECS), 'yes');
  assert.equal(allLoaded(fonts, []), 'yes', 'no specs = nothing to wait for');
});

test('a check() the browser refuses to parse is its OWN answer, not a yes', () => {
  // Folding it into 'yes' was the first pass, and it disarmed two things at
  // once: the log line (the result was exactly 'already', which terminal.ts
  // does not log) and the late-arrival watcher (`wasReady` latched true). A
  // malformed --font-mono then handed every PTY the fallback's cols/rows with
  // nothing at all in server.log.
  const fonts = new FakeFontSet();
  fonts.checkThrows = true;
  assert.equal(allLoaded(fonts, SPECS), 'unparseable');
});

// ---------------------------------------------------------------------------
// ensureFontsLoaded
// ---------------------------------------------------------------------------

test('no font-loading API -> unsupported, immediately', async () => {
  assert.equal(await ensureFontsLoaded(null, SPECS, FONT_WAIT_MS), 'unsupported');
});

test('nothing to load -> none, immediately', async () => {
  assert.equal(await ensureFontsLoaded(new FakeFontSet(), [], FONT_WAIT_MS), 'none');
});

test('already loaded -> already, and load() is never even called (zero delay)', async () => {
  const fonts = new FakeFontSet();
  fonts.arrive(...SPECS);
  assert.equal(await ensureFontsLoaded(fonts, SPECS, FONT_WAIT_MS), 'already');
  assert.deepEqual(fonts.asked, []);
});

test('the faces arrive -> loaded, and every spec was asked for', async () => {
  const fonts = new FakeFontSet();
  const p = ensureFontsLoaded(fonts, SPECS, FONT_WAIT_MS);
  assert.deepEqual(fonts.asked, SPECS);
  fonts.settle();
  assert.equal(await p, 'loaded');
});

test('a face that never arrives -> timeout, bounded by the caller (the terminal draws anyway)', async () => {
  const fonts = new FakeFontSet();
  // Never settled. If the timer were not cleared this test process would hang.
  assert.equal(await ensureFontsLoaded(fonts, SPECS, 20), 'timeout');
});

test('a load that rejects -> failed, not a throw into boot', async () => {
  const fonts = new FakeFontSet();
  const p = ensureFontsLoaded(fonts, SPECS, FONT_WAIT_MS);
  fonts.fail();
  assert.equal(await p, 'failed');
});

test('FONT_WAIT_MS is a bound a human would not notice, and is actually finite', () => {
  assert.equal(FONT_WAIT_MS, 1500);
  assert.ok(Number.isFinite(FONT_WAIT_MS) && FONT_WAIT_MS > 0);
});

// ---------------------------------------------------------------------------
// the recovery decision
// ---------------------------------------------------------------------------

test('refreshDecision: only a face that arrives AFTER terminals exist is owed a redraw', () => {
  assert.equal(refreshDecision({ wasReady: false, isReady: true, views: 1 }), true);
  assert.equal(
    refreshDecision({ wasReady: false, isReady: true, views: 0 }),
    false,
    'no terminal drew with the fallback — the next one will measure the real face',
  );
  assert.equal(
    refreshDecision({ wasReady: true, isReady: true, views: 3 }),
    false,
    'the face was already there: a redraw would be a PTY resize for nothing',
  );
  assert.equal(refreshDecision({ wasReady: false, isReady: false, views: 3 }), false);
});

test('watchFontArrival: a late face repaints the live views exactly once', () => {
  const fonts = new FakeFontSet();
  let refreshed = 0;
  watchFontArrival({ fonts, specs: SPECS, views: () => 2, refresh: () => refreshed++ });
  fonts.fire(); // some other font finished — ours is still missing
  assert.equal(refreshed, 0);
  fonts.arrive(...SPECS);
  fonts.fire();
  assert.equal(refreshed, 1);
  fonts.fire();
  fonts.fire();
  assert.equal(refreshed, 1, 'every later loadingdone is somebody else’s font');
});

test('watchFontArrival: a face that was there when terminals started is never a repaint', () => {
  const fonts = new FakeFontSet();
  fonts.arrive(...SPECS);
  let refreshed = 0;
  watchFontArrival({ fonts, specs: SPECS, views: () => 4, refresh: () => refreshed++ });
  fonts.fire();
  assert.equal(refreshed, 0);
});

test('watchFontArrival: a face that lands before any terminal exists latches, silently', () => {
  const fonts = new FakeFontSet();
  let views = 0;
  let refreshed = 0;
  watchFontArrival({ fonts, specs: SPECS, views: () => views, refresh: () => refreshed++ });
  fonts.arrive(...SPECS);
  fonts.fire();
  assert.equal(refreshed, 0, 'nothing drew with the fallback yet');
  views = 3; // panes built afterwards — they measured the real face themselves
  fonts.fire();
  assert.equal(refreshed, 0);
});

test('watchFontArrival: no font API and no specs install no listener at all', () => {
  const fonts = new FakeFontSet();
  watchFontArrival({ fonts, specs: [], views: () => 1, refresh: () => assert.fail('refreshed') });
  assert.deepEqual(fonts.listeners, []);
  watchFontArrival({
    fonts: null,
    specs: SPECS,
    views: () => 1,
    refresh: () => assert.fail('refreshed'),
  });
});

// ---------------------------------------------------------------------------
// the wiring: the seam every TerminalView sits behind
// ---------------------------------------------------------------------------

test('main.ts waits for the font BEFORE the shell, and arms the watch between the two', () => {
  const main = readFileSync(join(projectRoot, 'web', 'src', 'main.ts'), 'utf8');
  const wait = main.indexOf('await fontReady');
  const watch = main.indexOf('watchTerminalFont()');
  const shell = main.indexOf('buildShell(root, prefs)');
  assert.ok(wait > 0 && watch > 0 && shell > 0, 'the three boot seams must all exist');
  assert.ok(
    wait < watch && watch < shell,
    'order is: wait for the face, arm the watch (so it remembers whether the face was there when terminals started), then build the panes',
  );
  assert.ok(
    main.indexOf('loadTerminalFont()') < main.indexOf('await Promise.all'),
    'the request must start before the hydrate round trip, so the wait overlaps it instead of adding to it',
  );
});

test('the font wait is a boot-panel row of its own, and can never reject into boot()', () => {
  const main = readFileSync(join(projectRoot, 'web', 'src', 'main.ts'), 'utf8');
  // A rejection here would abort boot() AFTER the other rows settled and the
  // overlay removed itself — a dark window with no message (boot() has no
  // catcher: `void boot(app)`). Settling at the source also means the early
  // `return` on a hydrate fatal leaves no promise without a handler.
  assert.match(
    main,
    /const fontReady = loadTerminalFont\(\)\.catch\(\(\): FontWaitResult => 'failed'\)/,
    'loadTerminalFont() must be caught where it is created, not around the await',
  );
  // And the wait must happen while the overlay is still up: the panel only
  // removes itself when every registered step has settled, so the wait needs
  // its own row — otherwise up to FONT_WAIT_MS passes on an empty page.
  const row = main.indexOf("panel.step('Loading the terminal font')");
  assert.ok(row > 0, 'the wait must be an honest boot-panel row');
  assert.ok(
    row < main.indexOf('const fontReady ='),
    'the row is registered with the other three, before anything can settle the panel',
  );
  assert.match(
    main,
    /void fontReady\.then\(\(result\) => \{[\s\S]*?stepFont\.fail\([\s\S]*?stepFont\.ok\(\)/,
    'the row must settle from fontReady itself — every outcome, ok or soft failure',
  );
});

test('the late-font repair reuses the ONE resize path — it does not re-implement it', () => {
  const src = readFileSync(join(projectRoot, 'web', 'src', 'ui', 'terminal.ts'), 'utf8');
  const body = /reloadFont\(\): void \{([\s\S]*?)\n  \}/.exec(src);
  assert.ok(body, 'terminal.ts must have a reloadFont() method');
  const code = (body[1] as string).replace(/^\s*\/\/.*$/gm, '');
  assert.match(code, /this\.term\.clearTextureAtlas\(\)/, 'the glyph atlas drawn with the fallback must go');
  assert.match(code, /this\.#fitNow\(true\)/, 'the refit must go through the existing fit -> ws-resize path');
  assert.doesNotMatch(
    code,
    /sendResize|new ResizeObserver/,
    'a second resize path would be a second set of bugs',
  );
});

// ---------------------------------------------------------------------------
// gate additions (A4b test gate): the branches and seams the first pass left
// unpinned. Each of these fails against a mutant that survived the suite.
// ---------------------------------------------------------------------------

/** Timers this process is holding open right now (node counts each as 'Timeout'). */
const pendingTimers = (): number =>
  process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

test('ensureFontsLoaded clears its deadline timer in EVERY branch, not just the timeout one', async () => {
  // A bound nothing here ever reaches: if the `finally` stopped clearing the
  // timer, the returned word would still be right and a suite that only looked
  // at words would still be green — the page (and this process) would just
  // stay awake holding it. So the pending timer itself is the assertion.
  // 30 s and not `2 ** 31 - 1` for a reason: an un-cleared timer keeps THIS
  // process alive too, so a broken build must fail loudly and then still exit
  // (measured: with the clearTimeout removed, a 2 ** 31 - 1 bound left
  // `node --test` hanging ~24 days after printing the failure).
  const NEVER_REACHED_MS = 30_000;
  const before = pendingTimers();

  const already = new FakeFontSet();
  already.arrive(...SPECS);
  assert.equal(await ensureFontsLoaded(already, SPECS, NEVER_REACHED_MS), 'already');
  assert.equal(pendingTimers(), before, 'the already-loaded branch must not even arm a timer');

  const arriving = new FakeFontSet();
  const loaded = ensureFontsLoaded(arriving, SPECS, NEVER_REACHED_MS);
  assert.equal(pendingTimers(), before + 1, 'non-vacuity: the wait really does arm one timer');
  arriving.settle();
  assert.equal(await loaded, 'loaded');
  assert.equal(pendingTimers(), before, 'the loaded branch left its deadline timer pending');

  const broken = new FakeFontSet();
  const failed = ensureFontsLoaded(broken, SPECS, NEVER_REACHED_MS);
  broken.fail();
  assert.equal(await failed, 'failed');
  assert.equal(pendingTimers(), before, 'the failed branch left its deadline timer pending');

  const silent = new FakeFontSet();
  assert.equal(await ensureFontsLoaded(silent, SPECS, 20), 'timeout');
  assert.equal(pendingTimers(), before, 'the timeout branch left its own timer pending');
});

test('a check() that throws ends the wait at once — as a LOGGED failure, watcher still armed', async () => {
  const before = pendingTimers();
  const fonts = new FakeFontSet();
  fonts.checkThrows = true;
  // 'unparseable', not 'already': terminal.ts logs every result except
  // 'already', so this is the difference between a line in server.log and
  // total silence while every terminal draws on the fallback's cell width —
  // and its own word, so the log tells a malformed spec from a rejected load.
  assert.equal(await ensureFontsLoaded(fonts, SPECS, FONT_WAIT_MS), 'unparseable');
  assert.deepEqual(fonts.asked, [], 'a spec the browser cannot parse is not worth a load()');
  assert.equal(pendingTimers(), before, 'boot is never blocked, and no timer outlives it');

  // And the second half of A4b stays alive: the unparseable reading must not
  // latch `wasReady`, so a face that becomes readable later is still repaired.
  let refreshed = 0;
  watchFontArrival({ fonts, specs: SPECS, views: () => 2, refresh: () => refreshed++ });
  fonts.fire();
  assert.equal(refreshed, 0, 'still unparseable — nothing is known to have arrived');
  fonts.checkThrows = false;
  fonts.arrive(...SPECS);
  fonts.fire();
  assert.equal(refreshed, 1, 're-evaluated on loadingdone instead of staying latched');
});

test('quoteFamily escapes what a CSS string cannot hold raw, and round-trips through primaryFamily', () => {
  assert.equal(quoteFamily('Back\\slash'), '"Back\\\\slash"');
  assert.equal(quoteFamily('Mono 3'), '"Mono 3"', 'a leading digit in a word is still a quoted name');
  assert.equal(quoteFamily('_private'), '_private', 'a bare CSS identifier stays bare');
  assert.equal(quoteFamily('ui-monospace'), 'ui-monospace');
  for (const name of ['JetBrains Mono', 'monospace', 'ui-monospace', 'Berkeley Mono']) {
    assert.equal(primaryFamily(quoteFamily(name)), name, `quote -> parse must survive "${name}"`);
  }
});

test('primaryFamily: the shapes a hand-edited token can really take', () => {
  assert.equal(primaryFamily('"JetBrains Mono"'), 'JetBrains Mono', 'a one-family stack');
  assert.equal(primaryFamily("'JetBrains Mono',monospace"), 'JetBrains Mono', 'no space after the comma');
  assert.equal(primaryFamily('\t"JetBrains Mono" ,\n monospace'), 'JetBrains Mono', 'tabs and newlines');
  assert.equal(primaryFamily('""'), null, 'an empty quoted name is nothing to wait for');
  assert.equal(primaryFamily("'   '"), null);
  assert.equal(primaryFamily(', "JetBrains Mono"'), null, 'a leading comma means the FIRST family is empty');
  // KNOWN LIMIT, pinned rather than hidden: the split is on ',' before the
  // quotes are read, so a family name containing a comma is truncated. No such
  // font exists in this app's stack and the wait degrades to "never loads ->
  // timeout", which the recovery path repairs.
  assert.equal(primaryFamily('"Foo, Bar", monospace'), '"Foo', 'known limit: comma inside a quoted name');
});

// ---------------------------------------------------------------------------
// the glue in ui/terminal.ts, pinned by source scan
//
// `ui/terminal.ts` imports @xterm/xterm (a browser bundle that cannot load
// under Node) and TerminalView needs a DOM, so the same treatment as
// tests/ui-terminal-copy.test.ts: the decisions are read out of the source.
// Everything BEHIND this glue is driven for real above.
// ---------------------------------------------------------------------------

const TERMINAL_SRC = readFileSync(join(projectRoot, 'web', 'src', 'ui', 'terminal.ts'), 'utf8');
/** Source without comments — a comment may DISCUSS what the code may not do. */
const terminalCode = TERMINAL_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

test('non-vacuity: the glue being scanned is the real ui/terminal.ts', () => {
  assert.ok(TERMINAL_SRC.length > 5000, 'ui/terminal.ts looks empty');
  assert.match(terminalCode, /export async function loadTerminalFont\(/);
  assert.match(terminalCode, /export function watchTerminalFont\(/);
  assert.match(terminalCode, /function specsFromTokens\(/);
});

test('the faces waited for are measured from the SAME tokens the terminal is built with', () => {
  const specs = /function specsFromTokens\(\): string\[\] \{([\s\S]*?)\n\}/.exec(terminalCode);
  assert.ok(specs, 'terminal.ts must derive its specs from the tokens');
  const body = specs[1] as string;
  const ctor = /constructor\(container: HTMLElement\) \{([\s\S]*?)cursorBlink/.exec(terminalCode);
  assert.ok(ctor, 'the Terminal constructor must still set its font from the tokens');
  for (const token of ['--font-mono', '--fs-term']) {
    assert.ok(
      body.includes(token),
      `specsFromTokens must read ${token} — waiting for a face the terminal never draws with is a wait for nothing`,
    );
    assert.ok(
      (ctor[1] as string).includes(token),
      `the Terminal constructor must still take its font from ${token}`,
    );
  }
});

test('loadTerminalFont is bounded by FONT_WAIT_MS — the one declared bound, not a second number', () => {
  const fn = /export async function loadTerminalFont\(\)[\s\S]*?\n\}/.exec(terminalCode);
  assert.ok(fn, 'loadTerminalFont must exist');
  const body = fn[0];
  assert.match(
    body,
    /ensureFontsLoaded\(\s*fontSet\(\),\s*specsFromTokens\(\),\s*FONT_WAIT_MS\s*\)/,
    'an inline bound here would make FONT_WAIT_MS (and its test) a lie',
  );
  assert.doesNotMatch(body, /\d{3,}/, 'no hand-written millisecond literal beside the token');
});

test('watchTerminalFont repairs every live view — a watch that refreshes nothing is the bug it fixes', () => {
  const fn = /export function watchTerminalFont\(\): void \{([\s\S]*?)\n\}\n/.exec(terminalCode);
  assert.ok(fn, 'watchTerminalFont must exist');
  const body = fn[1] as string;
  assert.match(body, /views:\s*\(\)\s*=>\s*liveViews\.size/, 'the view count must be read live, at the moment the face lands');
  assert.match(
    body,
    /for \(const view of liveViews\) view\.reloadFont\(\);/,
    'the refresh must actually reload the font of every live view',
  );
});

test('reloadFont re-spells the font stack so xterm RE-MEASURES the cell (an equal write is dropped)', () => {
  const method = /reloadFont\(\): void \{([\s\S]*?)\n  \}/.exec(terminalCode);
  assert.ok(method, 'terminal.ts must have a reloadFont() method');
  const body = method[1] as string;
  const write = /this\.term\.options\.fontFamily = ([^;]+);/.exec(body);
  assert.ok(
    write,
    'without a write to options.fontFamily xterm never calls CharSizeService.measure(), so the cell keeps the FALLBACK width and every later fit reports a lie',
  );
  assert.ok(
    body.indexOf('fontFamily =') < body.indexOf('clearTextureAtlas'),
    'the re-measure must happen before the atlas is thrown away',
  );
  // The written expression is the whole point, so it is executed rather than
  // pattern-matched: it must produce a DIFFERENT string (xterm's options
  // service drops a write of an equal value — no event, no re-measure) that
  // still names the SAME stack to the CSS parser, and it must toggle back so a
  // second late arrival works too.
  const nudge = new Function('family', `return (${write[1] as string});`) as (f: string) => string;
  for (const stack of [
    '"JetBrains Mono", ui-monospace, monospace',
    '"JetBrains Mono", ui-monospace, monospace ',
    'monospace',
  ]) {
    const next = nudge(stack);
    assert.notEqual(next, stack, `the write must differ from the current value (${stack})`);
    assert.equal(next.trim(), stack.trim(), 'and must still be the same font stack to CSS');
    assert.equal(nudge(next), stack, 'the nudge must toggle back, so a second late arrival works too');
  }
});

/**
 * Every value `ensureFontsLoaded` can answer, read out of the module's own
 * union so a seventh outcome cannot be added without the two tests below
 * being forced to say what happens to it.
 */
const FONT_WAIT_RESULTS: readonly string[] = (() => {
  const src = readFileSync(join(projectRoot, 'web', 'src', 'ui', 'font-ready.ts'), 'utf8');
  const union = /export type FontWaitResult =([^;]+);/.exec(src);
  assert.ok(union, 'font-ready.ts must export the FontWaitResult union');
  return [...(union[1] as string).matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
})();

/** Run a condition lifted out of the real source against every result value. */
const decide = (condition: string): ((result: string) => boolean) =>
  new Function('result', `return !!(${condition});`) as (result: string) => boolean;

test('the union is the seven outcomes both callers below branch on', () => {
  assert.deepEqual([...FONT_WAIT_RESULTS].sort(), [
    'already',
    'failed',
    'loaded',
    'none',
    'timeout',
    'unparseable',
    'unsupported',
  ]);
});

test('the boot row fails for EVERY outcome the user ends up paying for: timeout and failed', () => {
  // A green row for 'failed' is the defect this whole part is about, one level
  // up: the face is not there, every terminal draws on the fallback's cell
  // width, and the boot panel says it went fine. 'failed' covers a rejected
  // load; 'unparseable' a malformed --font-mono / --fs-term — both are cases
  // nobody would otherwise see.
  const main = readFileSync(join(projectRoot, 'web', 'src', 'main.ts'), 'utf8');
  const then = /void fontReady\.then\(\(result\) => \{\s*if \(([^)]*(?:\)[^)]*)*?)\) \{/.exec(main);
  assert.ok(then, 'main.ts must settle the row from fontReady with an if on the result');
  const isFailure = decide(then[1] as string);
  assert.equal(isFailure('timeout'), true, 'a face that never arrived is not a green row');
  assert.equal(isFailure('failed'), true, 'a rejected load is not a green row');
  assert.equal(isFailure('unparseable'), true, 'an unparseable spec is not a green row');
  for (const ok of ['already', 'loaded', 'none', 'unsupported']) {
    assert.equal(isFailure(ok), false, `${ok} is not a failure — the terminal has the face it will draw with`);
  }
});

test('loadTerminalFont logs every outcome except the free one — silence is how A4b was missed', () => {
  // server.log is the backend's only diagnostic channel and the browser ships
  // its lines through /api/client-log, so this debug line is the ONLY trace
  // that a pane started on the fallback face. 'already' is the one outcome
  // worth nothing: the face was there, no time was spent, nothing happened.
  const src = readFileSync(join(projectRoot, 'web', 'src', 'ui', 'terminal.ts'), 'utf8');
  const fn = /export async function loadTerminalFont\(\)[\s\S]*?\n\}/.exec(src);
  assert.ok(fn, 'loadTerminalFont must exist');
  const line = /if \(([^)]*(?:\)[^)]*)*?)\) log\.debug\(`terminal font: \$\{result\}`\)/.exec(fn[0]);
  assert.ok(
    line,
    'loadTerminalFont must log the result it returns — a wait nobody can see the outcome of is a wait nobody can debug',
  );
  const isLogged = decide(line[1] as string);
  assert.equal(isLogged('already'), false, 'the warm path costs nothing and says nothing');
  for (const noisy of FONT_WAIT_RESULTS.filter((r) => r !== 'already')) {
    assert.equal(isLogged(noisy), true, `${noisy} must reach server.log`);
  }
});
