/**
 * The `restarting` flag's REAL job: during a restart this page asked for, every
 * "the backend vanished" reflex has to stand down. This file pins the two that
 * live in `web/src/ws.ts` — the per-session socket's reconnect loop and the
 * presence channel's — plus the state setter they read.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Without the guard the sequence is:
 * the old process kills its sessions and exits -> every session socket closes
 * -> each one probes `GET /api/sessions` -> the replacement backend answers
 * 401 (tokens rotate per run) -> `#die()` marks the pane permanently dead AND
 * `onAuthError` takes the whole page over with a panic panel — all while the
 * restart dialog is showing an honest "Reconnecting…". The guard is what makes
 * the difference between a two-second handover and a broken window.
 *
 * Since 2026-09-08 it also pins the OTHER half of the same problem: a page
 * whose token is rejected WITHOUT having asked for anything (a second window
 * pressed the button, or the update flow ran). `createAuthLossRecovery` in
 * `web/src/ui/restart-flow.ts` is the DOM-free decision behind it — probe
 * `/health`, reload if a backend answers, show the panel only if none does —
 * and this file drives it with recorders instead of a browser.
 *
 * Same shimmed-globals harness as `tests/ui-ws-presence.test.ts`: `ws.ts`
 * resolves `WebSocket`/`location`/`window` from the global scope at CALL time,
 * so fakes substitute for all three. Timers are recorders, never real ones —
 * these reconnect loops have no teardown hook by design.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    created.push(this);
  }

  send(): void {
    // The guards under test never send.
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  simulateClose(code = 1012, reason = 'service restart', wasClean = false): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean });
  }
}

const created: FakeWebSocket[] = [];
interface ScheduledCall {
  fn: () => void;
  ms: number;
}
const scheduled: ScheduledCall[] = [];
let fakeTimerId = 0;
function fakeTimer(fn: () => void, ms: number): number {
  scheduled.push({ fn, ms });
  return ++fakeTimerId;
}

/** Every fetch the modules attempt — the guard's whole point is that there are none. */
const fetches: string[] = [];

class MemoryStorage {
  #map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.#map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.#map.set(k, v);
  }
  removeItem(k: string): void {
    this.#map.delete(k);
  }
}

