/**
 * Nocturne D6 phase 3 — `ExitMessage.early` is carried from the session
 * socket (`web/src/ws.ts`) to the pane (`web/src/ui/terminal.ts` ->
 * `web/src/ui/panes.ts` onExit), the same way `exitCode` is.
 *
 * The socket half runs for real: ws.ts resolves `WebSocket`/`location`/
 * `window` from the global scope at CALL time, so fakes stand in for all
 * three (the idiom of `tests/ui/ui-ws-presence.test.ts`); timers are no-op
 * recorders so nothing outlives the file. The relay through terminal.ts and
 * panes.ts is a source pin — both reach @xterm/xterm, which cannot be imported
 * outside a bundler. The banner it feeds is `tests/ui/ui-pane-early-exit.test.ts`.
 *
 * NOT claimed: a real WebSocket against a real server (the server's exit and
 * replay frames are tests/server/sessions-early-exit.test.ts); the relay
 * through terminal.ts and panes.ts as BEHAVIOUR — a source pin only proves the
 * text is there; the pane as a browser draws it
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSource } from '../helpers/helpers.ts';

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readyState = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    created.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}
const created: FakeWebSocket[] = [];

(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket;
(globalThis as unknown as { location: unknown }).location = { protocol: 'http:', host: 'localhost:41234' };
(globalThis as unknown as { window: unknown }).window = {
  __AUTH__: 'test-token',
  setInterval: () => 0,
  setTimeout: () => 0,
  addEventListener: () => undefined,
};
for (const level of ['debug', 'info', 'warn', 'error'] as const) {
  console[level] = (): void => undefined;
}

const ws = await import('../../web/src/ws.ts');

/** Open a socket and deliver one frame to it; hand back what onExit saw. */
function exitWith(frame: unknown): unknown[][] {
  const seen: unknown[][] = [];
  new ws.SessionSocket('sess-d6', {
    onReplay: () => undefined,
    onData: () => undefined,
    onInfo: () => undefined,
    onExit: (...args: unknown[]) => seen.push(args),
    onAttention: () => undefined,
    onConn: () => undefined,
  });
  const sock = created.at(-1) as FakeWebSocket;
  sock.onmessage?.({ data: JSON.stringify(frame) });
  return seen;
}

test('an exit frame with `early` hands the line to onExit beside the code', () => {
  assert.deepEqual(exitWith({ type: 'exit', exitCode: 1, early: { line: 'error: boom' } }), [
    [1, { line: 'error: boom' }],
  ]);
  assert.deepEqual(exitWith({ type: 'exit', exitCode: 1, early: { line: '' } }), [[1, { line: '' }]]);
});

test('an exit frame without `early` is the old exit: the second argument is undefined', () => {
  assert.deepEqual(exitWith({ type: 'exit', exitCode: 0 }), [[0, undefined]]);
});

test('a malformed `early` never reaches the pane as anything but absent', () => {
  for (const early of ['error: boom', null, 7, {}, { line: 3 }]) {
    assert.deepEqual(exitWith({ type: 'exit', exitCode: 2, early }), [[2, undefined]], JSON.stringify(early));
  }
  // Extra keys on the wire are not carried along.
  assert.deepEqual(exitWith({ type: 'exit', exitCode: 2, early: { line: 'x', html: '<b>' } }), [[2, { line: 'x' }]]);
});

test('terminal.ts relays it and panes.ts keeps it on the pane and tells the notice', () => {
  const term = readSource('web', 'src', 'ui', 'terminal.ts');
  assert.ok(term.includes('onExit: (exitCode, early) => events.onExit(exitCode, early),'), 'terminal.ts relays early');
  const panes = readSource('web', 'src', 'ui', 'panes.ts');
  const body = /onExit: \(exitCode, early\) => \{([\s\S]*?)\n {4}\},/.exec(panes)?.[1] ?? '';
  assert.ok(body.length > 0, 'non-vacuity: the pane’s onExit was found');
  assert.ok(body.includes('pay.early = early ?? null;'), 'the pane keeps it for its banner');
  assert.ok(
    body.includes("if (early !== undefined) noteEarlyExit(sessionId, st.state.sessions.get(sessionId)?.createdAt ?? '');"),
    'an early exit tells the notice, with the session’s createdAt (a replay is not news)',
  );
  assert.ok(body.indexOf('pay.early') < body.indexOf('updateNote(s, pay)'), 'kept before the banner paints');
});
