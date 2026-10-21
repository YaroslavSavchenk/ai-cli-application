# D7 — Media viewer: click a png, jpeg, mp4 or pdf in the Files panel and see the picture, the video or the document

Status: LANDED 2026-10-21 (branch `d7-media-viewer`; the user's dev-window check owed); earlier: DECIDED 2026-10-21 (the user's ask the same day — "de png, jpeg, mp4, etc gebruikerlijk maken … dat je gwn een picture krijgt ofzo of een video"; decisions 20–23 of `.claude/plans/PLAN-NOCTURNE.md` asked the same day).

Part D7 of `.claude/plans/PLAN-NOCTURNE.md` (Track D, fixes and asks after the v0.4.0 release). Conventions: `.claude/plans/README.md`.

## What the user gets

- A click (or Open from the row menu, or Enter) on an image, a video or a PDF in the Files panel opens it as a **file tab in the editor pane**, exactly where a text file opens today — but the body is a viewer, not the editor.
  - **Images** (`png jpg jpeg gif webp avif bmp ico svg`): the picture fitted to the pane, never scaled UP past its own size; a checkerboard behind transparency; one control to switch between Fit and 100 % (at 100 % the body scrolls). The bottom bar names the pixel size and the file size as two readings (`1920 × 1080`  `284 KB` — no `·`: the README-v3 copy rule, `tests/ui/ui-copy-separators.test.ts`).
  - **Video** (`mp4 webm mov m4v mkv ogv`): the browser's own `<video controls>`, fitted to the pane, seeking works on a large file (Range streaming). It never autoplays. A format WebView2 cannot decode is one sentence ("This video format can't be played here"), not an empty black box.
  - **PDF**: the WebView2 built-in PDF viewer filling the body.
- **SVG** opens as a picture, with an **Edit as text** action in the bottom bar that opens the same file in the text editor (a second tab of the editor kind).
- **Live reload**: when the file changes on disk (a renderer writes `build/renders/smoke/front.png` again), an image tab shows the new picture by itself, on the editor's existing 5 s follow rhythm. A video or PDF tab does NOT swap under a playing video or an open page; it shows a quiet `Changed on disk` with a `Reload` action in its bottom bar instead.
- Everything else opens in the text editor as it does today, including the existing 415 sentence for any other binary.

## Found 2026-10-21 (line numbers drift)

