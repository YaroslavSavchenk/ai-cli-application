---
type: log
created: 2026-10-13
updated: 2026-10-13
tags: [quality, q6, launcher, host, size-guard]
---
# 2026-10-13 — Q6: the Windows host in four files, the size guard covers `launcher/`

Spec: `.claude/plans/quality/PLAN-Q6.md`. The user decided the same day
that the guard measures everything tracked under `launcher/` at 1 000
lines.

**What landed:**
- `launcher/host/AiSessionManagerHost.cs` (2 550 lines) is now four files
  of `internal static partial class HostApp`:
  - the core (708 lines),
  - `-clipboard.cs` (308),
  - `-overlay.cs` (707),
  - `-overlay-window.cs` (907, which also holds `MascotOverlayForm` and the
    DComp interfaces).
- The overlay cut sits at old line 1629, a member boundary: the
  display-events comment and its field travel with their code.
- `build-host.ps1` compiles a fixed, ordered `$SrcFiles` list, not a glob,
  so a stray `.cs` in `host/` is never compiled in. A pin checks that list
  against the tracked `launcher/host/*.cs` and `tests/helpers/host-sources.ts`.
- The host tests read the file that now holds the code. `host-instance`
  checks over all four files at once.
- `tests/repo/file-size.test.ts` measures `launcher/` with an extension
  allow-list (`.cs .ps1 .psm1 .cmd .vbs .sh .mjs .md`; `app.ico` is
  binary).

**Proof:**
- Put back together in the old order, the files differ from the old one
  only in 3 comment edits.
- A real csc build here, four parts → a 330 240-byte exe, the same size
  as the single-file build. `build-host.ps1` was run on a scratch copy
  that had a stray `.cs` added; the stray was not compiled in.

**Owed (user, Windows):** rebuild with `launcher/build-host.ps1`, open the
app and the mascot once. Check the dark caption, Copy from the Files panel
then paste in Explorer, and that the mascot is click-through.

**Note:** the allow-list misses a future `.json`/`.txt` under `launcher/`
with no error. Widen it when such a file appears.
