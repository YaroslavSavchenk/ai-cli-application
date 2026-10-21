/**
 * The BODY of a media tab — a picture, a video or a PDF opened from the Files
 * panel (Nocturne D7, `.claude/plans/nocturne/PLAN-D7.md`). The tab is an
 * ordinary editor file tab (`ui/editor-pane.ts` chooses this body by
 * `mediaPlan(path)` where it would otherwise build `filePaneBody`), so the
 * strip, persistence, close and the unsaved guard need nothing new; a media
 * tab is never dirty.
 *
 * WHAT IT DRAWS. The `pane-file` card (terminal ground, the 30px bottom bar),
 * with a viewer where the text would be:
 *   - a picture: `<img>` on a checkerboard, fitted to the pane and never
 *     scaled UP past its own pixels, or at 100 % (the body then scrolls); an
 *     SVG is drawn the same way — an `<img>`, never inlined, so no script in it
 *     runs — and its bar offers `Edit as text`;
 *   - a video: the browser's own `<video controls preload="metadata">`, never
 *     autoplaying; a format it cannot decode is one sentence, not a black box;
 *   - a PDF: an `<iframe>` holding the browser's own PDF viewer.
 * The bar reads `1920 × 1080   284 KB` — two readings, spaced, no `·` glyph
 * (README-v3 copy rule) — with no pixel size for a PDF.
 *
 * THE URL CARRIES A TICKET, NEVER THE TOKEN. A `src` cannot send the auth
 * header, so the body first asks for a ticket through the gateway
 * `ui/editor-store.ts` owns (no `../api.ts` import here — the seam that keeps
 * this module drivable under `node --test` against a plain object) and loads
 * `mediaUrl(path, ticket)`. A ticket lives 10 minutes on the server; a video
 * left idle longer that fails on a seek is re-ticketed ONCE and resumed at
 * the same second before the sentence is shown.
 *
 * THE FOLLOW IS THE EDITOR'S ONE CLOCK. The body registers the same
 * `FileFollower` a text body does — never dirty, its stamp the
 * `size:mtimeMs:ino` of the last ticket — so a media tab adds no timer. Each
 * tick asks for a fresh ticket and compares the triple:
 *   - a picture that changed is loaded into an OFF-SCREEN `<img>` and swapped
 *     in only once it decoded (no flash, no broken frame of a file still being
 *     written); a decode error keeps the old picture and the next tick tries
 *     again, because the stamp it compares against did not move;
 *   - a video or a PDF is NOT swapped under the reader: the bar says
 *     `Changed on disk · Reload`, and Reload swaps;
 *   - a file that is gone (404) or refused is the editor's own sentence
 *     treatment, and the follow then leaves the body alone.
 */
import { el, button } from './util.ts';
import { LOADING_TEXT, messageOf } from './fs-model.ts';
import { sentenceTone, statusOf } from './editor-model.ts';
import { fileName } from './slots-model.ts';
import { editorMediaTicket, registerBody, unregisterBody, type FileFollower } from './editor-store.ts';
import {
  CHANGED_ON_DISK_TEXT,
  IMAGE_UNREADABLE_TEXT,
  VIDEO_UNPLAYABLE_TEXT,
  fitLabel,
  fitTitle,
  mediaNoun,
  mediaStamp,
  mediaUrl,
  nextFit,
  sizeReadings,
  type FitMode,
  type MediaPlan,
} from './media-model.ts';
import type { PaneBody } from './file-pane.ts';
import type { FsMediaTicketResponse } from '../../../shared/protocol.ts';

/**
 * Build the body for one media file. `plan` is `mediaPlan(path)`, already
 * known to be non-null by the caller; `onEditAsText` opens the same path in
 * the text editor as a second tab (an SVG only — `plan.editAsText`).
 */
