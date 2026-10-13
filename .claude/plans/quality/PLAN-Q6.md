# Q6 — The Windows host in files of at most 1 000 lines, and the size guard covers `launcher/`

Status: LANDED 2026-10-13 (four `partial` files 708/308/707/907 lines, move proof clean, real csc build 330 240 B as before; the user rebuilds on Windows); earlier: DECIDED 2026-10-13 (the user's pick from `memory/BACKLOG.md` § From Nocturne A8 "Host file size"; the user's answer the same day: the guard measures everything under `launcher/`, same 1 000-line limit).

Part Q6 of `.claude/plans/PLAN-QUALITY.md`. Conventions: `.claude/plans/README.md`.

## What the user gets

Nothing visible: the same `AiSessionManagerHost.exe`, built from four source
files instead of one. A reader (person or agent) opens the part about its
topic. From now on the size guard fails the suite when any tracked text file
under `launcher/` passes 1 000 lines, exactly like `server/`, `web/src/` and
`shared/`.

## Found 2026-10-13 (line numbers drift — re-read before cutting)

`launcher/host/AiSessionManagerHost.cs` is 2 550 lines, one namespace
`AiSessionManager`, written for the in-box C# 5 compiler (no `$""`, no `=>`
members, no `?.` — the file's header, keep it):

| Lines | What |
| --- | --- |
| 1–69 | header, usings, `[assembly: TargetFramework(…)]`, namespace |
| 72–2247 | `internal static class HostApp` (NOT `partial` today) |
| 72–592 | consts, P/Invokes, colour tokens, folder names, `Main`, `BuildForm`, DWM chrome, icon, WebView init, navigation lock, focus, permissions |
| 593–875 | region "Page -> host: files onto the Windows clipboard" |
| 876–948 | new-window requests, `OpenInDefaultBrowser` |
| 949–2206 | region "Peek-mascot overlay (Nocturne C1)", ~1 258 lines |
| 2208–2246 | `WriteReadySentinel`, `Log` (used by every region) |
| 2254–2516 | `internal sealed class MascotOverlayForm : Form` |
| 2517–2549 | DComp COM interfaces |

Every other tracked file under `launcher/` is under 1 000 (largest
`launch.ps1` 590, `README.md` 584). `app.ico` is binary.

## The cut (frozen)

`HostApp` becomes `internal static partial class HostApp` in every file. Each
file repeats the usings it needs and the namespace. The assembly attribute
and the C# 5 header stay in the first file only (a one-line pointer in the
others). Names follow `CONTRIBUTING.md` `<stem>-<topic>`:

| File | Takes | ≈ lines |
| --- | --- | --- |
| `launcher/host/AiSessionManagerHost.cs` | 1–592, 876–948, 2208–2246 | 720 |
| `launcher/host/AiSessionManagerHost-clipboard.cs` | 593–875, the whole region | 310 |
| `launcher/host/AiSessionManagerHost-overlay.cs` | 949–1636: overlay consts, fields, P/Invokes, create, composition, stray-window fix, overlay navigation and reload | 715 |
| `launcher/host/AiSessionManagerHost-overlay-window.cs` | 1637–2206 (display events, overlay web messages, foreground hook, region/placement/DPI, open, dispose), `MascotOverlayForm`, the DComp interfaces | 900 |

Moves only, no code change. The one exception is the `partial` keyword, plus
a usings block per file. Member order inside a region stays. If a cut falls
inside a member, it moves to the member boundary. The overlay's own
consts/fields/P/Invokes live in `-overlay.cs`, because C# `partial` makes them
visible across files.

## Build and CI

- `launcher/build-host.ps1`: `$SrcFile` (~:51) becomes a fixed, ordered list
  of the four files (not a glob — a stray `.cs` in `host/` must not get
  compiled in). Each must exist (the ~:58 check, per file). csc gets all four
  as trailing arguments; the flags stay byte-identical.
- `.github/workflows/release.yml` and `codeql.yml` only call
  `build-host.ps1` — no change, except `codeql.yml`'s "a single source file"
  comment (~:9). `tests/release/release-workflow.test.ts` (the CodeQL order
  init → build-host → analyze) stays green.
- Comments that name the file: `launcher/make-shortcut.ps1` ~:55,
  `launcher/config-common.ps1` ~:103, `server/restart.ts` ~:10,
  `launcher/README.md` file table ~:54 and ~:300. Where the content moved,
  name the right file. `memory/decisions/native-webview2-host.md` ~:119
  ("nothing enforces it") gets corrected.

## Tests that read the host by path

They switch to `readSources(...)` (`tests/helpers/helpers.ts` ~:102) over
the four files, or to the one file that now holds what they pin:

- `tests/ui/nocturne-tokens.test.ts` (`HOST_CS`, the `Token*` constants) → the first file.
- `tests/release/host-webmessage.test.ts`. Its `member()` slicer and the region from banner to the end of `PostCopyFilesReply` → `-clipboard.cs`. The TargetFramework attribute and the `WebView_InitCompleted` lines → the first file.
- `tests/release/host-overlay-stray.test.ts` → `-overlay.cs`.
- `tests/release/host-instance.test.ts`. "Each folder name exactly once", "the args refusal before `BuildForm`" and "data paths only from `_dataDir`, overlay env included" must hold over ALL four files: concatenate them, don't pick one, or a copy in another file slips by.
- `tests/release/installer-script.test.ts` (the `AppUserModelId` const) → the first file.

No assertion is weakened. A pin that now spans files reads the union.

## The guard

`tests/repo/file-size.test.ts`: `git ls-files` also lists `launcher`;
`limitFor` measures every tracked file under `launcher/` at `SOURCE_LIMIT`
except binaries (`.ico`, and any future image: an extension allow-list of
`.cs .ps1 .psm1 .cmd .vbs .sh .mjs .md` is safer than a deny-list). Update
the file's header and `tests/README.md` § Size (~:28–34) to the new scope.
A small proof that a 1 001-line `launcher/` file would fail is not needed:
the existing assertion is shared.

Also add a new pin: `build-host.ps1`'s source list equals the set of tracked
`launcher/host/*.cs`. It is the guard against a fifth file nobody compiles.

## Test gate

- `npm test` green (Node 24 PATH line in every brief).
- `tests/repo/file-size.test.ts` measures `launcher/`, and all four host files are ≤ 1 000.
- `git diff --stat` shows moves: the line total of the four files ≈ the old one plus the repeated usings/namespace (+~80). The reviewer diffs the concatenation against the old file, ignoring the usings blocks and `partial`, and expects an empty result.

## Final gate

- The CI `installer` job and CodeQL compile the host green on the pushed commit. This machine has no csc; the runner does.
- The user rebuilds on Windows (`launcher/build-host.ps1`) and opens the app plus the mascot once. Owed to the user, listed in the landing report. Combine with the backlog's token-name rename (`TokenBgApp`/`TokenTextHd`/`TokenEdge`, § From Nocturne A8) only if the user says so — it is a rename, not a move.
