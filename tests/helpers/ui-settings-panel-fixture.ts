/**
 * Shared boot for the Settings panel tests (`tests/ui/ui-settings-panel*.test.ts`):
 * the fake DOM, the harness `H` behind the stubbed `../api.ts`, `../state.ts`,
 * `../log.ts` and `./update.ts` (whose import graph reaches @xterm/xterm), the
 * recording stub of ui/theme.ts's control, and ONE real `web/src/ui/settings.ts`
 * panel built on them — plus the lookups every file uses (`tab`, `panelOf`,
 * `row`, `reopen`, …).
 *
 * Module-level on purpose: `installDom()`, the loader hooks and the import of
 * settings.ts must run in this order before any test, once per test file
 * (`node --test` gives every file its own process, so every file gets its own
 * panel). Not a test.
 */
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import type { SessionInfo, UiPrefs } from '../../shared/protocol.ts';
import { byClass, installDom, type FakeElement } from './fake-dom.ts';

export const dom = installDom();

// ===========================================================================
// Harness + module stubs
// ===========================================================================

export interface Harness {
  sessions: Map<string, SessionInfo>;
  projectNames: Record<string, string | null>;
  installed: boolean;
  facts: { runningFor: string; version: string };
  prefs: UiPrefs;
  writes: { patch: UiPrefs; dead: readonly string[] }[];
  getCalls: number;
  restarts: string[];
  /** POST /api/update/check — what the fake backend answers, and how often it was asked. */
  update: { available: boolean; reason: string | null; release?: { version: string } };
  checkCalls: number;
  /** When set, the next check rejects with it. */
  nextCheckError: Error | null;
  /** GET /api/runtime after an answered check: the calls, and what applyRuntime saw. */
  runtimeCalls: number;
  runtimesApplied: number;
  /** The runtime answers the panel handed to state.setRuntime, in order. */
  runtimes: unknown[];
  logs: string[];
  subscribers: ((kind: string) => void)[];
  /**
   * When set, `getPrefs()` waits on it before answering — so a test can let the
   * user toggle a row BEFORE the re-read on open lands (the `writes > 0` guard
   * in settings.ts). Null in every other case, so the default behaviour of the
   * stub is unchanged.
   */
  gate: Promise<void> | null;
  /** GET /api/keys — what the page learns about stored keys (B5). */
  keys: { saved: Record<string, boolean>; env: Record<string, boolean> };
  keyCalls: number;
  /** PUT /api/keys/:tool and DELETE /api/keys/:tool, in order. */
  keySaves: { tool: string; key: string }[];
  keyDeletes: string[];
  /** When set, the next save (or delete) rejects with this error. */
  nextKeyError: Error | null;
}

export const H: Harness = {
  sessions: new Map(),
  projectNames: {},
  installed: false,
  facts: { runningFor: '2h 15m', version: '0.2.0' },
  prefs: {},
  writes: [],
  getCalls: 0,
  restarts: [],
  update: { available: false, reason: null },
  checkCalls: 0,
  nextCheckError: null,
  runtimeCalls: 0,
  runtimesApplied: 0,
  runtimes: [],
  logs: [],
  subscribers: [],
  gate: null,
  keys: {
    saved: { claude: false, gemini: false, grok: false },
    env: { claude: false, gemini: false, grok: false },
  },
  keyCalls: 0,
  keySaves: [],
  keyDeletes: [],
  nextKeyError: null,
};
(globalThis as unknown as Record<string, unknown>).__sgHarness = H;