export function mediaPaneBody(path: string, plan: MediaPlan, onEditAsText: () => void): PaneBody {
  const name = fileName(path);
  const root = el('div', 'pane-file pane-media');
  const stage = el('div', 'pane-mstage');
  // Focusable on purpose: at 100 % the arrow keys scroll the picture, and Tab
  // from here walks into the video's controls or the PDF viewer — the
  // keyboard always has a place in the body without being trapped in a frame.
  stage.setAttribute('tabindex', '0');
  stage.setAttribute('aria-label', `${name}, ${mediaNoun(plan.kind)}`);

  // THE BAR IS BUILT ONCE and its parts shown or hidden: a bar redrawn under
  // the user's hands would drop the keyboard off the Fit switch it just pressed.
  const bar = el('div', 'pane-fbar');
  const size = el('span', 'pane-msize');
  const pixels = el('span', 'pane-msize');
  const note = el('span', 'pane-mnote', CHANGED_ON_DISK_TEXT);
  note.setAttribute('role', 'status');
  const reload = button('pane-fact', 'Reload', () => reloadNow());
  reload.title = 'Load the new version from disk';
  bar.append(pixels, size, note, reload, el('span', 'pane-gap'));
  let fit: FitMode = 'fit';
  if (plan.kind === 'image') {
    const fitBtn = button('pane-fact pane-mfit', fitLabel(fit), () => {
      fit = nextFit(fit);
      stage.classList.toggle('is-actual', fit === 'actual');
      fitBtn.textContent = fitLabel(fit);
      fitBtn.title = fitTitle(fit);
      fitBtn.setAttribute('aria-label', fitTitle(fit));
    });
    fitBtn.title = fitTitle(fit);
    fitBtn.setAttribute('aria-label', fitTitle(fit));
    bar.append(fitBtn);
  }
  if (plan.editAsText) {
    const text = button('pane-fact', 'Edit as text', () => onEditAsText());
    text.title = 'Open this file in the text editor';
    bar.append(text);
  }

  /** The `size:mtimeMs:ino` on screen; null before the first ticket and after a refusal. */
  let stamp: string | null = null;
  let bytes = 0;
  let width = 0;
  let height = 0;
  /** Tickets and off-screen decodes still out (the follow skips a body with any). */
  let outstanding = 0;
  /** A video or PDF whose file moved: the bar offers Reload. */
  let changed = false;
  let disposed = false;
  /** The `<img>` / `<video>` / `<iframe>` on screen, or null while there is none. */
  let media: HTMLElement | null = null;
  /** The `<video>` on screen, when `media` is one — `dispose` pauses it. */
  let playable: HTMLVideoElement | null = null;

  const follower: FileFollower = {
    root,
    dirty: () => false,
    inFlight: () => outstanding > 0,
    stamp: () => stamp,
    follow: () => followNow(),
  };
  registerBody(follower);

  // `Loading…` in the quiet ink, in the slot a refusal would take — the text
  // body's own first frame.
  root.append(el('p', 'pane-fempty', LOADING_TEXT));
  ask((res) => show(res), (err) => showSentence(messageOf(err), sentenceTone(statusOf(err))));

  /**
   * One ticket. A body given up while the answer was out does nothing with it:
   * a pane that is gone must not repaint.
   */
  function ask(ok: (res: FsMediaTicketResponse) => void, fail: (err: unknown) => void): void {
    outstanding += 1;
    editorMediaTicket(path)
      .then((res) => {
        outstanding -= 1;
        if (!disposed) ok(res);
      })
      .catch((err: unknown) => {
        outstanding -= 1;
        if (!disposed) fail(err);
      });
  }

  /** Put the viewer for these bytes on screen — the first one, and every Reload. */
  function show(res: FsMediaTicketResponse): void {
    take(res);
    changed = false;
    const url = mediaUrl(path, res.ticket);
    media = plan.kind === 'image' ? firstPicture(url) : plan.kind === 'video' ? video(url) : pdf(url);
    stage.replaceChildren(media);
    root.replaceChildren(stage, bar);
    drawBar();
  }

  /** What a ticket says about the file, now on screen. */
  function take(res: FsMediaTicketResponse): void {
    stamp = mediaStamp(res);
    bytes = res.size;
  }

  /** An `<img>` that reports when it decoded, or could not. */
  function picture(
    url: string,
    onLoad: (img: HTMLImageElement) => void,
    onFail: (img: HTMLImageElement) => void,
  ): HTMLImageElement {
    const img = el('img', 'pane-mimg');
    img.alt = name;
    img.addEventListener('load', () => onLoad(img));
    img.addEventListener('error', () => onFail(img));
    img.src = url;
    return img;
  }

  /** The first picture goes straight on screen; a decode error is the sentence. */
  function firstPicture(url: string): HTMLImageElement {
    return picture(
      url,
      (img) => {
        if (img !== media) return;
        width = img.naturalWidth;
        height = img.naturalHeight;
        drawBar();
      },
      (img) => {
        if (img === media) showSentence(IMAGE_UNREADABLE_TEXT, 'bad');
      },
    );
  }

  function video(url: string): HTMLVideoElement {
    const v = el('video', 'pane-mvideo');
    v.controls = true;
    v.preload = 'metadata';
    v.autoplay = false;
    v.playsInline = true;
    v.setAttribute('aria-label', `${name}, video`);
    playable = v;
    /** One re-ticket per failure: spent on an error, earned back by real playback. */
    let retried = false;
    let playing = false;
    let resume: { at: number; play: boolean } | null = null;
    v.addEventListener('play', () => {
      playing = true;
    });
    v.addEventListener('pause', () => {
      playing = false;
    });
    v.addEventListener('playing', () => {
      retried = false;
    });
    v.addEventListener('loadedmetadata', () => {
      width = v.videoWidth;
      height = v.videoHeight;
      if (resume !== null) {
        v.currentTime = resume.at;
        if (resume.play) v.play().catch(() => {});
        resume = null;
      }
      drawBar();
    });
    v.addEventListener('error', () => {
      if (v !== media) return;
      if (retried) {
        // Decoded nothing even on a fresh ticket: the format is the reason.
        // The SENTENCE takes the stage; the bar and the follow stay, so a
        // re-encoded file on disk still offers Reload.
        const line = el('p', 'pane-fempty is-bad', VIDEO_UNPLAYABLE_TEXT);
        stage.replaceChildren(line);
        return;
      }
      // A ticket that expired (10 min) or was dropped answers 403 on the next
      // range request — a seek after a long pause. Ask once more and resume
      // where the reader was.
      retried = true;
      resume = { at: v.currentTime || 0, play: playing };
      ask(
        (res) => {
          if (v !== media) return;
          take(res);
          changed = false;
          v.src = mediaUrl(path, res.ticket);
          drawBar();
        },
        (err) => showSentence(messageOf(err), sentenceTone(statusOf(err))),
      );
    });
    v.src = url;
    return v;
  }

  function pdf(url: string): HTMLIFrameElement {
    const f = el('iframe', 'pane-mpdf');
    f.title = `${name}, PDF`;
    f.src = url;
    return f;
  }

  /**
   * The sentence branch, the text body's own: the server's line (quiet for a
   * file that is gone, danger ink for a refusal), and nothing else. `stamp`
   * goes null so the follow stops asking a refused question every 5 s.
   */
  function showSentence(text: string, tone: 'quiet' | 'bad'): void {
    stamp = null;
    media = null;
    playable = null;
    changed = false;
    const line = el('p', 'pane-fempty', text);
    if (tone === 'bad') line.classList.add('is-bad');
    root.replaceChildren(line);
  }

  /** One follow tick (`ui/editor-store.ts` decides WHEN). */
  function followNow(): void {
    const sent = stamp;
    ask(
      (res) => {
        // A Reload or a re-ticket that landed while this was out owns the body.
        if (stamp !== sent || media === null) return;
        if (mediaStamp(res) === stamp) return;
        if (!plan.swapsLive) {
          changed = true;
          drawBar();
          return;
        }
        swapPicture(res);
      },
      (err) => {
        if (stamp !== sent) return;
        // NO STATUS = NO ANSWER (the backend restarting): the picture on screen
        // is still the truth, and the next tick asks again. A status is the
        // server's word — gone, or refused — and takes the body.
        if (statusOf(err) === null) return;
        showSentence(messageOf(err), sentenceTone(statusOf(err)));
      },
    );
  }

  /**
   * Decode the new picture OFF SCREEN, then swap. Counted as a request out, so
   * no second tick starts another decode of the same file meanwhile.
   */
  function swapPicture(res: FsMediaTicketResponse): void {
    const before = stamp;
    outstanding += 1;
    picture(
      mediaUrl(path, res.ticket),
      (img) => {
        outstanding -= 1;
        if (disposed || stamp !== before || media === null) return;
        stage.replaceChildren(img);
        media = img;
        take(res);
        width = img.naturalWidth;
        height = img.naturalHeight;
        drawBar();
      },
      () => {
        // A half-written file: keep the old picture. `stamp` did not move, so
        // the next tick sees the change again and tries again.
        outstanding -= 1;
      },
    );
  }

  /** Reload (a video or a PDF that changed): a fresh ticket, a fresh viewer. */
  function reloadNow(): void {
    if (outstanding > 0) return;
    ask(
      (res) => {
        show(res);
        // The Reload button just hid itself; the keyboard stays in the body.
        stage.focus();
      },
      (err) => showSentence(messageOf(err), sentenceTone(statusOf(err))),
    );
  }

  function drawBar(): void {
    const [first, second] = sizeReadings(width, height, bytes);
    // Pixels first, bytes second; with no pixel size the bytes stand alone.
    pixels.hidden = second === undefined;
    pixels.textContent = second === undefined ? '' : (first as string);
    size.textContent = second ?? first ?? '';
    note.hidden = !changed;
    reload.hidden = !changed;
  }

  function dispose(): void {
    disposed = true;
    // A video given up mid-play must not keep streaming from the backend.
    playable?.pause();
    unregisterBody(follower);
  }

  return {
    root,
    focus: () => {
      if (media !== null) stage.focus();
    },
    // Nothing in a media body depends on state the pane redraws for.
    update: () => {},
    dispose,
  };
}
