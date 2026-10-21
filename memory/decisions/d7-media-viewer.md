---
type: decision
created: 2026-10-21
updated: 2026-10-21
tags: [nocturne, d7, media, editor, files-panel]
---
# D7 — media viewer (images, video, PDF)

**Status:** decided 2026-10-21 (user). Spec: `.claude/plans/nocturne/PLAN-D7.md`.

The user's ask: "de png, jpeg, mp4, etc gebruikerlijk maken … dat je gwn een
picture krijgt ofzo of een video" — clicking `build/renders/smoke/front.png`
in the Files panel showed only the editor's "not text" sentence.

Decided by the user (decisions 20–23 of `.claude/plans/PLAN-NOCTURNE.md`):

1. Images, video and PDF. No audio.
2. A media file opens as a file tab in the editor pane. Rejected: an overlay /
   lightbox, both.
3. SVG opens as a picture, with `Edit as text`. Rejected: text by default with
   a Preview action.
4. An image refreshes by itself when the file changes on disk. Rejected: a
   manual Reload only.

Orchestrator defaults that shape the code (not asked):

- `<img>`/`<video>`/`<iframe>` src cannot carry the `X-Auth-Token` header,
  and the app token never goes in a URL. A short-lived TICKET bound to one
  realpath stands in, so `GET /api/fs/media` is the one `/api` route without
  the token header (Host/Origin gates kept). The security review found the
  ticket (256 random bits, from the token-gated POST) plus CORP same-origin
  sufficient against a drive-by page.
- The same ticket comes back while size:mtimeMs:ino is unchanged — a fresh
  one per 5 s poll would evict a playing video's ticket under the 64 cap.
- The sandbox CSP goes on SVG only: Chromium's PDF viewer refuses a
  sandboxed document.

Related: [[b4-editor-live]], [[localhost-security-model]],
[[fifo-open-blocks-main-thread]].
