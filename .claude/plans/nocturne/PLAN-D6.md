# D6 — Claude Code compatibility guard: see which version runs, hear when it is outside what this app was tested with, and see why a launch died

Status: LANDED 2026-10-13 on branch `backlog-d3-q8` (server + UI halves, scope + security + test gate; DEV check by the user owed); earlier: DECIDED 2026-10-13 (the user's 2026-09-15 ask, `memory/BACKLOG.md` § Claude Code CLI compatibility guard; put in the plan on the user's pick 2026-10-13; decisions 18–19 of `.claude/plans/PLAN-NOCTURNE.md` asked the same day).

Part D6 of `.claude/plans/PLAN-NOCTURNE.md` (Track D, fixes and asks after the v0.4.0 release). Conventions: `.claude/plans/README.md`.

## What the user gets

- Settings → Background service has one more fact: `Claude Code 2.1.287 (tested up to 2.1.287)`. When `claude` is not on PATH it reads `Claude Code not found`.
- If the installed Claude Code is older than this app needs, or newer than it was tested with, a notice appears. It stays until the user hides it. It is in the Nocturne idiom of the update toast and carries ONE action: **Check for updates**. It never blocks launching.
  - Too old: "Claude Code 2.1.250 is older than this app needs (2.1.263). Update Claude Code."
  - Too new: "This app was tested up to Claude Code 2.1.287. You have 2.1.300. If launches fail, check for an app update."
- Hiding the notice holds until a DIFFERENT Claude Code version is seen, also across a restart (decision 19).
- A Claude session that dies within seconds of its launch (or of a resume) with a non-zero code is flagged in the pane. The pane gets a banner with Claude Code's own first line, e.g. `Claude Code stopped right after it started: error: unknown option '--session-id'`. The out-of-range notice comes back even if hidden, because a dead launch is new evidence.

## Found 2026-10-13 (line numbers drift)

- `GET /api/runtime`: `server/api-app.ts` ~:91 builds `RuntimeStatusResponse` (`shared/protocol-runtime.ts` ~:49) from static deps (`server/api.ts` ~:172, wired `server/index.ts` ~:590). The web reads it at boot (`web/src/main.ts` ~:284), on the 30 s poll (`web/src/main-shell.ts`) and from Settings, all through `st.setRuntime()` → `applyRuntime()` (`web/src/ui/update.ts`).
- `claude` is only located by PATH (`server/tools.ts` `findOnPath`, env `ptyEnv()`), never run. No "X --version" helper exists. The closest shape is the private `runCapture` in `server/update-install.ts` ~:753 (argv, bounded stdout, SIGKILL timeout).
- Settings facts: `web/src/ui/settings-service.ts` `.sg-svcfacts` spans, filled by `renderBackend()` from `runtimeFacts()` (`web/src/ui/update.ts` ~:864).
- Toast idiom: `.ut-toast` in `web/src/ui/update.ts`, dismissal in memory only (`UpdateNotice`, `web/src/ui/update-model.ts`). "Check for updates" = `api.checkForUpdates()`. Its Settings caller `runCheck()` is module-private.
- Prefs: `UiPrefs` (`shared/protocol-settings.ts` ~:130), an opaque bag with only `mascot` validated server-side; `api.updatePrefs` merges on write.
- Exit: `server/sessions.ts` `proc.onExit` (~:410) knows `exitCode`, `info.createdAt`, and the claude-ness (`isClaudeCommand`, a local in `create()`). It broadcasts `{type:'exit', exitCode}` (`shared/protocol.ts` ~:506). The pane shows "Finished, code N" (`web/src/ui/panes-status.ts` ~:161). First output is only in the 1 MiB `RingBuffer`. A refused `--resume` is not detectable today.
- The floor `2.1.263` stands in `.claude/PROJECT-SCOPE.md` (~:59, "no version probe"), `README.md` (~:69) and `memory/decisions/session-history-resume.md`. The installed version is `2.1.287`.
- Test double: `tests/helpers/history-fixture.ts` `CLAUDE_DOUBLE` (a `claude` sh script on PATH). A duplicate sits in `tests/server/sessions-resume-live.test.ts`; Q-style, one home.

