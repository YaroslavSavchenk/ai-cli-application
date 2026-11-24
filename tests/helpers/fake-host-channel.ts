/**
 * A fake `window.chrome.webview` for the UI tests that need the WebView2 host
 * (Quality Q17 P3: `tests/ui/ui-offline-panel.test.ts`,
 * `tests/ui/ui-restart-relaunch.test.ts`): it records what the page posts and
 * lets a test answer as the host would. Not a test.
 *
 * `tests/ui/ui-host-bridge.test.ts` keeps its own double: it injects the
 * window into each call and needs a channel that throws.
 */
type Listener = (e: { data?: unknown }) => void;

interface FakeHostChannel {
  /** Everything the page posted, verbatim. */
  posted: string[];
  listeners: Set<Listener>;
  postMessage(m: string): void;
  addEventListener(type: 'message', fn: Listener): void;
  removeEventListener(type: 'message', fn: Listener): void;
  /** Post `data` to the page, as the host does. */
  say(data: unknown): void;
}

export function makeHostChannel(): FakeHostChannel {
  const ch: FakeHostChannel = {
    posted: [],
    listeners: new Set<Listener>(),
    postMessage(m) {
      ch.posted.push(m);
    },
    addEventListener(_type, fn) {
      ch.listeners.add(fn);
    },
    removeEventListener(_type, fn) {
      ch.listeners.delete(fn);
    },
    say(data) {
      for (const fn of [...ch.listeners]) fn({ data });
    },
  };
  return ch;
}
