/**
 * Which files the media viewer opens, and what Content-Type each is served as
 * (Nocturne D7, `.claude/plans/nocturne/PLAN-D7.md`). The EXTENSION decides,
 * case-insensitively, from the one table below — no byte sniffing anywhere.
 * The server serves `GET /api/fs/media` with exactly this Content-Type (an
 * extension outside the table is refused); the browser opens a media tab for
 * exactly these kinds.
 *
 * Pure: no I/O.
 */

export type MediaKind = 'image' | 'video' | 'pdf';

/** Extension (lower case, no dot) → its kind and Content-Type. No audio (user decision). */
const MEDIA_TABLE: ReadonlyMap<string, { kind: MediaKind; type: string }> = new Map([
  ['png', { kind: 'image', type: 'image/png' }],
  ['jpg', { kind: 'image', type: 'image/jpeg' }],
  ['jpeg', { kind: 'image', type: 'image/jpeg' }],
  ['gif', { kind: 'image', type: 'image/gif' }],
  ['webp', { kind: 'image', type: 'image/webp' }],
  ['avif', { kind: 'image', type: 'image/avif' }],
  ['bmp', { kind: 'image', type: 'image/bmp' }],
  ['ico', { kind: 'image', type: 'image/x-icon' }],
  ['svg', { kind: 'image', type: 'image/svg+xml' }],
  ['mp4', { kind: 'video', type: 'video/mp4' }],
  ['webm', { kind: 'video', type: 'video/webm' }],
  ['mov', { kind: 'video', type: 'video/quicktime' }],
  ['m4v', { kind: 'video', type: 'video/mp4' }],
  ['mkv', { kind: 'video', type: 'video/x-matroska' }],
  ['ogv', { kind: 'video', type: 'video/ogg' }],
  ['pdf', { kind: 'pdf', type: 'application/pdf' }],
]);

/** The table row for a path's extension; null for none or one outside the table. */
function mediaEntry(path: string): { kind: MediaKind; type: string } | null {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return null;
  return MEDIA_TABLE.get(name.slice(dot + 1).toLowerCase()) ?? null;
}

/** The media kind of a path by its extension; null when the viewer does not open it. */
export function mediaKind(path: string): MediaKind | null {
  return mediaEntry(path)?.kind ?? null;
}

/** The Content-Type a media path is served as; null outside the table. */
export function mediaContentType(path: string): string | null {
  return mediaEntry(path)?.type ?? null;
}
