---
type: log
created: 2026-10-21
updated: 2026-10-21
tags: [nocturne, d7, media]
---
# 2026-10-21 — D7: media viewer

Decisions: [[d7-media-viewer]]. Spec: `.claude/plans/nocturne/PLAN-D7.md`.

**Flow:** server (backend-pty) and web (terminal-ui) developers in parallel
on disjoint files against the frozen contract; the server agent wrote
`shared/` first. Review: security-auditor (server) 0 findings;
scope-reviewer 2 should-fix (dead `editorFileId`, a contract comment) + scope
doc drift — one fixer round, scope doc updated by the orchestrator. Test gate:
71 mutants (54 server, full probe on auth + boundary; 17 UI), 19 survived,
17 killed by new tests, 2 equivalent; no app bug found.

**Server:** `shared/media-kind.ts` (extension table), `server/fsmedia.ts`
(`MediaTickets`, `POST /api/fs/media-ticket`, `GET /api/fs/media` with one
Range, from the judged fd via `pipeline`); `server/fstext.ts` gave its
`resolveReadable` / `openReadOnly` / `closeQuietly` one home; the ticket POST
joins the quiet polls.

**UI:** `web/src/ui/media-model.ts` + `media-pane.ts`; `fileBody` in
`editor-pane.ts` picks the body by kind (a restored tab too); the SVG text
view is tab id `f:<path>:text` (`fileTab`/`fileIdParts` in
`editor-model.ts`, persisted as `asText`); the editor's one follow timer
also follows media bodies; `fmtBytes` in `format-model.ts`.

**Lessons:** two repo guards shaped the copy — no `·` separator in chrome
literals (`ui-copy-separators`) and no `draggable` attribute (`ui-dnd-a10`,
image drag off via CSS). Brief test folders were wrong (`tests/web/`,
`tests/shared/` do not exist: `tests/ui/`, `tests/server/`).

**Owed:** the user's dev-window check — decoding, layout, WebView2 PDF viewer
(with X-Frame-Options SAMEORIGIN), Range seek, and whether keys reach the app
while focus is inside the PDF iframe (scope-reviewer note 7).
