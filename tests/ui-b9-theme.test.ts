/**
 * Nocturne B9 (`.claude/plans/nocturne/PLAN-B9.md`) — the terminal colours the
 * Settings page picks, driven through the REAL `web/src/ui/theme.ts`.
 *
 * WHAT THIS FILE OWNS, that no other suite can see:
 *   1. What lands on `:root`. `document.documentElement.style` here is a
 *      recording double, so an apply is asserted as the ORDERED list of
 *      operations it performed — the six `setProperty` calls with the exact
 *      hexes `coloursOf` derives, or the six `removeProperty` calls the
 *      default pair does instead (D2: Nocturne is the ABSENCE of an override,
 *      so `--xt-bright-white` stays tokens.css's `#f3f5fe`, a step no ramp
 *      carries). A seventh property, or a write where a removal belongs, fails.
 *   2. The two stores. localStorage (`ai-sm:theme:v1`) is written at once and
 *      in the v2 pair shape — a Legacy `{bg,fg,scan}` bag read from the server
 *      is rewritten as hexes with `scan` dropped; the server copy is the
 *      `theme` key of the prefs bag, written through the REAL
 *      `web/src/api.ts` (a fetch double underneath), so the GET-merge-PUT is
 *      exercised rather than imagined: the PUT has to carry `statusLine`,
 *      `behaviour` and `tools` back untouched.
 *   3. The write policy (D4): trailing-debounced ~300ms, SERIALISED — one
 *      request in flight, at most one queued follow-up carrying the latest
 *      pair — and `flush()` sends now, which is what closing the dialog does.
 *      A burst of fifty swatch drags must cost one PUT, not fifty.
 *   4. The page → control wire (D5): `buildTermColours` drives the control and
 *      nothing else; a card click, a valid hex and `sync()` are pinned against
 *      the REAL control, so what the page shows is what `:root` gets.
 *   5. The D3 CSS split: `--term-bg` is the THEMED terminal ground and nothing
 *      but terminal surfaces may read it; the editor chip, the editor/diff
 *      pane bodies and the diff itself read the untouched twin `--color-term`.
 *
 * STUBS, and why exactly these. `ui/theme.ts` imports `./terminal.ts` (which
 * imports @xterm/xterm — unimportable under `node --test`) and `../log.ts`;
 * both are replaced through `registerHooks`, and `api.ts`'s own `./log.ts` too,
 * so the only fetches this file sees are the prefs GET/PUT under test.
 * `api.ts` itself is the REAL module. Timers: `ui/theme.ts` debounces through
 * `window.setTimeout`, which the DOM double RECORDS instead of firing — so
 * nothing here waits on a clock; `runTimers()` fires what is armed, and every
 * async wait is a condition with a bounded number of turns (`until`).
 *
 * Looks stay manual (`.claude/skills/verify-terminal/SKILL.md`): this proves
 * the values, not that they are pretty on a screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { byClass, dispatch, installDom, type FakeElement } from './fake-dom.ts';

const dom = installDom();

// ---------------------------------------------------------------------------
// :root, recording
// ---------------------------------------------------------------------------

/** Every operation ui/theme.ts performed on `:root`, in order. */
const ops: string[] = [];
const rootBag = new Map<string, string>();
const htmlEl = dom.doc.createElement('html');
Object.defineProperty(htmlEl, 'style', {
  value: {
    setProperty(name: string, value: string): void {
      ops.push(`set ${name}=${value}`);
      rootBag.set(name, value);
    },
    getPropertyValue(name: string): string {
      return rootBag.get(name) ?? '';
    },
    removeProperty(name: string): void {
      ops.push(`rm ${name}`);
      rootBag.delete(name);
    },
  },
  writable: false,
});
(dom.doc as unknown as Record<string, unknown>).documentElement = htmlEl;

/** The six slots D2 names, in the order theme.ts touches them. */
const SLOTS = [
  '--term-bg',
  '--xt-fg',
  '--xt-white',
  '--xt-bright-white',
  '--xt-cursor',
  '--xt-bright-black',
] as const;

const REMOVES = SLOTS.map((s) => `rm ${s}`);

/** What an apply of a pair whose four colours are these must have written. */
function sets(c: { ground: string; cmd: string; out: string; dim: string }): string[] {
  return [
    `set --term-bg=${c.ground}`,
    `set --xt-fg=${c.out}`,
    `set --xt-white=${c.out}`,
    `set --xt-bright-white=${c.cmd}`,
    `set --xt-cursor=${c.cmd}`,
    `set --xt-bright-black=${c.dim}`,
  ];
}

/** The custom properties in force on `:root` right now. */
function live(): string[] {
  return SLOTS.filter((s) => rootBag.has(s)).map((s) => `${s}=${rootBag.get(s) as string}`);
}

// ---------------------------------------------------------------------------
// The server: the REAL api.ts on a fetch double
// ---------------------------------------------------------------------------

interface Call {
  path: string;
  method: string;
  body: unknown;
}

let calls: Call[] = [];
/** What `GET /api/prefs` answers — and what a PUT replaces, as the server does. */
let bag: Record<string, unknown> = {};
/** While true, every PUT hangs until `releasePuts()` — an in-flight write. */
let gatePut = false;
const held: (() => void)[] = [];
/** One PUT fails with a 500, the way a backend restart mid-write would. */
let failNextPut = false;