(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
(globalThis as unknown as { location: unknown }).location = {
  protocol: 'http:',
  host: 'localhost:41234',
};
(globalThis as unknown as { window: unknown }).window = {
  __AUTH__: 'test-token',
  setInterval: fakeTimer,
  setTimeout: fakeTimer,
  addEventListener: () => undefined,
};
(globalThis as unknown as { localStorage: unknown }).localStorage = new MemoryStorage();
(globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
  fetches.push(url);
  return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
};

// Silence the client logger's console mirror: real behaviour, pure noise here.
for (const level of ['debug', 'info', 'warn', 'error'] as const) {
  console[level] = (): void => undefined;
}

const ws = await import('../web/src/ws.ts');
const st = await import('../web/src/state.ts');
const { createAuthLossRecovery, RECOVER_TIMEOUT_MS, HEALTH_POLL_MS } = await import(
  '../web/src/ui/restart-flow.ts'
);

/** ws.ts's own RESTART_HOLD_MS, mirrored (it is module-private by design). */
const RESTART_HOLD_MS = 1000;

function reset(): void {
  created.length = 0;
  scheduled.length = 0;
  fetches.length = 0;
  st.state.restarting = false;
}

const noopHandlers = {
  onReplay: (): void => undefined,
  onData: (): void => undefined,
  onInfo: (): void => undefined,
  onExit: (): void => undefined,
  onAttention: (): void => undefined,
  onConn: (): void => undefined,
};

test('setRestarting flips the flag and notifies once per real transition', () => {
  reset();
  const kinds: string[] = [];
  st.subscribe((k) => kinds.push(k));
  st.setRestarting(true);
  st.setRestarting(true);
  assert.equal(st.state.restarting, true);
  st.setRestarting(false);
  assert.deepEqual(
    kinds.filter((k) => k === 'conn'),
    ['conn', 'conn'],
    'no notification for a no-op write',
  );
  reset();
});

test('a session socket dropped DURING a restart makes no liveness call and never dies', async () => {
  reset();
  const conn: string[] = [];
  const sock = new ws.SessionSocket('sess-1', { ...noopHandlers, onConn: (s) => conn.push(s) });
  const socket = created[0] as FakeWebSocket;
  st.setRestarting(true);

  socket.simulateClose();
  // #lost is async only because of the liveness call it is NOT making here;
  // one microtask turn is enough for the guarded path.
  await Promise.resolve();

  assert.deepEqual(fetches, [], 'no /api/sessions probe — a 401 would kill the pane and the page');
  assert.equal(conn.at(-1), 'reconnecting', 'the pane says reconnecting, never dead');
  assert.ok(!conn.includes('dead'));
  const held = scheduled.at(-1);
  assert.equal(held?.ms, RESTART_HOLD_MS, 'it parks and re-checks instead of retrying');
  assert.equal(created.length, 1, 'and it does NOT open a new socket during the gap');

  // The hold re-enters the same guarded path for as long as the flag is set.
  held?.fn();
  await Promise.resolve();
  assert.deepEqual(fetches, []);
  assert.equal(scheduled.at(-1)?.ms, RESTART_HOLD_MS);

  // Once the restart is over (it failed, say), the normal loop resumes and the
  // liveness probe happens again — the guard pauses, it does not switch off.
  st.setRestarting(false);
  scheduled.at(-1)?.fn();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(fetches, ['/api/sessions']);
  sock.close();
  reset();
});

test('a session socket dropped OUTSIDE a restart keeps its normal behaviour', async () => {
  reset();
  const conn: string[] = [];
  const sock = new ws.SessionSocket('sess-2', { ...noopHandlers, onConn: (s) => conn.push(s) });
  const socket = created[0] as FakeWebSocket;
  socket.simulateClose();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.deepEqual(fetches, ['/api/sessions'], 'the unguarded path still probes');
  // The shimmed fetch answers 401 -> the socket dies, exactly as before.
  assert.equal(conn.at(-1), 'dead');
  sock.close();
  reset();
});

test('the presence channel holds instead of reconnecting while a restart is in flight', () => {
  reset();
  ws.startPresence();
  const socket = created[0] as FakeWebSocket;
  st.setRestarting(true);
  socket.simulateClose();

  assert.equal(created.length, 1, 'no reconnect attempt during the gap');
  const held = scheduled.at(-1);
  assert.equal(held?.ms, RESTART_HOLD_MS);

  // Still restarting: it re-arms rather than opening.
  held?.fn();
  assert.equal(created.length, 1);
  assert.equal(scheduled.at(-1)?.ms, RESTART_HOLD_MS);

  // Restart over: the very next hold opens a fresh presence socket.
  st.setRestarting(false);
  scheduled.at(-1)?.fn();
  assert.equal(created.length, 2);
  assert.ok((created[1] as FakeWebSocket).url.includes('/ws/presence'));
  reset();
});

// ---------------------------------------------------------------------------
// Stale-page recovery: a restart this window did NOT ask for (2026-09-08)
// ---------------------------------------------------------------------------

interface RecoveryRecorder {
  deps: Parameters<typeof createAuthLossRecovery>[0];
  armed: boolean[];
  probes: number;
  reloads: number;
  panels: number;
  lines: string[];
  slept: number[];
}

/**
 * A recovery wired to recorders and a clock that only moves when the flow
 * sleeps, so the 5 s budget is spent in microseconds and the probe count is
 * exact rather than timing-dependent.
 */
function recovery(opts: { healthyAfter?: number; throwOnProbe?: boolean }): RecoveryRecorder {
  const armed: boolean[] = [];
  const lines: string[] = [];
  const slept: number[] = [];
  let clock = 0;
  let probes = 0;
  let reloads = 0;
  let panels = 0;
  const rec: RecoveryRecorder = {
    armed,
    lines,
    slept,
    get probes() {
      return probes;
    },
    get reloads() {
      return reloads;
    },
    get panels() {
      return panels;
    },
    deps: {
      async health() {
        probes += 1;
        return opts.healthyAfter !== undefined && probes > opts.healthyAfter;
      },
      now: () => clock,
      async sleep(ms: number) {
        slept.push(ms);
        clock += ms;
      },
      setRestarting: (v) => armed.push(v),
      showProbe: () => {
        if (opts.throwOnProbe === true) throw new Error('no document here');
      },
      reload: () => {
        reloads += 1;
      },
      showPanel: () => {
        panels += 1;
      },
      log: (level, line) => lines.push(`${level} ${line}`),
    },
  };
  return rec;
}

/** Let the recovery's async tail run to completion (its clock never really waits). */
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve();
}

