/**
 * The media BODY (Nocturne D7, `.claude/plans/nocturne/PLAN-D7.md`): the real
 * `web/src/ui/media-pane.ts` and `ui/editor-store.ts` on the DOM double, the
 * backend the fake gateway in `tests/helpers/editor-fixture.ts` (its media
 * half). Every `<img>`, `<video>` and `<iframe>` the body creates is recorded
 * by a hook on `document.createElement`, so a test can play the browser: set
 * `naturalWidth` and dispatch `load`, or dispatch `error`.
 *
 * What: the ticket is asked through the gateway and the src is the ticket URL;
 * the bar's size readings, Fit / 100 %, Edit as text; the follow rides the ONE
 * interval (a media body arms no timer of its own); a changed picture decodes
 * off screen and swaps only after `load`, a decode error keeps the old one and
 * retries; a video or PDF says `Changed on disk` and swaps only on Reload; a
 * video error re-tickets once, then says the format sentence; a vanished file
 * is the quiet sentence and the follow stops.
 *
 * Why: a body that swapped a half-written picture, reloaded a playing video,
 * or kept polling a file that is gone does it silently.
 *
 * NOT claimed: real decoding, layout, the checkerboard, the WebView2 PDF
 * viewer, Range seeking — the browser and the user's dev-window check
 * (PLAN-D7 § Phases 3).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  buttonByLabel,
  byClass,
  dispatch,
  installDom,
  oneByClass,
  type FakeElement,
} from '../helpers/fake-dom.ts';
import { settle } from '../helpers/fs-fixture.ts';
import { GONE_TEXT, NO_READ_TEXT, makeEditor } from '../helpers/editor-fixture.ts';

const dom = installDom();

interface Body {
  root: FakeElement;
  focus(): void;
  update(): void;
  dispose(): void;
}
interface Plan {
  kind: 'image' | 'video' | 'pdf';
  editAsText: boolean;
  swapsLive: boolean;
}
const MP = (await import(new URL('../../web/src/ui/media-pane.ts', import.meta.url).href)) as {
  mediaPaneBody(path: string, plan: Plan, onEditAsText: () => void): Body;
};
const MM = (await import(new URL('../../web/src/ui/media-model.ts', import.meta.url).href)) as {
  mediaPlan(path: string): Plan | null;
  mediaUrl(path: string, ticket: string): string;
  VIDEO_UNPLAYABLE_TEXT: string;
  IMAGE_UNREADABLE_TEXT: string;
  CHANGED_ON_DISK_TEXT: string;
};
const ES = (await import(new URL('../../web/src/ui/editor-store.ts', import.meta.url).href)) as {
  setEditorGateway(gw: unknown): void;
  followerCount(): number;
  followTick(): void;
  FOLLOW_MS: number;
};
const ed = makeEditor();
ES.setEditorGateway(ed.gateway);

const PNG = '/home/you/build/renders/smoke/front.png';
const SVG = '/home/you/art/logo.svg';
const MP4 = '/home/you/clips/demo.mp4';
const PDF = '/home/you/docs/spec.pdf';

/** Every media element the body made, in order, with the double's play/pause. */
let made: FakeElement[] = [];
const create = dom.doc.createElement;
dom.doc.createElement = (tag: string): FakeElement => {
  const n = create(tag);
  if (tag === 'img' || tag === 'video' || tag === 'iframe') {
    made.push(n);
    const m = n as unknown as Record<string, unknown>;
    m.paused = true;
    m.pause = () => {
      m.paused = true;
    };
    m.play = () => Promise.resolve();
  }
  return n;
};

let live: Body[] = [];
let editAsText = 0;

async function mount(path: string): Promise<Body> {
  const plan = MM.mediaPlan(path);
  assert.ok(plan !== null, `${path} is media`);
  const body = MP.mediaPaneBody(path, plan, () => {
    editAsText += 1;
  });
  live.push(body);
  dom.body.append(body.root);
  await settle();
  return body;
}

/** Play the browser: the element decoded, at this pixel size. */
function loaded(n: FakeElement, w: number, h: number): void {
  const m = n as unknown as Record<string, unknown>;
  m.naturalWidth = w;
  m.naturalHeight = h;
  m.videoWidth = w;
  m.videoHeight = h;
  dispatch(n, n.tagName === 'VIDEO' ? 'loadedmetadata' : 'load');
}

function srcOf(n: FakeElement | undefined): string {
  return String((n as unknown as { src?: unknown } | undefined)?.src ?? '');
}

function onScreen(root: FakeElement, cls: string): FakeElement | undefined {
  return byClass(root, cls)[0];
}

/** The bar's size readings that are shown, in order. */
function readings(root: FakeElement): string[] {
  return byClass(root, 'pane-msize')
    .filter((n) => !n.hidden)
    .map((n) => n.textContent);
}