export const STUB_SRC: Record<string, string> = {
  api: `
    const H = globalThis.__sgHarness;
    export async function updatePrefs(patch, dead) { H.writes.push({ patch, dead }); }
    export async function getPrefs() { H.getCalls++; if (H.gate !== null) await H.gate; return H.prefs; }
    export async function getKeys() { H.keyCalls++; return H.keys; }
    export async function saveKey(tool, key) {
      H.keySaves.push({ tool, key });
      if (H.nextKeyError !== null) { const e = H.nextKeyError; H.nextKeyError = null; throw e; }
      return { ok: true };
    }
    export async function deleteKey(tool) {
      H.keyDeletes.push(tool);
      if (H.nextKeyError !== null) { const e = H.nextKeyError; H.nextKeyError = null; throw e; }
      return { ok: true };
    }
    export async function checkForUpdates() {
      H.checkCalls++;
      if (H.nextCheckError !== null) { const e = H.nextCheckError; H.nextCheckError = null; throw e; }
      return H.update;
    }
    export async function getRuntime() { H.runtimeCalls++; return { update: H.update }; }`,
  state: `
    const H = globalThis.__sgHarness;
    export const state = {
      get sessions() { return H.sessions; },
      get installed() { return H.installed; },
    };
    export function projectName(id) { return H.projectNames[id] ?? null; }
    export function setRuntime(r) { H.runtimes.push(r); }
    export function subscribe(fn) { H.subscribers.push(fn); }`,
  log: `
    const H = globalThis.__sgHarness;
    const rec = (lvl) => (m) => { H.logs.push(lvl + ' ' + m); };
    export const log = { debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') };`,
  update: `
    const H = globalThis.__sgHarness;
    export function openRestartConfirm(src) { H.restarts.push(src); }
    export function runtimeFacts() { return H.facts; }
    export function applyRuntime() { H.runtimesApplied++; }`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if ((context.parentURL ?? '').endsWith('/web/src/ui/settings.ts')) {
      const m = /^(?:\.\.\/(api|state|log)|\.\/(update))\.ts$/.exec(specifier);
      const name = m?.[1] ?? m?.[2];
      if (name !== undefined) return { url: `sg-stub:${name}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('sg-stub:')) {
      return { format: 'module', source: STUB_SRC[url.slice('sg-stub:'.length)], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

export interface TermPair {
  ground: string;
  text: string;
}
export interface SettingsModule {
  initSettings(
    host: unknown,
    anchor: unknown,
    deps: {
      repaintStatus(): void;
      theme: {
        apply(next: TermPair): void;
        adopt(next: TermPair): void;
        current(): TermPair;
        flush(): Promise<void>;
      };
    },
  ): { open(): void; close(): void; toggle(): void; isOpen(): boolean };
  /** The entry the New session dialog's `Add key` uses (Nocturne B5). */
  openSettings(opts?: { page?: string; focusKey?: string }): void;
}
export interface ThemeModule {
  GROUNDS: { name: string; hex: string }[];
  RAMPS: { name: string; cmd: string; out: string; dim: string }[];
}

// A computed specifier: the typechecker must not walk the browser import graph
// under the server tsconfig (web/tsconfig.json owns that).
export const S = (await import(new URL('../../web/src/ui/settings.ts', import.meta.url).href)) as SettingsModule;
export const T = (await import(new URL('../../web/src/ui/theme-model.ts', import.meta.url).href)) as ThemeModule;

export const modalHost = dom.doc.createElement('div');
export const anchor = dom.doc.createElement('button');
dom.body.append(modalHost, anchor);
/**
 * `ui/panes.ts` repaintStatus, injected. The count lives in the file that
 * asserts on it (`ui-settings-panel-status-bar.test.ts` sets both hooks, since
 * an imported `let` cannot be reset by its importer); every other file keeps
 * the no-ops.
 */
export const repaintHook = { bump: (): void => {}, reset: (): void => {} };
/**
 * ui/theme.ts's control, stubbed and RECORDING (part B9): the panel hands it to
 * the Terminal colours page, re-applies the server's pair on the re-read, and
 * flushes it when the dialog closes — none of which can reach the real module
 * here, because it imports @xterm/xterm.
 */
export let themePair: TermPair = { ground: T.GROUNDS[0]!.hex, text: T.RAMPS[0]!.cmd };
export const themeApplied: string[] = [];
export const themeAdopted: string[] = [];
export let themeFlushes = 0;
export const themeStub = {
  apply(next: TermPair): void {
    themeApplied.push(`${next.ground}/${next.text}`);
    themePair = { ...next };
  },
  // The server's own pair: painted and cached, never written back (the real
  // control also drops it while a write of ours is pending).
  adopt(next: TermPair): void {
    themeAdopted.push(`${next.ground}/${next.text}`);
    themePair = { ...next };
  },
  current: (): TermPair => ({ ...themePair }),
  flush: (): Promise<void> => {
    themeFlushes += 1;
    return Promise.resolve();
  },
};
export const panel = S.initSettings(modalHost, anchor, {
  repaintStatus: () => {
    repaintHook.bump();
  },
  theme: themeStub,
});
export const scrim = modalHost.children[0] as FakeElement;
export const modal = scrim.children[0] as FakeElement;

/** Let the `getPrefs()` re-read on open settle. */
export const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

export function tab(label: string): FakeElement {
  const hit = byClass(modal, 'sg-tab').find((b) => b.textContent === label);
  assert.ok(hit !== undefined, `no nav button "${label}"`);
  return hit;
}

export function panelOf(id: string): FakeElement {
  const hit = [...byClass(modal, 'sg-page')].find((p) => p.id === `sg-panel-${id}`);
  assert.ok(hit !== undefined, `no page "${id}"`);
  return hit;
}

/** A checklist row by its visible label, inside one page. */
export function row(page: FakeElement, label: string): FakeElement {
  const hit = byClass(page, 'sg-row').find((r) => byClass(r, 'sg-rowlb')[0]?.textContent === label);
  assert.ok(hit !== undefined, `no row "${label}"`);
  return hit;
}

export function statusPatch(i = -1): Record<string, boolean> {
  const w = H.writes.at(i);
  assert.ok(w !== undefined, 'no prefs write recorded');
  assert.deepEqual(w.dead, ['defaults', 'statusBar'], 'the two retired keys are pruned in the same write');
  return w.patch.statusLine as Record<string, boolean>;
}

export async function reopen(): Promise<void> {
  panel.close();
  H.writes.length = 0;
  repaintHook.reset();
  // The gear has focus when a user opens the panel; close() hands it back there.
  anchor.focus();
  panel.open();
  await settle();
}
