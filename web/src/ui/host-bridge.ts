/**
 * The bridge to the native window (Nocturne part B10, `.claude/PLAN-B10.md`
 * §3 + §4) — the one channel between this page and the WebView2 host that runs
 * it, and the only way anything in this app reaches the Windows clipboard.
 *
 * A PAGE CANNOT PUT FILES ON THE CLIPBOARD. `navigator.clipboard` writes text
 * and images; Explorer pastes a FILE only from a file drop list, which is an
 * operating-system object a browser has no API for. The host process does own
 * one (`Clipboard.SetFileDropList`), so `Copy` on a Files row asks the host to
 * do it — and in a window that has no host (the Edge `--app` fallback) the
 * entry stays visibly disabled rather than quietly doing something else.
 *
 * THE MESSAGE IS A STRING, NOT JSON, in both directions: the host is built
 * with the in-box Framework compiler, which has no `System.Text.Json`, and a
 * newline-separated message with one kind and a list of paths needs no parser
 * at all on either side.
 *
 *     page → host:  copy-files\n<windows path>\n<windows path>…
 *     host → page:  copy-files ok <n>   |   copy-files failed
 *
 * The paths are WINDOWS paths the BACKEND produced (`GET /api/fs/winpath`,
 * behind the same boundary every other filesystem route sits behind), so this
 * module maps nothing, validates no path and knows no distro name. It moves a
 * string and waits for one word back.
 *
 * WHAT IT PROMISES THE CALLER: an answer, always. A host that never replies
 * (a clipboard held open by another program, a handler that threw before its
 * reply) resolves `false` after `REPLY_TIMEOUT_MS` rather than leaving a menu
 * action hanging forever with nothing said.
 */

/** The first line of the message, and the first word of every reply. */
const KIND = 'copy-files';

/** How long a reply may take before the app says it could not copy. */
export const REPLY_TIMEOUT_MS = 3000;

/** `chrome.webview`, as much of it as this module uses. */
export interface HostChannel {
  postMessage(message: string): void;
  addEventListener(type: 'message', fn: (e: { data?: unknown }) => void): void;
  removeEventListener(type: 'message', fn: (e: { data?: unknown }) => void): void;
}

/** The `window` this module reads. Injected in tests, the real one in the app. */
export interface HostWindow {
  chrome?: { webview?: HostChannel };
}

/** The real window, or nothing at all outside a browser (`node --test`). */
function hostWindow(w?: HostWindow): HostWindow | null {
  if (w !== undefined) return w;
  return typeof window === 'undefined' ? null : (window as unknown as HostWindow);
}

/**
 * Is this page running inside the native host? It is the ONE question the row
 * menu asks before offering `Copy` — an Edge `--app` window answers false and
 * the entry stays disabled with the sentence that says why.
 */
export function hasHostBridge(w?: HostWindow): boolean {
  const win = hostWindow(w);
  return win?.chrome?.webview != null;
}

/**
 * Ask the host to put these paths on the Windows clipboard as FILES. Answers
 * whether it said it did.
 *
 * No path is logged, here or by the caller: the reply carries a count and this
 * function returns a boolean, which is the whole vocabulary the flash needs.
 */
export function copyPathsToClipboard(paths: readonly string[], w?: HostWindow): Promise<boolean> {
  const channel = hostWindow(w)?.chrome?.webview;
  if (channel == null || paths.length === 0) return Promise.resolve(false);

  return new Promise<boolean>((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /** One answer only: a late reply after the timeout changes nothing. */
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      channel.removeEventListener('message', onMessage);
      resolve(ok);
    };

    function onMessage(e: { data?: unknown }): void {
      const data = e.data;
      if (typeof data !== 'string' || !data.startsWith(`${KIND} `)) return;
      finish(data.startsWith(`${KIND} ok `));
    }

    channel.addEventListener('message', onMessage);
    timer = setTimeout(() => finish(false), REPLY_TIMEOUT_MS);
    try {
      channel.postMessage([KIND, ...paths].join('\n'));
    } catch {
      finish(false);
    }
  });
}