## Decided (user, 2026-10-13) — do not re-ask

1. The notice offers the app's own **Check for updates** only, no link to the GitHub releases page (decision 18).
2. The notice can be hidden until a different Claude Code version is seen; the hiding survives a restart (decision 19).
3. From the 2026-09-15 ask (backlog): never block launching; the user decides.

## Defaults (orchestrator, within the decisions — not asked)

- **The range lives in ONE place**: `shared/claude-compat.ts`, with `CLAUDE_SUPPORTED = { min: '2.1.263', testedUpTo: '2.1.287' }` and a pure `compareClaudeVersion(a, b)`. A pure `claudeCompat(version | null): 'ok' | 'older' | 'newer' | 'missing' | 'unknown'`. `unknown` = output that does not parse as `X.Y.Z`; it shows the raw first 40 characters and no notice. A newer PATCH counts as newer: the tested list is exact, and Claude Code ships often.
- **Probe**: once at boot, `claude --version` via argv (no shell), env `ptyEnv()`, 5 s timeout, stdout cap 4 KiB, SIGKILL on timeout. `server/claude-version.ts` exports `probeClaudeVersion(opts)`. The private `runCapture` moves to `server/config.ts` as the one home and `update-install.ts` imports it (no duplicate, `tests/repo/no-duplicate-code.test.ts`). The probe runs again (debounced, once per 60 s at most) when `/api/tools` sees the claude binary's path or mtime change. That way an upgrade while the app runs is noticed without a restart.
- **Contract**: `RuntimeStatusResponse.claude: { version: string | null; compat: 'ok' | 'older' | 'newer' | 'missing' | 'unknown'; min: string; testedUpTo: string }`. The server computes `compat` with the shared function; the web never re-derives it.
- **Dismissal**: `UiPrefs.claudeNoticeHidden?: string`, the version string that was hidden. Server-side validation is the `X.Y.Z` shape, ≤ 32 chars, else the key is dropped (like `mascot`). The notice shows while `compat` is `older|newer` and `claude.version !== prefs.claudeNoticeHidden`.
- **Notice placement**: its own toast in the update toast's slot and style (`web/src/ui/claude-notice.ts` + `claude-notice-model.ts` pure). When both would show, the update toast goes first and the Claude notice second, stacked. Its action calls the same check the Settings button calls: `runCheck` gets exported from one home, not copied.
- **Early exit**: in `onExit`, a claude-kind session with `exitCode !== 0` and `now − createdAt < EARLY_EXIT_MS` (3 000 ms; the backlog said ~2 s, the 1 s margin covers a slow WSL spawn) gets `info.earlyExit = { line }`. `line` is the first non-empty line of its output, escape-stripped, ≤ 200 chars, '' when none. `ExitMessage` gets an optional `early?: { line: string }`. `SessionInfo` carries it too, for a pane attached later. The pane banner reads `Claude Code stopped right after it started` plus the line, and keeps the existing buttons. The server logs one WARN with the version and the line. Covers `--resume` the same way (its argv is built in `server/conversation.ts`). The page clears `claudeNoticeHidden` (one `updatePrefs` drop) when an early exit arrives and `compat !== 'ok'`.
- **Boot card**: no new row. The boot card is only seen on a slow boot, and the probe does NOT gate boot (it runs after listen; `claude.version` is `null` with `compat: 'unknown'` until it answers, and the 30 s poll picks it up).
- **Release discipline**: the release notes draft template gains a line `Verified with Claude Code <testedUpTo>`. `tests/release/` pins that the newest `RELEASE-NOTES-*-draft.md` names the same `testedUpTo` as `shared/claude-compat.ts`, so bumping one without the other fails. `scripts/release.sh` does not probe (CI has no Claude Code).

## Frozen contract