function res(body: unknown, ok: boolean): { ok: boolean; status: number; json: () => Promise<unknown> } {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

(dom.win as unknown as Record<string, unknown>).__AUTH__ = 'b9-test-token';
(globalThis as unknown as Record<string, unknown>).fetch = async (
  path: string,
  init: { method?: string; body?: string } = {},
): Promise<unknown> => {
  const method = (init.method ?? 'GET').toUpperCase();
  const body = init.body !== undefined ? (JSON.parse(init.body) as unknown) : undefined;
  calls.push({ path, method, body });
  if (method === 'GET') return res(bag, true);
  if (gatePut) {
    await new Promise<void>((r) => {
      held.push(r);
    });
  }
  if (failNextPut) {
    failNextPut = false;
    return res({ error: 'prefs write refused' }, false);
  }
  bag = body as Record<string, unknown>;
  return res({ ok: true }, true);
};

function releasePuts(): void {
  gatePut = false;
  for (const r of held.splice(0)) r();
}

/** The `theme` member of every PUT body, in order. */
function puts(): unknown[] {
  return calls.filter((c) => c.method === 'PUT').map((c) => (c.body as Record<string, unknown>).theme);
}

// ---------------------------------------------------------------------------
// Module stubs: terminal.ts (xterm) and log.ts, and api.ts's log.ts
// ---------------------------------------------------------------------------

const H = { refreshes: 0 };
(globalThis as unknown as Record<string, unknown>).__b9 = H;

const STUB: Record<string, string> = {
  terminal: `export function refreshAllTerminalThemes() { globalThis.__b9.refreshes += 1; }`,
  log: `export const log = { debug(){}, info(){}, warn(){}, error(){} };
    export function formatError(e) { return e instanceof Error ? e.message : String(e); }`,
};

registerHooks({
  resolve(spec, ctx, next) {
    const parent = ctx.parentURL ?? '';
    if (parent.endsWith('/web/src/ui/theme.ts')) {
      if (spec === './terminal.ts') return { url: 'b9-stub:terminal', shortCircuit: true };
      if (spec === '../log.ts') return { url: 'b9-stub:log', shortCircuit: true };
    }
    // api.ts logs every request; its logger batches to the backend through a
    // bare fetch, which would show up in `calls` as noise this file must not
    // have to filter.
    if (parent.endsWith('/web/src/api.ts') && spec === './log.ts') {
      return { url: 'b9-stub:log', shortCircuit: true };
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.startsWith('b9-stub:')) {
      return {
        format: 'module',
        source: STUB[url.slice('b9-stub:'.length)] as string,
        shortCircuit: true,
      };
    }
    return next(url, ctx);
  },
});

interface TermPair {
  ground: string;
  text: string;
}
interface ThemeControl {
  apply(next: TermPair): void;
  adopt(next: TermPair): void;
  current(): TermPair;
  flush(): Promise<void>;
}
interface ThemeModule {
  initTheme(serverPrefs?: Record<string, unknown>): ThemeControl;
}
interface ModelModule {
  GROUNDS: { name: string; hex: string }[];
  RAMPS: { name: string; cmd: string; out: string; dim: string }[];
  NOCTURNE: TermPair;
  clampTheme(raw: unknown): TermPair;
}
interface TcModule {
  mixHex(a: string, b: string, t: number): string;
  presetColours(id: string): { ground: string; cmd: string; out: string; dim: string };
}
interface PageModule {
  buildTermColours(
    titleId: string,
    ctl: { apply(next: TermPair): void; current(): TermPair },
  ): { root: FakeElement; sync(): void };
}

const TH = (await import(new URL('../web/src/ui/theme.ts', import.meta.url).href)) as ThemeModule;
const T = (await import(new URL('../web/src/ui/theme-model.ts', import.meta.url).href)) as ModelModule;
const TC = (await import(
  new URL('../web/src/ui/term-colours-model.ts', import.meta.url).href
)) as TcModule;
const P = (await import(new URL('../web/src/ui/term-colours.ts', import.meta.url).href)) as PageModule;

const STORAGE_KEY = 'ai-sm:theme:v1';
const NOCTURNE: TermPair = { ground: T.GROUNDS[0]?.hex as string, text: T.RAMPS[0]?.cmd as string };
/** "Amber on espresso" — PRESETS[2] = GROUNDS[9] + RAMPS[2]. */
const AMBER: TermPair = { ground: T.GROUNDS[9]?.hex as string, text: T.RAMPS[2]?.cmd as string };
const AMBER_COLOURS = {
  ground: '#161010',
  cmd: '#ffe9c4',
  out: '#e8b24a',
  dim: '#8a6a2f',
};
/** "Phosphor on void" — PRESETS[1] = GROUNDS[1] + RAMPS[1]. */
const PHOSPHOR: TermPair = { ground: T.GROUNDS[1]?.hex as string, text: T.RAMPS[1]?.cmd as string };

// ---------------------------------------------------------------------------
// Driving helpers — conditions, never clocks
// ---------------------------------------------------------------------------

const tick = (): Promise<void> => new Promise<void>((r) => setImmediate(r));

/** Turn the event loop until `cond` holds, or fail — no sleep, no wall clock. */
async function until(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (cond()) return;
    await tick();
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** Fire (and disarm) every timer the DOM double recorded; answers how many. */
function runTimers(): number {
  const armed = [...dom.win.timers];
  dom.win.timers.length = 0;
  for (const t of armed) t.fn();
  return armed.length;
}

/**
 * A clean slate: no override on :root, an empty (or seeded) cache, no armed
 * timer, no recorded request. `serverBag` is what GET /api/prefs answers.
 */
function reset(opts: { cache?: unknown; serverBag?: Record<string, unknown> } = {}): void {
  ops.length = 0;
  rootBag.clear();
  dom.win.timers.length = 0;
  calls = [];
  held.length = 0;
  gatePut = false;
  failNextPut = false;
  H.refreshes = 0;
  dom.storage.clear();
  if (opts.cache !== undefined) dom.storage.setItem(STORAGE_KEY, JSON.stringify(opts.cache));
  bag = opts.serverBag ?? {};
}

/** What the local cache holds, as the exact JSON string on disk. */
function cached(): string | null {
  return dom.storage.getItem(STORAGE_KEY);
}

// ===========================================================================
// Boot: what the first paint does
// ===========================================================================

test('an empty cache and no server opinion write NOTHING on :root — and still refresh the terminals', () => {
  reset();
  const ctl = TH.initTheme(undefined);
  assert.deepEqual(
    ops,
    REMOVES,
    'the default pair is the ABSENCE of an override: six removeProperty calls and not one write',
  );
  assert.deepEqual(ops.filter((o) => o.startsWith('set ')), [], 'zero properties written');
  assert.deepEqual(live(), []);
  assert.equal(H.refreshes, 1, 'refreshAllTerminalThemes runs anyway — a terminal reads the tokens');
  assert.deepEqual(ctl.current(), NOCTURNE);
  assert.deepEqual([...calls], [], 'boot reconciliation never writes to the server');
});

test('a non-Nocturne pair writes EXACTLY the six properties, with the preset ramp coloursOf derives', () => {
  reset();
  const ctl = TH.initTheme({ theme: AMBER });
  assert.deepEqual(AMBER, { ground: '#161010', text: '#ffe9c4' }, 'the pair under test, spelled out');
  assert.deepEqual(TC.presetColours('amber'), AMBER_COLOURS, 'the page and theme.ts share one derivation');
  // The empty cache paints first (Nocturne = the six removals), then the server
  // pair corrects it — boot order, D4.
  assert.deepEqual(ops, [
    ...REMOVES,
    'set --term-bg=#161010',
    'set --xt-fg=#e8b24a',
    'set --xt-white=#e8b24a',
    'set --xt-bright-white=#ffe9c4',
    'set --xt-cursor=#ffe9c4',
    'set --xt-bright-black=#8a6a2f',
  ]);
  assert.equal(ops.length, 12, 'six properties written — no seventh');
  assert.deepEqual(ctl.current(), AMBER);
  assert.equal(H.refreshes, 2, 'the cache paint and the server correction, both before any terminal exists');
});

test('a CUSTOM pair takes cmd = out = the text colour, and dim = text pulled 55% towards the ground', () => {
  reset();
  TH.initTheme({ theme: { ground: '#101010', text: '#ff8800' } });
  assert.equal(TC.mixHex('#ff8800', '#101010', 0.55), '#7c4609', 'the derivation, from the model itself');
  assert.deepEqual(ops, [
    ...REMOVES,
    'set --term-bg=#101010',
    'set --xt-fg=#ff8800',
    'set --xt-white=#ff8800',
    'set --xt-bright-white=#ff8800',
    'set --xt-cursor=#ff8800',
    'set --xt-bright-black=#7c4609',
  ]);
});

test('going back to Nocturne REMOVES all six — the default is tokens.css, never a copy of it', async () => {
  reset();
  const ctl = TH.initTheme({ theme: AMBER });
  ops.length = 0;
  ctl.apply(NOCTURNE);
  assert.deepEqual(ops, REMOVES, 'six removeProperty calls, no setProperty among them');
  assert.deepEqual(live(), [], 'nothing is left in force on :root');
  assert.equal(H.refreshes, 3, 'the two boot paints + the change, each repainting every live terminal');
  runTimers();
  await ctl.flush();
});

test('an UNREADABLE cache falls back to Nocturne instead of throwing (bad JSON, an array, a string)', () => {
  for (const junk of ['{not json', '[1,2,3]', '"amber"', 'null', '{"ground":"red","text":42}']) {
    reset();
    dom.storage.setItem(STORAGE_KEY, junk);
    const ctl = TH.initTheme(undefined);
    assert.deepEqual(ctl.current(), NOCTURNE, `cache ${junk}`);
    assert.deepEqual(ops, REMOVES, `cache ${junk}: the default writes nothing, it removes`);
  }
});

test('a HALF-readable cache keeps the member it can read (per-member clamp)', () => {
  reset({ cache: { ground: '#161010', text: 'nope' } });
  const ctl = TH.initTheme(undefined);
  assert.deepEqual(ctl.current(), { ground: '#161010', text: NOCTURNE.text });
  assert.deepEqual(ops, sets({ ground: '#161010', cmd: '#e9e9ed', out: '#e9e9ed', dim: TC.mixHex('#e9e9ed', '#161010', 0.55) }));
});

test('a localStorage that throws (a locked-down browser profile) costs the cache, never the colours', async () => {
  reset();
  const realStorage = (globalThis as unknown as Record<string, unknown>).localStorage;
  (globalThis as unknown as Record<string, unknown>).localStorage = {
    getItem(): string {
      throw new Error('SecurityError: storage is disabled');
    },
    setItem(): void {
      throw new Error('QuotaExceededError');
    },
    removeItem(): void {},
    clear(): void {},
  };
  try {
    const ctl = TH.initTheme({ theme: AMBER });
    assert.deepEqual(ctl.current(), AMBER, 'the server pair still paints');
    assert.deepEqual(ops, [...REMOVES, ...sets(AMBER_COLOURS)]);
    ops.length = 0;
    ctl.apply(PHOSPHOR);
    assert.deepEqual(ops.length, 6, 'and a later change still paints');
    await ctl.flush();
    assert.deepEqual(puts(), [{ ground: PHOSPHOR.ground, text: PHOSPHOR.text }], 'and is still persisted server-side');
  } finally {
    (globalThis as unknown as Record<string, unknown>).localStorage = realStorage;
  }
});

// ===========================================================================
// The server copy: which value wins at boot
// ===========================================================================

test('a LEGACY server bag {bg:9,fg:2,scan:true} paints the hexes those indexes meant, and rewrites the cache as the v2 pair WITHOUT scan', () => {
  reset();
  const ctl = TH.initTheme({ theme: { bg: 9, fg: 2, scan: true } });
  assert.deepEqual(ops, [
    ...REMOVES,
    'set --term-bg=#161010',
    'set --xt-fg=#e8b24a',
    'set --xt-white=#e8b24a',
    'set --xt-bright-white=#ffe9c4',
    'set --xt-cursor=#ffe9c4',
    'set --xt-bright-black=#8a6a2f',
  ]);
  assert.deepEqual(ctl.current(), AMBER);
  assert.equal(cached(), '{"ground":"#161010","text":"#ffe9c4"}', 'the cache is corrected, in the v2 shape');
  assert.equal(cached()?.includes('scan'), false, 'scan leaves the protocol with B9');
  assert.deepEqual([...calls], [], 'correcting the cache is not a reason to write the server');
});

test('a valid server pair BEATS the local cache — amber cached, Nocturne stored: the overrides go', () => {
  reset({ cache: AMBER });
  const ctl = TH.initTheme({ theme: NOCTURNE });
  assert.deepEqual(
    ops,
    [...sets(AMBER_COLOURS), ...REMOVES],
    'the cache paints first (no flash of default), then the server value corrects it',
  );
  assert.deepEqual(live(), []);
  assert.deepEqual(ctl.current(), NOCTURNE);
  assert.equal(cached(), '{"ground":"#0b0d14","text":"#e9e9ed"}');
});

test('a server pair that EQUALS the cache repaints nothing twice (no second apply)', () => {
  reset({ cache: AMBER });
  TH.initTheme({ theme: { ground: '#161010', text: '#FFE9C4' } });
  assert.deepEqual(ops, sets(AMBER_COLOURS), 'one paint — the upper-case hex is the same pair');
  assert.equal(H.refreshes, 1);
});

test('server GARBAGE is no opinion at all: the local cache stands', () => {
  for (const theme of ['x', {}, [], null, 42, { scan: true }, { bg: 99, fg: -1 }, { ground: 'blue' }]) {
    reset({ cache: AMBER });
    const ctl = TH.initTheme({ theme } as Record<string, unknown>);
    assert.deepEqual(ctl.current(), AMBER, `theme: ${JSON.stringify(theme)}`);
    assert.deepEqual(ops, sets(AMBER_COLOURS), `theme: ${JSON.stringify(theme)} — one paint, the cache's`);
    assert.equal(cached(), '{"ground":"#161010","text":"#ffe9c4"}', 'and the cache is not overwritten');
  }
});

test('a bag with no theme key, an absent bag and a null bag all leave the cache alone', () => {
  for (const prefs of [{}, undefined, null, { statusLine: { enabled: true } }]) {
    reset({ cache: AMBER });
    const ctl = TH.initTheme(prefs as Record<string, unknown> | undefined);
    assert.deepEqual(ctl.current(), AMBER, `prefs: ${JSON.stringify(prefs)}`);
  }
});

// ===========================================================================
// The write policy: debounced, serialised, flushable
// ===========================================================================

test('a burst of three applies: localStorage at once each time, ONE timer, ONE PUT with the LAST pair — and the merge keeps the other bag keys', async () => {
  const other = {
    statusLine: { enabled: true, model: true },
    behaviour: { confirmClose: false },
    tools: ['claude', 'gemini'],
  };
  reset({ serverBag: { ...other } });
  const ctl = TH.initTheme(undefined);

  ctl.apply(PHOSPHOR);
  assert.equal(cached(), `{"ground":"${PHOSPHOR.ground}","text":"${PHOSPHOR.text}"}`, 'written at once');
  ctl.apply({ ground: '#0a1220', text: '#e8f4ff' });
  assert.equal(cached(), '{"ground":"#0a1220","text":"#e8f4ff"}');
  ctl.apply(AMBER);
  assert.equal(cached(), '{"ground":"#161010","text":"#ffe9c4"}', 'the cache never lags a change');

  assert.equal(dom.win.timers.length, 1, 'ONE trailing timer for three changes, not three');
  assert.equal(dom.win.timers[0]?.ms, 300, 'the debounce is ~300ms (D4)');
  assert.deepEqual([...calls], [], 'nothing has reached the server while the timer is armed');

  assert.equal(runTimers(), 1);
  await until('the debounced write lands', () => puts().length === 1);
  await ctl.flush();

  assert.deepEqual(
    calls.map((c) => `${c.method} ${c.path}`),
    ['GET /api/prefs', 'PUT /api/prefs'],
    'one read-modify-write, not three',
  );
  assert.deepEqual(calls[1]?.body, {
    statusLine: { enabled: true, model: true },
    behaviour: { confirmClose: false },
    tools: ['claude', 'gemini'],
    theme: { ground: '#161010', text: '#ffe9c4' },
  });
});

test('a change DURING the in-flight write costs exactly ONE follow-up, carrying the latest pair', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  gatePut = true;

  ctl.apply(PHOSPHOR);
  runTimers();
  await until('the first write reaches its PUT', () => held.length === 1);
  assert.deepEqual(puts(), [{ ground: PHOSPHOR.ground, text: PHOSPHOR.text }], 'sent, and hanging');
  assert.deepEqual({ ...bag }, {}, 'the server has not taken it yet — this write is in flight');

  ctl.apply({ ground: '#0a1220', text: '#e8f4ff' });
  ctl.apply(AMBER);
  assert.equal(runTimers(), 1, 'the two mid-flight changes share one timer');
  assert.equal(held.length, 1, 'and firing it starts NO second request while one is in flight');
  assert.equal(puts().length, 1, 'still exactly one request, as D4 requires');

  releasePuts();
  await ctl.flush();
  assert.deepEqual(
    puts(),
    [
      { ground: PHOSPHOR.ground, text: PHOSPHOR.text },
      { ground: '#161010', text: '#ffe9c4' },
    ],
    'two writes total: the one in flight, then ONE follow-up with the latest pair',
  );
});

test('flush() sends a pending write NOW and disarms the timer (the dialog closing is the deadline)', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  ctl.apply(AMBER);
  assert.equal(dom.win.timers.length, 1);
  assert.deepEqual([...calls], [], 'the 300ms has not passed');

  await ctl.flush();
  assert.deepEqual(puts(), [{ ground: '#161010', text: '#ffe9c4' }], 'flush did not wait for the clock');
  assert.deepEqual(dom.win.timers, [], 'and it left no armed timer behind');

  assert.equal(runTimers(), 0, 'nothing is left to fire — a flushed write is never sent twice');
  await ctl.flush();
  assert.equal(puts().length, 1);
});

