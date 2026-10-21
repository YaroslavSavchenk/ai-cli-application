/**
 * The media viewer's rules (Nocturne D7, `.claude/plans/nocturne/PLAN-D7.md`):
 * which body a media file gets, the Fit / 100 % switch, the bottom bar's size
 * readings, the media URL, and the change comparison the follow tick makes.
 *
 * Pure: no DOM, no app state, no I/O — `ui/media-pane.ts` is the view that
 * draws what these decide, and `node --test` calls them directly. The KIND is
 * the extension, from the one table in `shared/media-kind.ts`.
 */
import { mediaKind, type MediaKind } from '../../../shared/media-kind.ts';
import type { FsMediaTicketResponse } from '../../../shared/protocol.ts';
import { fmtBytes } from './format-model.ts';

/** What a media body is built from. */
export interface MediaPlan {
  kind: MediaKind;
  /**
   * Does the bar offer `Edit as text`? Only an SVG: it is a picture AND a text
   * file (user decision 22). It is drawn with `<img>`, never inlined, so a
   * script inside it never runs.
   */
  editAsText: boolean;
  /**
   * Does a change on disk swap the body by itself? A picture does (decision
   * 23); a video or a PDF does NOT — swapping one under a playing video or an
   * open page would throw the reader's place away — and says
   * `Changed on disk · Reload` instead.
   */
  swapsLive: boolean;
}

/** The body plan for a path, or null when it is no media file (the text editor's). */
export function mediaPlan(path: string): MediaPlan | null {
  const kind = mediaKind(path);
  if (kind === null) return null;
  return {
    kind,
    editAsText: kind === 'image' && /\.svg$/i.test(path),
    swapsLive: kind === 'image',
  };
}

/**
 * The URL an `<img>`, `<video>` or `<iframe>` loads. The `src` cannot carry
 * the auth header, so it carries a TICKET bound to this one path — never the
 * app token (PLAN-D7, Auth).
 */
export function mediaUrl(path: string, ticket: string): string {
  return `/api/fs/media?path=${encodeURIComponent(path)}&t=${encodeURIComponent(ticket)}`;
}

/**
 * The identity of the bytes a ticket answer describes. The follow compares
 * this string tick to tick; no hash is taken (nothing is saved back, so the
 * editor's reason for hashing does not apply). Accepted limit (PLAN-D7): a
 * rewrite of the same size inside the same drvfs second is not seen.
 */
export function mediaStamp(t: Pick<FsMediaTicketResponse, 'size' | 'mtimeMs' | 'ino'>): string {
  return `${t.size}:${t.mtimeMs}:${t.ino}`;
}

/** A picture is shown fitted to the pane, or at its own pixels (the body then scrolls). */
export type FitMode = 'fit' | 'actual';

/** The one control: each press flips between the two. */
export function nextFit(m: FitMode): FitMode {
  return m === 'fit' ? 'actual' : 'fit';
}

/**
 * The switch's text names the mode ON SCREEN — the bar is a statusline, and a
 * statusline reports state. Its tooltip says what a press does.
 */
export function fitLabel(m: FitMode): string {
  return m === 'fit' ? 'Fit' : '100 %';
}

/** The tooltip and accessible name of the switch: what a press does. */
export function fitTitle(m: FitMode): string {
  return m === 'fit' ? 'Show at 100 %' : 'Fit to the pane';
}

/**
 * The bar's size readings: `['1920 × 1080', '284 KB']`. TWO readings, set
 * apart by the bar's spacing — never glued with `·` (README-v3 copy rule,
 * `tests/ui/ui-copy-separators.test.ts`). The pixel size is left out while it
 * is unknown (a PDF has none; a picture or video before it loaded, and an SVG
 * without its own size, answer 0).
 */
export function sizeReadings(width: number, height: number, bytes: number): string[] {
  const size = fmtBytes(bytes);
  if (!(width > 0 && height > 0)) return [size];
  return [`${Math.round(width)} × ${Math.round(height)}`, size];
}

/** A video the browser cannot decode: one sentence, not a black box. */
export const VIDEO_UNPLAYABLE_TEXT = "This video format can't be played here";

/** A picture the browser cannot decode (a `.png` that is really text). */
export const IMAGE_UNREADABLE_TEXT = "This picture can't be shown here";

/** A video or PDF whose file moved on disk: the quiet bar note before `Reload`. */
export const CHANGED_ON_DISK_TEXT = 'Changed on disk';

/** How a media body names itself to a screen reader, by its kind. */
export function mediaNoun(kind: MediaKind): string {
  return kind === 'image' ? 'picture' : kind === 'video' ? 'video' : 'PDF';
}
