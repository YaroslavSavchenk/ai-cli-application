/**
 * Claude peek mascot — page entry. A SEPARATE page of the app
 * (`web/mascot.html`), not part of the shell: it holds nothing but the
 * mascots and renders on a transparent background, because the Windows host
 * shows it in a transparent always-on-top overlay window pinned to the right
 * edge of the monitor (Nocturne C1, `.claude/plans/nocturne/PLAN-C1.md`).
 *
 * LIVE (no query string — how the host loads it): ./feed.ts polls
 * `/api/sessions` and `/api/prefs` every 2 s with the token the backend
 * injected into this page (`window.__AUTH__`, like index.html), and hands the
 * model the pending count. The page reports every change to the host as a
 * STRING `{"type":"mascot-count","count":N,"rects":[[x,y,w,h],…]}` and, after
 * a click's reaction, `{"type":"mascot-open","session":"<id>"}`. Outside the
 * host (`window.chrome.webview` absent) nothing is posted; the page still
 * polls and draws.
 *
 * `?demo` is the other mode: no polling, no host messages, a small dev-only
 * control strip and the app's own background, so the art can be exercised by
 * hand in a normal browser window (`&count=N` sets the starting count). The
 * host never adds a query string.
 *
 * Either way the rest of the world can drive or read the count:
 *
 *   window.aiSmMascot.setCount(2)   // 2 mascots (the live feed overrides it)
 *   window.aiSmMascot.getCount()
 *   window.aiSmMascot.destroy()
 */
import './mascot.css';
import { HostReporter, MascotFeed, type HttpFailure } from './feed.ts';
import { MascotModel, REACTIONS } from './model.ts';
import { MascotView } from './view.ts';

/** The one interface the rest of the world has to this page. */
export interface MascotController {
  /** How many inputs are waiting. Clamped to 0..3. */
  setCount(n: number): void;
  getCount(): number;
  /** Clear every timer and take the mascots out of the page. */
  destroy(): void;
}

declare global {
  interface Window {
    aiSmMascot?: MascotController;
    /** Auth token injected at serve time in place of the __AUTH_TOKEN__ placeholder. */
    __AUTH__: string;
  }
}

/**
 * The shortest gap between two reloads after the backend refused the token.
 * The token rotates on every backend restart, so a refused poll means this
 * copy of the page can never be let in again — a reload fetches the page with
 * the new one. Spaced so a backend that refuses for another reason is not
 * hammered.
 */
const AUTH_RELOAD_MS = 30_000;

/**
 * Reload once per `AUTH_RELOAD_MS` at most. The stamp lives in sessionStorage
 * because a reload wipes everything else — a backend that keeps refusing
 * must not turn into a reload every poll.
 */
function reloadForToken(): void {
  const KEY = 'aiSmMascotReloadAt';
  const now = Date.now();
  try {
    const last = Number(window.sessionStorage.getItem(KEY) ?? '0');
    if (Number.isFinite(last) && now - last < AUTH_RELOAD_MS) return;
    window.sessionStorage.setItem(KEY, String(now));
  } catch {
    // No storage: no way to space the reloads, so none at all.
    return;
  }
  window.location.reload();
}

/** GET one JSON route with the page's token. Rejects with `{status}` on a non-2xx. */
async function getJson(path: string): Promise<unknown> {
  const res = await fetch(path, { headers: { 'x-auth-token': window.__AUTH__ }, cache: 'no-store' });
  if (!res.ok) {
    const failure: HttpFailure = { status: res.status };
    throw failure;
  }
  return res.json();
}

/** The WebView2 host's channel, as much of it as this page uses. */
interface HostWindow {
  chrome?: { webview?: { postMessage?: (message: string) => void } };
}

/** The host's `postMessage`, bound — or null outside the host. */
function hostPost(): ((message: string) => void) | null {
  const channel = (window as unknown as HostWindow).chrome?.webview;
  if (channel == null || typeof channel.postMessage !== 'function') return null;
  return (message) => {
    try {
      channel.postMessage?.(message);
    } catch {
      // A host that is closing: the page has nobody left to tell.
    }
  };
}