test('flush() with nothing pending resolves and sends nothing', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  await assert.doesNotReject(ctl.flush());
  assert.deepEqual([...calls], [], 'no request at all');
});

test('a rejected PUT never reaches the caller — and the next change still gets written', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  failNextPut = true;
  ctl.apply(AMBER);
  await assert.doesNotReject(ctl.flush(), 'a failed server write is non-fatal: the local copy already holds it');
  assert.equal(cached(), '{"ground":"#161010","text":"#ffe9c4"}');
  assert.equal(puts().length, 1, 'the failed PUT was attempted');

  ctl.apply(PHOSPHOR);
  await ctl.flush();
  assert.deepEqual(puts().at(-1), { ground: PHOSPHOR.ground, text: PHOSPHOR.text }, 'the writer is not stuck');
});

test('applying the pair already in force is a NO-OP: no repaint, no timer, no PUT', async () => {
  reset({ cache: AMBER });
  const ctl = TH.initTheme(undefined);
  ops.length = 0;
  H.refreshes = 0;

  ctl.apply({ ...AMBER });
  ctl.apply({ ground: '#161010', text: '#FFE9C4' }); // the same pair, spelled loudly
  assert.deepEqual(ops, [], 'nothing was written to :root');
  assert.equal(H.refreshes, 0, 'no terminal was repainted');
  assert.deepEqual(dom.win.timers, [], 'no server write was scheduled');

  ctl.apply(PHOSPHOR);
  assert.equal(dom.win.timers.length, 1, 'non-vacuity: a REAL change does schedule one');
  await ctl.flush();
});