function tick(): void {
  ES.followTick();
}

beforeEach(() => {
  ed.releaseTickets();
  for (const b of live) b.dispose();
  live = [];
  made = [];
  editAsText = 0;
  dom.body.replaceChildren();
  ed.tickets.length = 0;
  ed.issued.length = 0;
  ed.setMedia(PNG, { size: 284 * 1024, mtimeMs: 1000, ino: 11 });
  ed.setMedia(SVG, { size: 812, mtimeMs: 1000, ino: 12 });
  ed.setMedia(MP4, { size: 48 * 1024 * 1024, mtimeMs: 1000, ino: 13 });
  ed.setMedia(PDF, { size: 90 * 1024, mtimeMs: 1000, ino: 14 });
  dom.doc.visibilityState = 'visible';
});

// ---------------------------------------------------------------------------
// The first frame
// ---------------------------------------------------------------------------

test('a picture asks ONE ticket and loads the ticket URL; the bar names pixels and bytes', async () => {
  const { root } = await mount(PNG);
  assert.deepEqual(ed.tickets, [PNG], 'one ticket, through the gateway');
  const img = onScreen(root, 'pane-mimg');
  assert.ok(img !== undefined, 'an <img> is on screen');
  assert.equal(srcOf(img), MM.mediaUrl(PNG, ed.issued[0] as string), 'the src is the ticket URL');
  assert.equal(img.getAttribute('alt') ?? (img as unknown as { alt: string }).alt, 'front.png');
  loaded(img, 1920, 1080);
  assert.deepEqual(readings(root), ['1920 × 1080', '284 KB']);
  assert.equal(byClass(root, 'pane-fact').some((b) => b.textContent === 'Edit as text'), false, 'only an SVG offers it');
});

test('Fit / 100 %: one switch, the stage scrolls only at 100 %, the keyboard stays on it', async () => {
  const { root } = await mount(PNG);
  const stage = oneByClass(root, 'pane-mstage');
  const fit = oneByClass(root, 'pane-mfit');
  assert.equal(fit.textContent, 'Fit');
  assert.equal(stage.classList.contains('is-actual'), false, 'fitted by default');
  fit.focus();
  fit.click();
  assert.equal(fit.textContent, '100 %');
  assert.equal(stage.classList.contains('is-actual'), true);
  assert.equal(dom.doc.activeElement, fit, 'the bar is not rebuilt under the press');
  assert.ok(oneByClass(root, 'pane-mfit') === fit, 'the same node');
  fit.click();
  assert.equal(stage.classList.contains('is-actual'), false, 'and back');
});

test('an SVG is an <img>, never inline markup, and Edit as text asks the pane to open the text view', async () => {
  const { root } = await mount(SVG);
  assert.equal(onScreen(root, 'pane-mimg')?.tagName, 'IMG', 'drawn as a picture, so no script in it runs');
  assert.equal(byClass(root, 'pane-mstage')[0]?.children.length, 1, 'nothing but the <img>');
  buttonByLabel(root, 'Edit as text').click();
  assert.equal(editAsText, 1);
});

test('a video is <video controls preload=metadata>, never autoplaying', async () => {
  const { root } = await mount(MP4);
  const v = onScreen(root, 'pane-mvideo') as FakeElement;
  const m = v as unknown as Record<string, unknown>;
  assert.equal(m.controls, true);
  assert.equal(m.preload, 'metadata');
  assert.equal(m.autoplay, false);
  assert.equal(srcOf(v), MM.mediaUrl(MP4, ed.issued[0] as string));
  loaded(v, 1280, 720);
  assert.deepEqual(readings(root), ['1280 × 720', '48 MB']);
  assert.equal(byClass(root, 'pane-mfit').length, 0, 'Fit / 100 % is a picture control');
});

test('a PDF is an <iframe> on the ticket URL, and its bar names only the size', async () => {
  const { root } = await mount(PDF);
  const f = onScreen(root, 'pane-mpdf') as FakeElement;
  assert.equal(f.tagName, 'IFRAME');
  assert.equal(srcOf(f), MM.mediaUrl(PDF, ed.issued[0] as string));
  assert.deepEqual(readings(root), ['90 KB']);
});

test('a refused ticket is the server sentence in danger ink; a vanished file the quiet one', async () => {
  ed.failTicket(PNG, 403, NO_READ_TEXT);
  const refused = (await mount(PNG)).root;
  const line = oneByClass(refused, 'pane-fempty');
  assert.equal(line.textContent, NO_READ_TEXT);
  assert.equal(line.classList.contains('is-bad'), true);
  ed.removeFile(SVG);
  const gone = oneByClass((await mount(SVG)).root, 'pane-fempty');
  assert.equal(gone.textContent, GONE_TEXT);
  assert.equal(gone.classList.contains('is-bad'), false, 'gone is a fact, not a failure');
});

