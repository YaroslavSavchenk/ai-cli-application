/**
 * Shared setup for `tests/ui/ui-b9-theme*.test.ts` (Nocturne B9,
 * `.claude/plans/nocturne/PLAN-B9.md`): the DOM double with `:root` as a
 * RECORDING double (every `setProperty`/`removeProperty`, in order), the REAL
 * `web/src/api.ts` on a fetch double that serves `GET/PUT /api/prefs`, module
 * stubs for `ui/theme.ts`'s `./terminal.ts` (xterm, unimportable under
 * `node --test`) and `../log.ts` (and `api.ts`'s own `./log.ts`) through
 * `registerHooks`, then the REAL `ui/theme.ts`, `ui/theme-model.ts`,
 * `ui/term-colours-model.ts` and `ui/term-colours.ts`; plus the presets and
 * the condition-driven helpers (`until`, `runTimers`, `reset`). Not a test.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { installDom, type FakeElement } from './fake-dom.ts';
import { nextImmediate, jsonResponse as res } from './helpers.ts';

export const dom = installDom();

// ---------------------------------------------------------------------------
// :root, recording
// ---------------------------------------------------------------------------

/** Every operation ui/theme.ts performed on `:root`, in order. */
export const ops: string[] = [];
export const rootBag = new Map<string, string>();
export const htmlEl = dom.doc.createElement('html');
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
export const SLOTS = [
  '--term-bg',
  '--xt-fg',
  '--xt-white',
  '--xt-bright-white',
  '--xt-cursor',
  '--xt-bright-black',
] as const;

export const REMOVES = SLOTS.map((s) => `rm ${s}`);

/** What an apply of a pair whose four colours are these must have written. */
export function sets(c: { ground: string; cmd: string; out: string; dim: string }): string[] {
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
export function live(): string[] {
  return SLOTS.filter((s) => rootBag.has(s)).map((s) => `${s}=${rootBag.get(s) as string}`);
}

// ---------------------------------------------------------------------------
// The server: the REAL api.ts on a fetch double
// ---------------------------------------------------------------------------

export interface Call {
  path: string;
  method: string;
  body: unknown;
}

export let calls: Call[] = [];
/** What `GET /api/prefs` answers — and what a PUT replaces, as the server does. */
export let bag: Record<string, unknown> = {};
export const held: (() => void)[] = [];

/**
 * The two PUT switches — `gatePut`: while true, every PUT hangs until
 * `releasePuts()` (an in-flight write); `failNextPut`: one PUT fails with a
 * 500, the way a backend restart mid-write would. They are plain `let`s in the
 * ONE test file whose tests flip them (`tests/ui/ui-b9-theme-writes.test.ts`;
 * an imported binding cannot be assigned), handed in through `putSwitches()`.
 * Every other file leaves both off.
 */
export interface PutSwitches {
  gate(): boolean;
  failNext(): boolean;
  set(to: { gatePut?: boolean; failNextPut?: boolean }): void;
}
let sw: PutSwitches = { gate: () => false, failNext: () => false, set: () => {} };
export function putSwitches(s: PutSwitches): void {
  sw = s;
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
  if (sw.gate()) {
    await new Promise<void>((r) => {
      held.push(r);
    });
  }
  if (sw.failNext()) {
    sw.set({ failNextPut: false });
    return res({ error: 'prefs write refused' }, false);
  }
  bag = body as Record<string, unknown>;
  return res({ ok: true }, true);
};

export function releasePuts(): void {
  sw.set({ gatePut: false });
  for (const r of held.splice(0)) r();
}

/** The `theme` member of every PUT body, in order. */
export function puts(): unknown[] {
  return calls.filter((c) => c.method === 'PUT').map((c) => (c.body as Record<string, unknown>).theme);
}

// ---------------------------------------------------------------------------
// Module stubs: terminal.ts (xterm) and log.ts, and api.ts's log.ts
// ---------------------------------------------------------------------------

export const H = { refreshes: 0 };
(globalThis as unknown as Record<string, unknown>).__b9 = H;

export const STUB: Record<string, string> = {
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

export interface TermPair {
  ground: string;
  text: string;
}
export interface ThemeControl {
  apply(next: TermPair): void;
  adopt(next: TermPair): void;
  current(): TermPair;
  flush(): Promise<void>;
}
export interface ThemeModule {
  initTheme(serverPrefs?: Record<string, unknown>): ThemeControl;
}
export interface ModelModule {
  GROUNDS: { name: string; hex: string }[];
  RAMPS: { name: string; cmd: string; out: string; dim: string }[];
  NOCTURNE: TermPair;
  clampTheme(raw: unknown): TermPair;
}
export interface TcModule {
  mixHex(a: string, b: string, t: number): string;
  presetColours(id: string): { ground: string; cmd: string; out: string; dim: string };
}
export interface PageModule {
  buildTermColours(
    titleId: string,
    ctl: { apply(next: TermPair): void; current(): TermPair },
  ): { root: FakeElement; sync(): void };
}

export const TH = (await import(new URL('../../web/src/ui/theme.ts', import.meta.url).href)) as ThemeModule;
export const T = (await import(new URL('../../web/src/ui/theme-model.ts', import.meta.url).href)) as ModelModule;
export const TC = (await import(
  new URL('../../web/src/ui/term-colours-model.ts', import.meta.url).href
)) as TcModule;
export const P = (await import(new URL('../../web/src/ui/term-colours.ts', import.meta.url).href)) as PageModule;

export const STORAGE_KEY = 'ai-sm:theme:v1';
export const NOCTURNE: TermPair = { ground: T.GROUNDS[0]?.hex as string, text: T.RAMPS[0]?.cmd as string };
/** "Amber on espresso" — PRESETS[2] = GROUNDS[9] + RAMPS[2]. */
export const AMBER: TermPair = { ground: T.GROUNDS[9]?.hex as string, text: T.RAMPS[2]?.cmd as string };
export const AMBER_COLOURS = {
  ground: '#161010',
  cmd: '#ffe9c4',
  out: '#e8b24a',
  dim: '#8a6a2f',
};
/** "Phosphor on void" — PRESETS[1] = GROUNDS[1] + RAMPS[1]. */
export const PHOSPHOR: TermPair = { ground: T.GROUNDS[1]?.hex as string, text: T.RAMPS[1]?.cmd as string };

// ---------------------------------------------------------------------------
// Driving helpers — conditions, never clocks
// ---------------------------------------------------------------------------

/** Turn the event loop until `cond` holds, or fail — no sleep, no wall clock. */
export async function until(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i += 1) {
    if (cond()) return;
    await nextImmediate();
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** Fire (and disarm) every timer the DOM double recorded; answers how many. */
export function runTimers(): number {
  const armed = [...dom.win.timers];
  dom.win.timers.length = 0;
  for (const t of armed) t.fn();
  return armed.length;
}

/**
 * A clean slate: no override on :root, an empty (or seeded) cache, no armed
 * timer, no recorded request. `serverBag` is what GET /api/prefs answers.
 */
export function reset(opts: { cache?: unknown; serverBag?: Record<string, unknown> } = {}): void {
  ops.length = 0;
  rootBag.clear();
  dom.win.timers.length = 0;
  calls = [];
  held.length = 0;
  sw.set({ gatePut: false, failNextPut: false });
  H.refreshes = 0;
  dom.storage.clear();
  if (opts.cache !== undefined) dom.storage.setItem(STORAGE_KEY, JSON.stringify(opts.cache));
  bag = opts.serverBag ?? {};
}

export function cached(): string | null {
  return dom.storage.getItem(STORAGE_KEY);
}