test('apply CLAMPS what it is handed: junk members fall back to Nocturne instead of painting `undefined`', async () => {
  reset({ cache: AMBER });
  const ctl = TH.initTheme(undefined);
  ops.length = 0;
  ctl.apply({ ground: 'chartreuse', text: '#fafafa' });
  assert.deepEqual(ctl.current(), { ground: NOCTURNE.ground, text: '#fafafa' });
  assert.deepEqual(
    ops,
    sets({
      ground: '#0b0d14',
      cmd: '#fafafa',
      out: '#fafafa',
      dim: TC.mixHex('#fafafa', '#0b0d14', 0.55),
    }),
  );
  await ctl.flush();
  assert.deepEqual(puts(), [{ ground: '#0b0d14', text: '#fafafa' }], 'and the clamped pair is what is stored');
});

// ===========================================================================
// adopt(): the server's own pair, taken without being written back
// ===========================================================================

test('adopt() paints and caches a pair that came FROM the server — no timer, no PUT', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  ops.length = 0;
  H.refreshes = 0;

  ctl.adopt(AMBER);
  assert.deepEqual(ops, sets(AMBER_COLOURS), 'the six properties are written, exactly as apply writes them');
  assert.equal(H.refreshes, 1, 'and every live terminal is repainted');
  assert.equal(cached(), '{"ground":"#161010","text":"#ffe9c4"}', 'the local cache follows');
  assert.deepEqual(ctl.current(), AMBER, 'it is the pair in force now');
  assert.deepEqual(dom.win.timers, [], 'NOTHING is scheduled: the server already has this pair');
  assert.deepEqual([...calls], [], 'and nothing is sent');
  await ctl.flush();
  assert.deepEqual([...calls], [], 'not even a flush has anything to send');
});