test('a picture that cannot be decoded says so instead of a broken frame', async () => {
  const { root } = await mount(PNG);
  dispatch(onScreen(root, 'pane-mimg') as FakeElement, 'error');
  assert.equal(oneByClass(root, 'pane-fempty').textContent, MM.IMAGE_UNREADABLE_TEXT);
  assert.equal(byClass(root, 'pane-mimg').length, 0);
});

// ---------------------------------------------------------------------------
// The follow — the editor's one clock
// ---------------------------------------------------------------------------

test('a media body rides the ONE follow interval: no timer of its own, one ticket per tick', async () => {
  assert.equal(dom.win.intervals.length, 0, 'non-vacuity: no body, no clock');
  await mount(PNG);
  await mount(MP4);
  await mount(PDF);
  assert.equal(dom.win.intervals.length, 1, 'three media bodies, ONE interval');
  assert.equal((dom.win.intervals[0] as { ms: number }).ms, ES.FOLLOW_MS);
  assert.equal(dom.win.timers.length, 0, 'and no timeout either');
  ed.tickets.length = 0;
  (dom.win.intervals[0] as { fn: () => void }).fn();
  await settle();
  assert.deepEqual([...ed.tickets].sort(), [MP4, PDF, PNG].sort(), 'one ticket per visible body');
});

test('an unchanged picture is left alone: no new <img>, the same node on screen', async () => {
  const { root } = await mount(PNG);
  const img = onScreen(root, 'pane-mimg');
  const count = made.length;
  tick();
  await settle();
  assert.equal(made.length, count, 'nothing decoded');
  assert.equal(onScreen(root, 'pane-mimg'), img);
});

test('a changed picture decodes OFF SCREEN and swaps only after it loaded', async () => {
  const { root } = await mount(PNG);
  const old = onScreen(root, 'pane-mimg') as FakeElement;
  loaded(old, 100, 50);
  ed.setMedia(PNG, { size: 300 * 1024, mtimeMs: 2000, ino: 11 });
  tick();
  await settle();
  const probe = made.at(-1) as FakeElement;
  assert.notEqual(probe, old, 'a second <img> was made');
  assert.equal(probe.isConnected, false, 'off screen while it decodes');
  assert.equal(onScreen(root, 'pane-mimg'), old, 'the old picture stays until then');
  assert.equal(srcOf(probe), MM.mediaUrl(PNG, ed.issued[1] as string), 'on the NEW ticket');
  loaded(probe, 200, 80);
  assert.equal(onScreen(root, 'pane-mimg'), probe, 'swapped in once decoded');
  assert.deepEqual(readings(root), ['200 × 80', '300 KB']);
});

test('a decode error mid-write keeps the old picture, and the next tick tries again', async () => {
  const { root } = await mount(PNG);
  const old = onScreen(root, 'pane-mimg') as FakeElement;
  ed.setMedia(PNG, { size: 1, mtimeMs: 2000, ino: 11 });
  tick();
  await settle();
  dispatch(made.at(-1) as FakeElement, 'error');
  assert.equal(onScreen(root, 'pane-mimg'), old, 'no broken frame');
  assert.equal(byClass(root, 'pane-fempty').length, 0, 'and no sentence');
  ed.tickets.length = 0;
  tick();
  await settle();
  assert.deepEqual(ed.tickets, [PNG], 'asked again');
  const retry = made.at(-1) as FakeElement;
  assert.notEqual(retry, old);
  loaded(retry, 10, 10);
  assert.equal(onScreen(root, 'pane-mimg'), retry);
});

test('a decode still out holds the next tick back — no second decode of the same file', async () => {
  await mount(PNG);
  ed.setMedia(PNG, { size: 5, mtimeMs: 2000, ino: 11 });
  tick();
  await settle();
  ed.tickets.length = 0;
  tick();
  await settle();
  assert.deepEqual(ed.tickets, [], 'the body is in flight');
  assert.equal(made.length, 2, 'the first picture and ONE off-screen decode');
});

test('a changed video is NOT swapped: the bar says Changed on disk, and Reload swaps', async () => {
  const { root } = await mount(MP4);
  const v = onScreen(root, 'pane-mvideo') as FakeElement;
  const note = oneByClass(root, 'pane-mnote');
  const reload = buttonByLabel(root, 'Reload');
  assert.equal(note.hidden, true, 'quiet until something changed');
  assert.equal(reload.hidden, true);
  ed.setMedia(MP4, { size: 49 * 1024 * 1024, mtimeMs: 2000, ino: 13 });
  tick();
  await settle();
  assert.equal(onScreen(root, 'pane-mvideo'), v, 'the playing video stays');
  assert.equal(srcOf(v), MM.mediaUrl(MP4, ed.issued[0] as string), 'on its old URL');
  assert.equal(note.hidden, false);
  assert.equal(note.textContent, MM.CHANGED_ON_DISK_TEXT);
  assert.equal(reload.hidden, false);
  reload.click();
  await settle();
  const fresh = onScreen(root, 'pane-mvideo') as FakeElement;
  assert.notEqual(fresh, v, 'Reload built the new one');
  assert.equal(srcOf(fresh), MM.mediaUrl(MP4, ed.issued[2] as string));
  assert.equal(oneByClass(root, 'pane-mnote').hidden, true, 'and the note went');
});