```ts
// shared/claude-compat.ts
export const CLAUDE_SUPPORTED: { readonly min: string; readonly testedUpTo: string };
export type ClaudeCompat = 'ok' | 'older' | 'newer' | 'missing' | 'unknown';
export function parseClaudeVersion(stdout: string): string | null;   // first X.Y.Z token
export function compareClaudeVersion(a: string, b: string): number;  // numeric per part
export function claudeCompat(version: string | null, found: boolean): ClaudeCompat;

// shared/protocol-runtime.ts — RuntimeStatusResponse gains
claude: { version: string | null; compat: ClaudeCompat; min: string; testedUpTo: string };

// shared/protocol.ts
interface ExitMessage { type: 'exit'; exitCode: number; early?: { line: string } }
// SessionInfo gains: earlyExit?: { line: string }

// shared/protocol-settings.ts — UiPrefs gains
claudeNoticeHidden?: string;
```

## Files (expected)

New: `shared/claude-compat.ts`, `server/claude-version.ts`, `web/src/ui/claude-notice.ts`, `web/src/ui/claude-notice-model.ts`, tests under `tests/server/` (`claude-version*.test.ts`, `sessions-early-exit.test.ts`), `tests/ui/` (`ui-claude-notice*.test.ts`), `tests/shared/` or the existing shared-test folder (`claude-compat.test.ts`), `tests/release/` (the release-notes pin).
Changed: `shared/protocol-runtime.ts`, `shared/protocol.ts`, `shared/protocol-settings.ts`, `server/config.ts` (`runCapture` home), `server/update-install.ts`, `server/api.ts`, `server/api-app.ts` (prefs validation + runtime body), `server/index.ts` → Q5's split module if Q5 landed first (`server/index.ts` is at 994 lines: **do Q5 first or put the wiring in a new `server/index-*.ts`**), `server/sessions.ts` / `server/sessions-output.ts`, `server/tools.ts` (re-probe hook), `web/src/state-chrome.ts`, `web/src/ui/update.ts`, `web/src/ui/settings-service.ts`, `web/src/ui/panes-status.ts`, `web/src/ui/panes.ts`, `web/src/ws.ts`, `web/src/app.css`, `tests/helpers/history-fixture.ts` (the double answers `--version` with a version from env; one home for `CLAUDE_DOUBLE`), `.claude/PROJECT-SCOPE.md` (the "no version probe" sentence), `README.md`, the release-notes draft.

## Phases

1. Shared compat module + probe + `/api/runtime` field + the Settings fact.
2. Notice + dismissal pref + Check for updates (`/frontend-designer` first).
3. Early-exit flag (server, WS, pane banner) + the notice coming back.
4. Release-notes line + pin; scope doc, README, vault decision note.

## Test gate

- `claude-compat`: parse (`2.1.287 (Claude Code)`, garbage, empty), compare (`2.1.9` < `2.1.10`), every compat state.
- Probe: a double on PATH answering a version, answering garbage, hanging past the timeout (killed, `unknown`), missing (`missing`), never via a shell (argv pinned).
- Runtime body carries `claude` byte-exact. The prefs PUT drops a malformed `claudeNoticeHidden`.
- Notice model: shows/hides per compat × hidden version; dismissal writes the version; a different version shows again; early exit clears the hidden value.
- Early exit: a double that prints a line and exits 2 at once → `early.line`; one that exits 2 after 4 s → no `early`; exit 0 at once → no `early`; a shell session exiting 2 at once → no `early`; a resume launch the same.
- Release-notes pin fails on a mismatch.

## Final gate

- `npm test` green, scope + security review (a new spawn site), `/verify-terminal` (pane banner on an early exit; a normal launch unchanged).
- DEV check by the user (never the installed app): the Settings fact; a faked newer version (env override `AI_SM_CLAUDE_VERSION_OVERRIDE`, dev-only and refused when the app is installed) shows the notice, Hide, restart, still hidden; a broken launch shows the banner.