test('adopt() is a NO-OP while a write of ours is scheduled — a stale answer never reverts a fresh choice', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  ctl.apply(PHOSPHOR); // the user just picked this; the 300ms timer is armed
  ops.length = 0;

  ctl.adopt(AMBER); // the panel's re-read, answered with what was on disk BEFORE
  assert.deepEqual(ops, [], 'nothing was repainted');
  assert.deepEqual(ctl.current(), PHOSPHOR, 'the choice stands');
  assert.equal(cached(), `{"ground":"${PHOSPHOR.ground}","text":"${PHOSPHOR.text}"}`, 'and the cache with it');

  await ctl.flush();
  assert.deepEqual(puts(), [{ ground: PHOSPHOR.ground, text: PHOSPHOR.text }], 'the durable copy is the choice');
});

test('adopt() is a NO-OP while a write of ours is IN FLIGHT, and works again once it lands', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  gatePut = true;
  ctl.apply(PHOSPHOR);
  runTimers();
  await until('the write reaches its PUT', () => held.length === 1);
  ops.length = 0;

  ctl.adopt(AMBER);
  assert.deepEqual(ops, [], 'the in-flight PUT is newer than the answer being adopted');
  assert.deepEqual(ctl.current(), PHOSPHOR);

  releasePuts();
  await ctl.flush();
  ops.length = 0;
  ctl.adopt(AMBER); // another window really did change it, and nothing of ours is left
  assert.deepEqual(ops, sets(AMBER_COLOURS), 'with the write settled, the answer is taken');
  assert.deepEqual(dom.win.timers, [], 'still without scheduling a write of our own');
  assert.deepEqual(puts(), [{ ground: PHOSPHOR.ground, text: PHOSPHOR.text }], 'one PUT total: ours');
});