/** The app's own background (`--color-bg`), painted only in demo mode. */
const DEMO_BG = '#161826';

function mount(root: HTMLElement): MascotController {
  const params = new URLSearchParams(window.location.search);
  const demo = params.has('demo');
  // `?demo` never talks to a host, whatever window it is opened in.
  const reporter = new HostReporter(demo ? null : hostPost());

  // The strip is built after the model, so the model's change callback reaches
  // it through this seam instead of the two knowing about each other.
  let onCount: ((count: number) => void) | null = null;
  const report = (): void => reporter.report(model.getCount(), view.rects());

  const model = new MascotModel({
    onChange: (state) => {
      view.render(state);
      onCount?.(state.count);
      report();
    },
  });

  let feed: MascotFeed | null = null;
  const openTimers = new Set<ReturnType<typeof setTimeout>>();

  const view = new MascotView(root, {
    onPoke: (slot) => {
      // Which session this mascot stands for is decided at the CLICK: the
      // list may reorder while the reaction plays.
      const session = feed?.sessionAt(slot) ?? null;
      const reaction = model.poke(slot);
      if (reaction === null || session === null) return;
      // The design's reaction first, then the app comes forward on it.
      const timer = setTimeout(() => {
        openTimers.delete(timer);
        reporter.open(session);
      }, REACTIONS[reaction].dur);
      openTimers.add(timer);
    },
    onSettle: report,
  });

  view.render(model.snapshot());

  if (demo) {
    onCount = demoStrip(root, model);
    document.body.style.background = DEMO_BG;
    const start = Number(params.get('count') ?? '0');
    model.setCount(start);
    onCount(model.getCount());
  } else {
    feed = new MascotFeed({
      getSessions: () => getJson('/api/sessions'),
      getPrefs: () => getJson('/api/prefs'),
      onCount: (count) => model.setCount(count),
      onAuthLost: reloadForToken,
    });
    // Under visual hosting the page can first lay out at the WebView's
    // pre-bounds size and get its real 220 x 340 a moment later. rects()
    // measures against the viewport, so a report made in between would leave
    // the host's region off the mascot until the next settle: say it again on
    // every resize (the reporter drops a message that did not change).
    window.addEventListener('resize', report);
    // The host shows an empty region until it hears a count; say 0 at once.
    report();
    feed.start();
  }

  return {
    setCount: (n) => model.setCount(n),
    getCount: () => model.getCount(),
    destroy: () => {
      window.removeEventListener('resize', report);
      feed?.stop();
      for (const t of openTimers) clearTimeout(t);
      openTimers.clear();
      model.destroy();
      view.destroy();
    },
  };
}

/**
 * The dev-only strip: what the count is, and the two ways to change it.
 * Buttons, so the keyboard reaches them; no other affordance on the page is
 * interactive. Never rendered without `?demo`.
 */
function demoStrip(root: HTMLElement, model: MascotModel): (count: number) => void {
  const strip = document.createElement('div');
  strip.className = 'pm-demo';

  const label = document.createElement('span');
  strip.appendChild(label);

  const more = document.createElement('button');
  more.type = 'button';
  more.textContent = '+ input';
  more.addEventListener('click', () => model.setCount(model.getCount() + 1));
  strip.appendChild(more);

  const fewer = document.createElement('button');
  fewer.type = 'button';
  fewer.textContent = '− resolved';
  fewer.addEventListener('click', () => model.setCount(model.getCount() - 1));
  strip.appendChild(fewer);

  root.appendChild(strip);

  return (count: number) => {
    label.textContent = `Inputs waiting: ${count}`;
  };
}

const root = document.getElementById('mascot');
if (root instanceof HTMLElement) window.aiSmMascot = mount(root);