test('a changed PDF waits for Reload the same way', async () => {
  const { root } = await mount(PDF);
  const f = onScreen(root, 'pane-mpdf');
  ed.setMedia(PDF, { size: 91 * 1024, mtimeMs: 2000, ino: 14 });
  tick();
  await settle();
  assert.equal(onScreen(root, 'pane-mpdf'), f);
  assert.equal(oneByClass(root, 'pane-mnote').hidden, false);
});

test('a video error re-tickets ONCE and resumes at the same second; a second error is the sentence', async () => {
  const { root } = await mount(MP4);
  const v = onScreen(root, 'pane-mvideo') as FakeElement;
  const m = v as unknown as Record<string, unknown>;
  let played = 0;
  m.play = () => {
    played += 1;
    return Promise.resolve();
  };
  dispatch(v, 'play');
  m.currentTime = 42;
  dispatch(v, 'error');
  await settle();
  assert.equal(srcOf(v), MM.mediaUrl(MP4, ed.issued[1] as string), 'a fresh ticket on the same element');
  m.currentTime = 0;
  loaded(v, 640, 360);
  assert.equal(m.currentTime, 42, 'resumed where the reader was');
  assert.equal(played, 1, 'and playing again, as it was');
  dispatch(v, 'error');
  await settle();
  assert.equal(oneByClass(root, 'pane-fempty').textContent, MM.VIDEO_UNPLAYABLE_TEXT);
  assert.equal(byClass(root, 'pane-mvideo').length, 0, 'not a black box');
  assert.equal(byClass(root, 'pane-fbar').length, 1, 'the bar stays: a re-encoded file still offers Reload');
});

test('a vanished file is the quiet sentence, and the follow stops asking', async () => {
  const { root } = await mount(PNG);
  ed.removeFile(PNG);
  tick();
  await settle();
  assert.equal(oneByClass(root, 'pane-fempty').textContent, GONE_TEXT);
  ed.tickets.length = 0;
  tick();
  await settle();
  assert.deepEqual(ed.tickets, [], 'a refused question is not re-asked every 5 s');
});

test('a ticket that fails with no status (backend away) keeps the picture and asks again', async () => {
  const { root } = await mount(PNG);
  const img = onScreen(root, 'pane-mimg');
  const gw = ed.gateway.mediaTicket;
  ed.gateway.mediaTicket = () => Promise.reject(new TypeError('Failed to fetch'));
  try {
    tick();
    await settle();
  } finally {
    ed.gateway.mediaTicket = gw;
  }
  assert.equal(onScreen(root, 'pane-mimg'), img, 'still on screen');
  ed.tickets.length = 0;
  tick();
  await settle();
  assert.deepEqual(ed.tickets, [PNG], 'and the follow keeps going');
});

test('a parked body is not polled, and a disposed one leaves the follow and stops its video', async () => {
  const body = await mount(MP4);
  const n = ES.followerCount();
  body.root.remove();
  ed.tickets.length = 0;
  tick();
  await settle();
  assert.deepEqual(ed.tickets, [], 'detached = parked');
  const v = made.at(-1) as unknown as { paused: boolean };
  v.paused = false;
  body.dispose();
  assert.equal(ES.followerCount(), n - 1);
  assert.equal(v.paused, true, 'no stream left running');
});

test('focus() lands on the stage — a keyboard place in the body, not inside a frame', async () => {
  const { root, focus } = await mount(PDF);
  focus();
  assert.equal(dom.doc.activeElement, oneByClass(root, 'pane-mstage'));
  assert.equal(oneByClass(root, 'pane-mstage').getAttribute('tabindex'), '0');
});

test('a picture that decodes after its body was given up is not swapped in', async () => {
  const body = await mount(PNG);
  const old = onScreen(body.root, 'pane-mimg') as FakeElement;
  ed.setMedia(PNG, { size: 9, mtimeMs: 2000, ino: 11 });
  tick();
  await settle();
  const probe = made.at(-1) as FakeElement;
  assert.notEqual(probe, old, 'non-vacuity: a decode was started');
  body.dispose();
  loaded(probe, 30, 30);
  assert.equal(onScreen(body.root, 'pane-mimg'), old, 'a body that is gone does not repaint');
});