test('adopt() clamps like apply, and adopting the pair already in force repaints nothing', async () => {
  reset({ cache: AMBER });
  const ctl = TH.initTheme(undefined);
  ops.length = 0;
  H.refreshes = 0;

  ctl.adopt({ ground: '#161010', text: '#FFE9C4' }); // the same pair, spelled loudly
  assert.deepEqual(ops, [], 'no repaint');
  assert.equal(H.refreshes, 0);

  ctl.adopt({ ground: 'chartreuse', text: '#fafafa' });
  assert.deepEqual(ctl.current(), { ground: NOCTURNE.ground, text: '#fafafa' }, 'junk falls back to Nocturne');
  assert.deepEqual([...calls], [], 'and still nothing is written back');
});

// ===========================================================================
// The page → control wire (D5), against the REAL control
// ===========================================================================

function pageBits(root: FakeElement): {
  cards: FakeElement[];
  groundHex: FakeElement;
  textHex: FakeElement;
  prev: FakeElement;
} {
  return {
    cards: byClass(root, 'sg-tccard'),
    groundHex: byClass(root, 'sg-tchex')[0] as FakeElement,
    textHex: byClass(root, 'sg-tchex')[1] as FakeElement,
    prev: byClass(root, 'sg-tcprev')[0] as FakeElement,
  };
}

test('a card click on the page paints :root through the control and persists that preset’s own pair', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  const page = P.buildTermColours('sg-tab-colours', ctl);
  dom.body.append(page.root);
  const { cards } = pageBits(page.root);
  const amberCard = cards.find((c) => c.textContent?.includes('Amber on espresso'));
  assert.ok(amberCard !== undefined, 'the Amber on espresso card is on the page');

  ops.length = 0;
  amberCard.click();
  assert.deepEqual(ops, sets(AMBER_COLOURS), 'the click reached :root, with the card’s own colours');
  assert.deepEqual(ctl.current(), AMBER);
  assert.equal(cached(), '{"ground":"#161010","text":"#ffe9c4"}');

  await ctl.flush();
  assert.deepEqual(puts(), [{ ground: '#161010', text: '#ffe9c4' }]);
  page.root.remove();
});

test('a valid hex typed on the page reaches :root; an incomplete one changes nothing at all', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  const page = P.buildTermColours('sg-tab-colours', ctl);
  dom.body.append(page.root);
  const { groundHex, textHex } = pageBits(page.root);

  ops.length = 0;
  for (const half of ['#12345', '#', 'abcdef', '#12345g']) {
    groundHex.value = half;
    dispatch(groundHex, 'input');
    assert.deepEqual(ops, [], `an invalid hex must not paint: ${half}`);
    assert.deepEqual(dom.win.timers, [], `an invalid hex must not schedule a write: ${half}`);
    assert.deepEqual(ctl.current(), NOCTURNE);
  }

  groundHex.value = '#123456';
  dispatch(groundHex, 'input');
  assert.deepEqual(ctl.current(), { ground: '#123456', text: NOCTURNE.text });
  textHex.value = '#ffe9c4';
  dispatch(textHex, 'input');
  assert.deepEqual(ctl.current(), { ground: '#123456', text: '#ffe9c4' });
  assert.deepEqual(ops.slice(-6), [
    'set --term-bg=#123456',
    'set --xt-fg=#ffe9c4',
    'set --xt-white=#ffe9c4',
    'set --xt-bright-white=#ffe9c4',
    'set --xt-cursor=#ffe9c4',
    `set --xt-bright-black=${TC.mixHex('#ffe9c4', '#123456', 0.55)}`,
  ]);
  assert.equal(TC.mixHex('#ffe9c4', '#123456', 0.55), '#7d8588', 'the derived dim step, spelled out');

  await ctl.flush();
  assert.deepEqual(puts().at(-1), { ground: '#123456', text: '#ffe9c4' }, 'one PUT for the burst of two');
  assert.equal(puts().length, 1);
  page.root.remove();
});

