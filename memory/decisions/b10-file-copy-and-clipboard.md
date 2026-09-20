---
type: decision
created: 2026-09-20
updated: 2026-09-20
tags: [nocturne, files, drop, upload, clipboard, host, security]
---
# B10: real file copy into WSL + copy-to-clipboard via the host

**Status:** decided 2026-09-20 (user; all three the orchestrator's advice).
Asked before the developer briefs (lean rule 6), while the Plan agent
designed on the same assumptions. Part B10 of `.claude/plans/PLAN-NOCTURNE.md`
(A9 = the visual half with a mock transport, landed 2026-09-15; A9b's
context-menu `Copy` / `Paste` inert until here). Spec `.claude/plans/nocturne/PLAN-B10.md`.

## 1. Scope — both halves, the host last
B10 = (a) the real upload for a drop, a paste with files on the clipboard
and `Copy files here…` (one pipeline), AND (b) `Copy` from the app's file
system to the Windows clipboard through the native host
(`Clipboard.SetFileDropList` with `\\wsl.localhost\<distro>\…`, reached by a
web message; Edge fallback = at most the path as text). The host half is its
own LAST phase (`wsl-launcher`; needs the user's Windows build and check),
and only then do the A9b menu entries go live. No dragging OUT of the app
(unchanged 2026-09-15 decision).
- Rejected: upload only now (the menu's Copy would stay a dead entry for
  another part).

## 2. Folder conflicts — one choice per drop, Replace = merge
`Replace`: an existing folder is merged, same-named files inside are
overwritten. `Keep both`: the whole folder lands under the Explorer name
(`web (2)`). `Skip`: the whole folder is skipped. Files: overwrite /
`keepBothName` / skip. Closest to Explorer while keeping ONE dialog per
drop (decision of 2026-09-15).
- Rejected: Replace = empty the folder first (destroys files the user never
  dragged).

## 3. Limits per drop
50 MiB per file and 200 top-level items (A9) stay; NEW: 2000 files and
1 GiB per drop, counted over the recursive walk done BEFORE the conflict
question. Over any limit = the drop is refused up front with one sentence;
nothing partial.
- Rejected: 10000 files / 4 GiB (browser memory with thousands of `File`
  objects); no recursive limit (a `node_modules` drop runs for minutes).

## 4. Hide during a copy + a quiet client log (user, 2026-09-20, scope review of phase 2)
A 2000-file drop can hold the aria-modal card for minutes; A9's inert
Esc/×/backdrop were harmless on a 60 ms mock. Decided: `Esc` / `×` / backdrop
HIDE the card, the copy runs on (the restart dialog's `Hide` precedent); the
result then arrives as one statusline flash (`Copied 37 files into src. 2
failed.`); a new drop during a run is refused (`A copy is still running.`).
Still no cancel. And: a successful per-file upload is NOT logged in the
browser log (200-line buffer, 200/min server budget — a 500-file drop would
blind the log for a minute); refusals and the one `drop: …` summary line stay.
- Rejected: keep blocking (a running Claude session untouchable for minutes);
  log every call (the scope rule, bent for this one route like the server's
  quiet list).

## Orchestrator defaults (recorded, not asked)
Progress counts write units (files + empty folders), not rows — `137 of
2000`, never `0 of 1` for one dragged folder. Rejections in hooks never wedge
the card.
Partial failure inside a folder: the folder stays one row — `Copied`, or
`Failed` with the note `N of M files failed`; what copied stays.

Related: [[localhost-security-model]], [[b5-tools-keys-and-shells]] (the
0600 / boundary precedents), [[2026-09-15-nocturne-a9]],
[[2026-09-16-nocturne-a9b]].