test('a rejected token with a LIVE backend reloads instead of showing the panic panel', async () => {
  // The common case since the restart button exists: another window restarted
  // the backend, the replacement is already on the same port, and this page
  // just needs the token index.html will inject on the next load.
  const r = recovery({ healthyAfter: 2 });
  const trigger = createAuthLossRecovery(r.deps);
  trigger();

  // Armed BEFORE the probe: the polls and both reconnect loops must be asleep
  // while the gap is measured, or they 401-storm a backend that is fine.
  assert.deepEqual(r.armed, [true]);
  await settle();

  assert.equal(r.reloads, 1, 'exactly one reload');
  assert.equal(r.panels, 0, 'and no takeover panel — nothing is wrong');
  assert.equal(r.probes, 3, 'one immediate probe, then one per poll interval');
  assert.deepEqual(r.slept, [HEALTH_POLL_MS, HEALTH_POLL_MS]);
  assert.deepEqual(r.armed, [true], 'the flag stays armed: the page is leaving');
  assert.ok(r.lines.some((l) => l.startsWith('warn auth token rejected after boot')));
  assert.ok(r.lines.some((l) => l.includes('reloading to reattach')));
});

test('a rejected token with a DEAD backend un-arms the gap and ends in the panel', async () => {
  const r = recovery({});
  createAuthLossRecovery(r.deps)();
  await settle();

  assert.equal(r.reloads, 0, 'never reload onto nothing');
  assert.equal(r.panels, 1);
  assert.deepEqual(r.armed, [true, false], 'the gap is released before the panel takes over');
  // 5000 / 250 = 20 sleeps, 21 probes (the first one is immediate).
  assert.equal(r.slept.length, RECOVER_TIMEOUT_MS / HEALTH_POLL_MS);
  assert.equal(r.probes, RECOVER_TIMEOUT_MS / HEALTH_POLL_MS + 1);
  assert.ok(r.lines.some((l) => l.startsWith('error the backend did not answer')));
});

test('the recovery is ONE SHOT: a 401 storm produces a single probe and a single reload', async () => {
  // Three panes plus two polls all hit 401 within the same tick. Without the
  // latch that is five overlapping probes and five reloads.
  const r = recovery({ healthyAfter: 0 });
  const trigger = createAuthLossRecovery(r.deps);
  for (let i = 0; i < 5; i++) trigger();
  await settle();

  assert.equal(r.probes, 1);
  assert.equal(r.reloads, 1);
  assert.deepEqual(r.armed, [true], 'and the gap is armed exactly once');

  // Even afterwards, it never runs a second time on this page.
  trigger();
  await settle();
  assert.equal(r.reloads, 1);
});

