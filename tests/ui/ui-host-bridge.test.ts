/**
 * `web/src/ui/host-bridge.ts` — the page's one channel to the native window
 * (Nocturne part B10, `.claude/plans/nocturne/PLAN-B10.md` §3 + §4), driven against an
 * injected `window`-like double.
 *
 * WHY THIS FILE EXISTS. The other side of this channel is C# on Windows that
 * cannot run here at all, so what CAN be pinned is the half that is ours: the
 * message is a STRING of the exact shape the host parses (the host is built
 * with a compiler that has no JSON at all, so a byte out of place is a message
 * it silently ignores), the answer is read from the reply and not assumed, and
 * a host that never answers still gives the caller a `false` rather than a
 * menu action that hangs forever.
 *
 * It also pins the ABSENCE of a fallback: a window with no `chrome.webview`
 * answers false and posts nothing. Writing the path as TEXT instead was
 * rejected in §4 — pasting text into Explorer's file list does nothing, and a
 * `Copy` that produces a string is a different promise.
 *
 * NOT claimed here: that WebView2 delivers the message, that the host sets the
 * clipboard, or that Explorer pastes what it set (the user's Windows check).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REPLY_TIMEOUT_MS,
  copyPathsToClipboard,
  hasHostBridge,
  type HostWindow,
} from '../../web/src/ui/host-bridge.ts';

type Listener = (e: { data?: unknown }) => void;

interface Host {
  win: HostWindow;
  /** Everything the page posted, verbatim. */
  posted: string[];
  /** How many `message` listeners are attached right now. */
  listeners(): number;
  /** Answer as the host would. */
  reply(data: unknown): void;
}

function host(opts: { throws?: boolean } = {}): Host {
  const listeners: Listener[] = [];
  const posted: string[] = [];
  const h: Host = {
    win: {
      chrome: {
        webview: {
          postMessage(message: string) {
            if (opts.throws === true) throw new Error('channel is gone');
            posted.push(message);
          },
          addEventListener(_type: 'message', fn: Listener) {
            listeners.push(fn);
          },
          removeEventListener(_type: 'message', fn: Listener) {
            const i = listeners.indexOf(fn);
            if (i !== -1) listeners.splice(i, 1);
          },
        },
      },
    },
    posted,
    listeners: () => listeners.length,
    reply(data: unknown) {
      for (const fn of [...listeners]) fn({ data });
    },
  };
  return h;
}