test('sync() re-seeds the page from the control and writes NOTHING back (another window chose)', async () => {
  reset();
  const ctl = TH.initTheme(undefined);
  const page = P.buildTermColours('sg-tab-colours', ctl);
  dom.body.append(page.root);
  const { cards, groundHex, textHex, prev } = pageBits(page.root);

  // The control moved underneath the page, as settings.ts's re-read does it.
  ctl.apply(AMBER);
  await ctl.flush();
  const before = puts().length;
  ops.length = 0;

  page.sync();
  assert.equal(prev.style['background-color'], '#161010', 'the preview follows');
  assert.equal(groundHex.value, '#161010');
  assert.equal(textHex.value, '#ffe9c4');
  assert.equal(
    cards.find((c) => c.getAttribute('aria-checked') === 'true')?.textContent?.includes('Amber'),
    true,
    'and so does the chosen card',
  );
  assert.deepEqual(ops, [], 'a sync is not a change: it must not repaint :root');
  assert.deepEqual(dom.win.timers, [], 'nor schedule a server write');
  assert.equal(puts().length, before, 'nor send one');
  page.root.remove();
});

test('the page hands the control the pair and nothing else (a recording double sees exact objects)', () => {
  const applied: TermPair[] = [];
  let held2: TermPair = { ...NOCTURNE };
  const rec = {
    apply(next: TermPair): void {
      applied.push({ ...next });
      held2 = { ...next };
    },
    current(): TermPair {
      return { ...held2 };
    },
  };
  reset();
  const page = P.buildTermColours('sg-tab-colours', rec);
  dom.body.append(page.root);
  assert.deepEqual(applied, [], 'building the page is not a change');

  const { cards, groundHex } = pageBits(page.root);
  cards.find((c) => c.textContent?.includes('Phosphor on void'))?.click();
  groundHex.value = '#010203';
  dispatch(groundHex, 'input');
  assert.deepEqual(applied, [
    { ground: PHOSPHOR.ground, text: PHOSPHOR.text },
    { ground: '#010203', text: PHOSPHOR.text },
  ]);
  assert.deepEqual(ops, [], 'the page itself never touches :root — ui/theme.ts does');
  assert.deepEqual(dom.win.timers, [], 'and it arms no timer of its own');
  page.root.remove();
});

// ===========================================================================
// D3 — which surfaces follow the themed ground, in app.css
// ===========================================================================