test('a takeover that cannot paint still recovers — the probe is the part that matters', async () => {
  // showProbe touches the DOM; if it throws (a torn-down document, a missing
  // body) the page must still get its reload rather than hang on a dead token.
  const r = recovery({ healthyAfter: 0, throwOnProbe: true });
  createAuthLossRecovery(r.deps)();
  await settle();
  assert.equal(r.reloads, 1);
  assert.equal(r.panels, 0);
});

test('a session socket 401 DURING the recovery parks the pane instead of killing it', async () => {
  // The 401 that discovers the restart is the same one that arms the recovery
  // (api.onAuthError fires before the rejection is thrown), so the flag has to
  // be re-read after the call — otherwise this pane is marked permanently dead
  // one beat before the page reloads onto a healthy backend.
  reset();
  const conn: string[] = [];
  const sock = new ws.SessionSocket('sess-3', { ...noopHandlers, onConn: (s) => conn.push(s) });
  const socket = created[0] as FakeWebSocket;

  // The shimmed fetch answers 401; the recovery arms the flag the moment the
  // liveness probe goes out, exactly like the real onAuthError handler.
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
    fetches.push(url);
    st.state.restarting = true;
    return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
  };
  socket.simulateClose();
  for (let i = 0; i < 6; i++) await Promise.resolve();

  assert.deepEqual(fetches, ['/api/sessions']);
  assert.ok(!conn.includes('dead'), 'the pane is parked, not buried');
  assert.equal(conn.at(-1), 'reconnecting');
  assert.equal(scheduled.at(-1)?.ms, RESTART_HOLD_MS);

  sock.close();
  (globalThis as unknown as { fetch: unknown }).fetch = async (url: string) => {
    fetches.push(url);
    return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
  };
  reset();
});

// ---------------------------------------------------------------------------
// The refused path inside ui/update.ts — a SOURCE guard, and why
// ---------------------------------------------------------------------------
//
// `web/src/ui/update.ts` is the pixel half of the restart flow and it has no
// test harness: the suite carries no DOM, and adding one is a dependency
// decision, not a test-engineering one. Everything decidable was deliberately
// pulled out into `ui/update-model.ts` and `ui/restart-flow.ts`, which ARE
// driven above and in tests/ui-update-model.test.ts.
//
// What is left inside update.ts is three lines of glue, and ONE of them is
// load-bearing beyond the pixels: on a 422 the restart gap has to be un-armed,
// or the session poll, the runtime poll and both reconnect loops stay asleep
// against a backend that never went anywhere — an app that looks frozen after a
// restart it correctly refused. Until a DOM harness exists, this pins that one
// call at the source level. It is a stopgap and reads like one; it is not a
// substitute for `.claude/skills/verify-terminal/SKILL.md`.

const updateSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'web', 'src', 'ui', 'update.ts'),
  'utf8',
);

/**
 * The block opened by `header`, up to its own closing brace — identified by
 * indentation, which is what makes this exact rather than "everything after".
 * `indent` is the number of spaces the closing brace sits at.
 */
function bodyOf(source: string, header: string, indent = 2): string {
  const start = source.indexOf(header);
  assert.notEqual(start, -1, `${header} must exist in web/src/ui/update.ts`);
  const close = `\n${' '.repeat(indent)}}`;
  const end = source.indexOf(close, start + header.length);
  assert.notEqual(end, -1, `${header} must close at indentation ${indent}`);
  return source.slice(start, end);
}

test('ui/update.ts: the 422 path un-arms the restart gap and puts the pending notice back', () => {
  const refused = bodyOf(updateSrc, 'function showRefused(');
  assert.match(
    refused,
    /st\.setRestarting\(false\)/,
    'a refusal must release the gap: nothing was torn down, so every poll and both ' +
      'reconnect loops have to resume',
  );
  assert.match(refused, /setPhase\('refused'\)/, 'and it is its own phase, not the terminal one');

  const branch = bodyOf(updateSrc, "if (outcome.kind === 'refused') {", 4);
  assert.match(branch, /notice\.restartAborted\(\)/, 'the update is still pending: the pill comes back');
  assert.match(branch, /showRefused\(outcome\.message\)/, "and the server's own sentence is what is shown");
  assert.ok(
    !/location\.(reload|href)/.test(branch),
    'a refusal must never navigate: this page is still talking to a live backend',
  );
});