/** Run one body with the global clock replaced by a recorder. */
async function withFakeClock(body: (fire: () => void) => Promise<void>): Promise<void> {
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  let armed: (() => void) | null = null;
  let armedMs = -1;
  let cleared = 0;
  (globalThis as { setTimeout: unknown }).setTimeout = (fn: () => void, ms: number): number => {
    armed = fn;
    armedMs = ms;
    return 7;
  };
  (globalThis as { clearTimeout: unknown }).clearTimeout = (): void => {
    cleared += 1;
  };
  try {
    await body(() => {
      assert.equal(armedMs, REPLY_TIMEOUT_MS, 'the wait is the one the module documents');
      assert.ok(armed !== null, 'a timeout must be armed for every ask');
      armed();
    });
    assert.ok(cleared >= 0);
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
}

// ---------------------------------------------------------------------------
// hasHostBridge
// ---------------------------------------------------------------------------

test('hasHostBridge: true inside the native window, false in every other window', () => {
  assert.equal(hasHostBridge(host().win), true);
  assert.equal(hasHostBridge({}), false, 'an Edge --app window has no chrome at all');
  assert.equal(hasHostBridge({ chrome: {} }), false, 'chrome without a webview is not a host');
  assert.equal(hasHostBridge({ chrome: { webview: undefined } }), false);
});

test('hasHostBridge outside a browser answers false instead of throwing', () => {
  // `node --test` has no `window`; the Files panel asks this at menu-open time
  // and a throw there would take the whole menu down.
  assert.equal(hasHostBridge(), false);
});

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

test('the message is the kind, then one path per line, in order — byte for byte', async () => {
  const h = host();
  const answer = copyPathsToClipboard(
    ['\\\\wsl.localhost\\Ubuntu\\home\\you\\a.txt', 'D:\\work\\b.txt'],
    h.win,
  );
  assert.deepEqual(h.posted, [
    'copy-files\n\\\\wsl.localhost\\Ubuntu\\home\\you\\a.txt\nD:\\work\\b.txt',
  ]);
  assert.equal(typeof h.posted[0], 'string', 'a STRING: the host has no JSON parser');
  h.reply('copy-files ok 2');
  assert.equal(await answer, true);
});

test('one path is the same message with one line under the kind', async () => {
  const h = host();
  const answer = copyPathsToClipboard(['D:\\a.txt'], h.win);
  assert.deepEqual(h.posted, ['copy-files\nD:\\a.txt']);
  h.reply('copy-files ok 1');
  assert.equal(await answer, true);
});

test('nothing to copy posts nothing and answers false', async () => {
  const h = host();
  assert.equal(await copyPathsToClipboard([], h.win), false);
  assert.deepEqual(h.posted, []);
});

test('a window with no host posts nothing and answers false', async () => {
  assert.equal(await copyPathsToClipboard(['D:\\a.txt'], {}), false);
});

test('a channel that throws on post answers false instead of leaving the caller waiting', async () => {
  const h = host({ throws: true });
  assert.equal(await copyPathsToClipboard(['D:\\a.txt'], h.win), false);
  assert.equal(h.listeners(), 0, 'and it takes its listener back with it');
});

// ---------------------------------------------------------------------------
// The reply
// ---------------------------------------------------------------------------

test('`copy-files ok <n>` is the only success, and any count is one', async () => {
  for (const n of [1, 3, 100]) {
    const h = host();
    const answer = copyPathsToClipboard(['D:\\a.txt'], h.win);
    h.reply(`copy-files ok ${n}`);
    assert.equal(await answer, true, `ok ${n}`);
  }
});

test('`copy-files failed` is a false, and the caller hears it at once', async () => {
  const h = host();
  const answer = copyPathsToClipboard(['D:\\a.txt'], h.win);
  h.reply('copy-files failed');
  assert.equal(await answer, false);
  assert.equal(h.listeners(), 0, 'the listener is taken off after the answer');
});

test('a message that is not ours is ignored: the ask is still waiting', async () => {
  const h = host();
  let settled = false;
  const answer = copyPathsToClipboard(['D:\\a.txt'], h.win).then((v) => {
    settled = true;
    return v;
  });
  h.reply('something-else ok 1');
  h.reply({ data: 'not a string' });
  h.reply(42);
  h.reply(null);
  await Promise.resolve();
  assert.equal(settled, false, 'none of those was an answer to this');
  h.reply('copy-files ok 1');
  assert.equal(await answer, true);
});

test('the FIRST answer decides: a second reply changes nothing and reaches nobody', async () => {
  const h = host();
  const answer = copyPathsToClipboard(['D:\\a.txt'], h.win);
  h.reply('copy-files ok 1');
  h.reply('copy-files failed');
  assert.equal(await answer, true);
  assert.equal(h.listeners(), 0);
});

// ---------------------------------------------------------------------------
// The timeout
// ---------------------------------------------------------------------------

test('a host that never answers is a false after the wait, not a menu action that hangs', async () => {
  await withFakeClock(async (fire) => {
    const h = host();
    const answer = copyPathsToClipboard(['D:\\a.txt'], h.win);
    fire();
    assert.equal(await answer, false);
    assert.equal(h.listeners(), 0, 'and the page stops listening for it');
  });
});

test('a reply that arrives after the wait changes nothing', async () => {
  await withFakeClock(async (fire) => {
    const h = host();
    const answer = copyPathsToClipboard(['D:\\a.txt'], h.win);
    fire();
    assert.equal(await answer, false);
    h.reply('copy-files ok 1');
    assert.equal(await answer, false, 'the answer was already given');
  });
});

test('the wait is three seconds — long enough for a clipboard another program is holding', () => {
  assert.equal(REPLY_TIMEOUT_MS, 3000);
});