const APP_CSS = readFileSync(new URL('../web/src/styles/app.css', import.meta.url), 'utf8');
/** Comments carry the word `--term-bg` in prose; only DECLARATIONS count here. */
const APP_RULES = APP_CSS.replace(/\/\*[\s\S]*?\*\//g, '');

/** Every `selector { ... }` block whose body contains `needle`. */
function selectorsReading(needle: string): string[] {
  const out: string[] = [];
  for (const m of APP_RULES.matchAll(/(^|\n)([^{}@][^{}]*?)\{([^{}]*)\}/g)) {
    if ((m[3] as string).includes(needle)) out.push((m[2] as string).trim().replace(/\s+/g, ' '));
  }
  return out;
}

test('D3: --term-bg is read by the TERMINAL surfaces only — the whole themed set, named', () => {
  assert.deepEqual(
    selectorsReading('var(--term-bg)'),
    ['.pane-body', '.term-host .xterm, .term-host .xterm .xterm-viewport'],
    'a new reader of --term-bg would take a user’s custom terminal ground somewhere it was never chosen (open decision 10c)',
  );
  // Non-vacuity: the scanner finds the twin's readers too, and they are others.
  assert.ok(
    selectorsReading('var(--color-term)').length >= 4,
    'non-vacuity: the unthemed twin has its own readers',
  );
});

test('D3: the editor chip, the editor/diff pane bodies and the diff itself read --color-term, the UNTHEMED twin', () => {
  for (const [sel, why] of [
    ['.pane-tab.is-on', 'the active file chip belongs to an editor pane, whose body is app ink'],
    ['.pane-file,\n.pane-diff', 'the editor and diff pane bodies paint their own ground'],
    ['.diff-body', 'a diff’s red and green are app ink and never follow the terminal'],
  ] as const) {
    const rule = new RegExp(`(^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(APP_CSS);
    assert.ok(rule !== null, `app.css must still carry a ${sel} rule`);
    assert.match((rule[2] as string), /background:\s*var\(--color-term\)/, `${sel}: ${why}`);
    assert.equal(
      (rule[2] as string).includes('var(--term-bg)'),
      false,
      `${sel} must not follow the themed ground: ${why}`,
    );
  }
});

test('D3: an EDITOR pane’s body is kept off the themed ground too (a pane with no drawable tab is a BARE .pane-body)', () => {
  const rule = /(^|\n)\.pane\.is-editor \.pane-body\s*\{([^}]*)\}/.exec(APP_CSS);
  assert.ok(rule !== null, 'app.css must carry the editor-pane body rule');
  assert.match(rule[2] as string, /background:\s*var\(--color-term\)/, 'the UNTHEMED twin, like .pane-file');
  // And the class it hangs on is kept in step with the payload by ui/panes.ts.
  const PANES = readFileSync(new URL('../web/src/ui/panes.ts', import.meta.url), 'utf8');
  assert.match(PANES, /classList\.add\('is-editor'\)/, 'buildEditorPane marks the card');
  assert.match(PANES, /classList\.remove\('is-editor'\)/, 'teardown takes it off again');
});

/**
 * The body of a top-level `function <name>(...)` in a source file, brace-matched.
 * ui/panes.ts reaches @xterm/xterm and cannot be imported under `node --test`,
 * so WHERE a statement sits is the strongest claim available — and it is the
 * claim that matters: a mutation probe (2026-09-22) showed a bare
 * `assert.match(PANES, /classList\.remove\('is-editor'\)/)` survives the call
 * being moved into a branch that can never run.
 */
function bodyOf(src: string, signature: string): string {
  const start = src.indexOf(signature);
  assert.notEqual(start, -1, `no such function: ${signature}`);
  let depth = 0;
  for (let i = start + signature.length - 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail(`unbalanced braces after ${signature}`);
}

test('D3: `is-editor` goes on in buildEditorPane and off in teardown — unconditionally, in both', () => {
  const PANES = readFileSync(new URL('../web/src/ui/panes.ts', import.meta.url), 'utf8');
  const build = bodyOf(PANES, 'function buildEditorPane(s: Slot, slot: st.EditorSlot, index: number): void {');
  const tear = bodyOf(PANES, 'function teardown(s: Slot): void {');
  // A statement at the function's own indentation: not inside an `if`, a loop
  // or a callback, so it runs on EVERY build and EVERY teardown.
  assert.match(build, /\n {2}s\.root\.classList\.add\('is-editor'\);\n/, 'buildEditorPane marks the card, always');
  assert.match(tear, /\n {2}s\.root\.classList\.remove\('is-editor'\);\n/, 'teardown takes it off, always');
  assert.equal(build.includes("classList.remove('is-editor')"), false, 'and the two do not cancel each other out');
  // The removal happens BEFORE teardown's early return, or a pane that never
  // had a payload would keep the class.
  const ret = tear.indexOf('if (pay === null) return;');
  assert.notEqual(ret, -1, 'non-vacuity: teardown still has its early return');
  assert.ok(tear.indexOf("classList.remove('is-editor')") < ret, 'the class comes off before any early return');
  // Nobody else in the app touches the class — CSS reads it, panes.ts owns it.
  assert.equal([...PANES.matchAll(/'is-editor'/g)].length, 2, 'exactly two mentions: the add and the remove');
});

test('D3: the pane status bar takes the THEME’s own two ink steps, so it stays readable on any ground', () => {
  assert.match(APP_CSS, /\.pane-status-k\s*\{[^}]*color:\s*var\(--xt-bright-black\)/);
  assert.match(APP_CSS, /\.pane-status-v\s*\{[^}]*color:\s*var\(--xt-fg\)/);
  for (const dead of [
    /\.pane-status-k\s*\{[^}]*--color-neutral-600/,
    /\.pane-status-v\s*\{[^}]*--color-neutral-300/,
  ]) {
    assert.equal(dead.test(APP_CSS), false, 'the app neutrals are gone from the bar (they do not follow a light ground)');
  }
  // The semantic pair stays semantic (open decision 10c).
  assert.match(APP_CSS, /\.pane-status-v\.is-danger\s*\{[^}]*color:\s*var\(--color-danger\)/);
});

test('D3: the `.sg-note` honesty-line rule is gone with the last mock page', () => {
  assert.equal(/(^|\n)\.sg-note\s*\{/.test(APP_CSS), false, 'no rule');
  assert.equal(APP_CSS.includes('sg-note'), false, 'and no mention left behind');
  // Non-vacuity: the sibling Settings classes the rule sat among are still here.
  for (const kept of ['.sg-lead', '.sg-lb', '.sg-tcprev']) {
    assert.ok(APP_CSS.includes(kept), `non-vacuity: ${kept} must still exist`);
  }
});

// ===========================================================================
// The boot wire in main.ts (source pin — there is no DOM boot here)
// ===========================================================================

const MAIN_TS = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');

test('main.ts builds the theme BEFORE the settings panel and long before the first terminal', () => {
  const at = (needle: string): number => {
    const i = MAIN_TS.indexOf(needle);
    assert.notEqual(i, -1, `main.ts must contain ${needle}`);
    return i;
  };
  // Each index is asserted to EXIST first: `-1 < x` would make an ordering
  // check pass for a call that was deleted.
  const theme = at('const theme = initTheme(prefs);');
  assert.ok(theme < at('initSettings(modalHost, settingsBtn, { repaintStatus, theme })'), 'before the panel it is handed to');
  assert.ok(theme < at('initPanes('), 'before anything that can build a terminal');
  assert.ok(at('initStatusLine(prefs?.statusLine)') < theme, 'inside buildShell’s boot block, after the status line');
  assert.ok(at('function buildShell') < theme, 'in buildShell, not in boot()');
});