- A click opens through `openFileGuarded()` (`web/src/ui/unsaved.ts` ~:263), called from `files-tree.ts` ~:341, `files-menu.ts` ~:67, `files-git.ts` ~:366, `files-naming.ts` ~:283. The tab is an editor tab (`fileTabSpec`, `web/src/ui/editor-pane.ts` ~:75; tab ids in `web/src/ui/editor-model.ts` ~:56). The body is `filePaneBody()` (`web/src/ui/file-pane.ts` ~:99), which reads through the `editor-store.ts` gateway.
- Today a png answers `GET /api/fs/read` with 415 "not text" (`server/fstext.ts` ~:477), and the body renders that sentence.
- Every `/api` route requires the `X-Auth-Token` header (`server/api.ts` ~:363). An `<img>`, `<video>` or `<iframe>` `src` cannot send a header; only the WebSocket upgrade accepts `?token=` (`server/ws.ts` ~:118).
- The follow loop: ONE `window.setInterval` for every file body on screen, `FOLLOW_MS = 5000` (`web/src/ui/editor-store.ts` ~:52, `registerBody`/`followTick`).
- Boundary + safe open for reads: `resolveUnderAllowed()`, `isUnderDataDir()`, `O_NOFOLLOW|O_NONBLOCK` + `fstat` must say a regular file (`server/fstext.ts` header § WHAT KEEPS BOTH ROUTES INSIDE THE BOUNDARY; Q8 made every data-dir reader FIFO-safe the same way).
- Static content types: `server/api.ts` ~:144 (only for the app's own assets).
- WebView2 host: navigation locked to `127.0.0.1:<port>`; a same-origin `<iframe>` holding a PDF is not a navigation of the top frame.

## Decided (user, 2026-10-21) — do not re-ask

1. Formats: images, video and PDF. NOT audio (decision 20).
2. A media file opens as a file tab in the editor pane, not in an overlay (decision 21).
3. SVG opens as a picture, with Edit as text (decision 22).
4. An image refreshes by itself when the file changes on disk (decision 23).

## Defaults (orchestrator, within the decisions — not asked)

- **The kind is the EXTENSION**, case-insensitive, one pure table in `shared/media-kind.ts`: `mediaKind(path): 'image' | 'video' | 'pdf' | null` and `mediaContentType(path): string | null`. No byte sniffing: a `.png` that is really text simply fails to render and says so.
- **One read route, streamed, with Range**: `GET /api/fs/media?path=<abs>&t=<ticket>`. It answers `200` or `206` (`Accept-Ranges: bytes`, one range only; a multi-range or unsatisfiable `Range` is `416`), `Content-Type` from the table ONLY (an extension outside it is `415`, nothing served), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`, CORP `same-origin`, `X-Frame-Options: SAMEORIGIN`, and on SVG ONLY `Content-Security-Policy: sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'` (an SVG opened directly runs no script; Chromium's PDF viewer refuses a sandboxed document, so PDF and video get none). The kind is judged on the REALPATH's extension. The same boundary and open rules as `/api/fs/read`: `resolveUnderAllowed`, not under the data dir, `O_NOFOLLOW|O_NONBLOCK`, `fstat` regular file, stream from that fd. No size cap (it streams; nothing is buffered whole).
- **Auth for a `src` that cannot carry a header: a media ticket, never the app token in a URL.** `POST /api/fs/media-ticket { path }` (authed by header like every route) → `{ ticket, size, mtimeMs }`. A ticket is 32 random bytes hex, held in memory, bound to that ONE resolved path, valid 10 minutes (sliding: re-asking for an UNCHANGED file — same size:mtimeMs:ino — returns the same ticket and restarts its clock; a changed file gets a new one), at most 64 alive (oldest dropped). `GET /api/fs/media` accepts only a ticket whose path matches the request's `path` after the same resolve; no token header needed on that route, Host/Origin checks still apply. A restart forgets all tickets (a tab asks again). The log line carries the route and the status, never the ticket or the path query value (the existing "query-string values never written" rule).
- **Change detection without hashing a video**: `size + mtimeMs + ino` from the same safe open, returned by the ticket route. The follow tick asks for a new ticket for a media body (`POST` is cheap — one `fstat`), and compares the triple. Accepted limit: a rewrite with the same size inside the same drvfs second is not seen (the editor's hash reason does not apply — nothing is saved back).
- **Image refresh**: a changed triple → load the new URL (new ticket) into an off-screen `Image`, swap only when it decoded (no flash, no broken-image frame mid-write; a decode error keeps the old picture and retries on the next tick).
- **Web modules** (CONTRIBUTING.md shapes): `web/src/ui/media-model.ts` (pure: kind → body plan, Fit/100 % state, size line text, the change comparison), `web/src/ui/media-pane.ts` (the body: builds `<img>`/`<video>`/`<iframe>`, registers with the existing follow loop through `registerBody`, never a second timer). the body builder routes on `mediaKind()` (`fileBody` in `web/src/ui/editor-pane.ts`, so a restored tab gets the same body as a click); the tab stays an editor file tab (same id scheme), so persistence, close and the tab strip work unchanged. A media tab is never dirty.
- **Edit as text** on an SVG opens the editor body for the same path. Both tabs may be open at once; the tab id gets a `:text` suffix for the editor one (frozen below) so the two do not collide.
- **Look**: through `/frontend-designer` — Nocturne tokens, the checkerboard in two ground shades, the bottom bar in the editor's own bottom-bar idiom. No new colours.

## Frozen contract

```ts
// shared/media-kind.ts
export type MediaKind = 'image' | 'video' | 'pdf';
export function mediaKind(path: string): MediaKind | null;
export function mediaContentType(path: string): string | null;

// shared/protocol-fs.ts
export interface FsMediaTicketRequest { path: string }
export interface FsMediaTicketResponse { ticket: string; size: number; mtimeMs: number; ino: number }

// HTTP
// POST /api/fs/media-ticket   (X-Auth-Token)  → 200 FsMediaTicketResponse | 400 | 403 | 404 | 415
// GET  /api/fs/media?path=&t= (ticket)        → 200 | 206 | 403 (bad/expired/mismatched ticket) | 404 | 415 | 416

// web: the editor-tab id of the TEXT view of an SVG
// fileTabId(path) + ':text'
```

## Files (expected; the developer confirms)

- New: `shared/media-kind.ts`, `server/fsmedia.ts` (ticket store + streaming route), `web/src/ui/media-model.ts`, `web/src/ui/media-pane.ts`.
- Changed: `shared/protocol-fs.ts`, `server/api-fs.ts` (two routes), `server/api.ts` (the ticket route skips the token header only for `GET /api/fs/media`), `web/src/api.ts`, `web/src/ui/unsaved.ts` / `editor-pane.ts` (routing + the `:text` id), `web/src/ui/editor-store.ts` (media bodies in the follow loop), `web/src/styles/*` (viewer styles).
- Tests: `tests/server/media-kind.test.ts`, `tests/server/fs-media-{tickets,boundary,serve}.test.ts` (boundary, data dir, FIFO, symlink out, ticket bound to path, expired, mismatched, Range 206 / 416, content type from the table, nosniff + CSP headers, no ticket or path in the log), `tests/ui/ui-media-{model,pane,tabs}.test.ts`.

## Phases

1. **Server**: `shared/media-kind.ts`, ticket store, both routes, tests. Reviewers: security-auditor (a new unauthenticated-by-header read route is the point of this part), scope-reviewer.
2. **Web**: routing, the image / video / PDF bodies, Fit/100 %, Edit as text, the follow-loop refresh, styles via `/frontend-designer`. Reviewers: scope-reviewer, test-engineer gate.
3. **Final gate**: full suite (staged first), `npm run build`, a dev-window check by the user on Windows with `build/renders/smoke/*.png`, an mp4, a PDF and an SVG; `/verify-terminal` is not needed (no terminal code changes) unless the diff touches pane or focus code.

## Out of scope

Audio (decision 20). Editing images. Thumbnails in the Files panel. Zoom beyond Fit/100 %. A gallery (next/previous) — the Files panel is the navigator.