test('ui/update.ts: the FAILED path is the opposite decision, and stays that way', () => {
  // The two paths share a message slot, so the guard above is only meaningful
  // beside this one: `failed` means the old process is gone and the page is
  // finished, `refused` means nothing happened.
  const failed = bodyOf(updateSrc, 'function showFailure(');
  assert.match(failed, /setPhase\('over'\)/);
  assert.ok(
    !/setPhase\('refused'\)/.test(failed),
    'a real failure must never be dressed up as a harmless refusal',
  );
});

test('ui/update.ts: closing the dialog never focuses a HIDDEN element — the terminal gets the keys', () => {
  // The bug this pins (2026-09-08): `Hide` during the preflight put focus back
  // on the pill or the toast, both `hidden` in the restarting state, so focus
  // fell to <body> and no keystroke reached the PTY. Same fallback as the
  // launch dialog: the focused pane's terminal.
  assert.match(
    updateSrc,
    /import \{ requestTerminalFocus \} from '\.\/panes\.ts';/,
    'the fallback comes from the panes module, like web/src/ui/launch.ts',
  );
  const close = bodyOf(updateSrc, 'function closeConfirm(');
  const restore = bodyOf(updateSrc, 'function restoreFocus(');
  assert.equal(
    (close.match(/restoreFocus\(\)/g) ?? []).length,
    2,
    'BOTH exits — the hide path and the normal close — go through the same helper',
  );
  assert.ok(
    !/restoreTo\.focus\(\)/.test(close),
    'and neither of them focuses restoreTo directly any more',
  );
  assert.match(restore, /requestTerminalFocus\(\)/, 'the fallback is the terminal, never <body>');
  for (const guard of [/\.isConnected/, /\.hidden/, /closest\('\[hidden\]'\)/, /offsetParent/]) {
    assert.match(restore, guard, `an unfocusable restoreTo must be detected: ${String(guard)}`);
  }
});

test('ui/update.ts: the dialog can be HIDDEN during the preflight, and nothing is aborted with it', () => {
  // A preflight can run for two minutes while every session is alive behind the
  // scrim. The dialog therefore has to be dismissible there — but dismissing it
  // must not touch the flow, and the handover phase must stay locked. Since
  // phase E the same branch also covers the update half (download, verify,
  // install), which is hidable throughout: `canHideFlow` is the one rule for
  // both, and it delegates to `canHideRestartDialog` for the restart phases.
  const close = bodyOf(updateSrc, 'function closeConfirm(');
  assert.match(
    close,
    /canHideFlow\(flowPhase\)/,
    'the busy branch asks the DOM-free rule instead of hard-coding the phase',
  );
  assert.match(close, /hiddenMidFlow = true/, 'and it remembers that the outcome must bring it back');
  assert.ok(
    !/abort|setRestarting|notice\./.test(close),
    'hiding is not cancelling: it must not un-arm the restart gap or touch the notice — ' +
      'the POST is still out and the backend is still preparing',
  );

  // The outcome always gets a screen, hidden or not.
  for (const fn of ['function showFailure(', 'function showRefused(']) {
    assert.match(bodyOf(updateSrc, fn), /reveal\(\)/, `${fn} must re-open a hidden dialog`);
  }

  // A second click on the pill/settings while a flow runs must not re-ask the
  // question whose answer is still on its way.
  const open = bodyOf(updateSrc, 'function openConfirm(');
  assert.match(open, /if \(phase === 'busy'\) \{\s*\n\s*reveal\(\);/, 'it reveals instead of resetting');
});
