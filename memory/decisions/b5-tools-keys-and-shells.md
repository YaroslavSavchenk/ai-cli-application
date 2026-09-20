---
type: decision
created: 2026-09-18
updated: 2026-09-20
tags: [nocturne, launch-dialog, api-keys, interop, codex, gemini, grok]
---
# B5: API keys, Command Prompt, not-installed tools, resume shape (open decisions 4 + 6)

**Status:** decided 2026-09-18 (user; all four the orchestrator's advice)

Context: Nocturne part B5 makes the New session dialog live for Codex, Gemini
CLI, Grok, Zsh and Command Prompt (`.claude/PLAN-NOCTURNE.md`; spec
`.claude/PLAN-B5.md`). Asked at the start of the part, before the developer
briefs (lean rule 6). Facts gathered first: `codex` 0.116.0 and — installed
that day for the check — `gemini` 0.60.0 verified through their own `--help`;
Grok Build (xAI's own CLI, 2026-05; `@vibe-kit/grok-cli` is stale
third-party) from docs.x.ai only; `cmd.exe` via interop measured: refuses a
UNC working directory ("Defaulting to Windows directory"), but `cmd.exe /k
pushd <UNC path>` maps a drive letter and lands in the folder; `pwsh.exe`
not installed.

## 1. API keys (open decision 4) — server-side, per-tool env injection
`<dataDir>/keys.json` (0600, atomic — the GitHub-token ceiling, see
[[wsl-0600-not-a-boundary]]): one optional key per tool that reads an
environment variable directly — Claude Code `ANTHROPIC_API_KEY`, Gemini CLI
`GEMINI_API_KEY`, Grok `XAI_API_KEY`. The page learns saved / not saved and
whether the backend's own environment carries the variable; the value never
reaches the page or the log. At spawn a saved key is set in THAT tool's child
environment only (`basename(command)`), a saved key beating an inherited one
(saving was the explicit act). Codex gets NO field: per its docs an
`OPENAI_API_KEY` alone does not authenticate it (`codex login` /
`codex login --with-api-key`), so the honest row is "Signs in inside the
terminal". The dialog's notice ("Needs an API key, or sign in inside the
terminal the first time." + `Add key`) exists for Gemini and Grok only.
- Rejected: no storage at all (v3 wants the notice + Add key; a user with a
  key and no subscription login has nowhere to put it); env-only detection
  (the app then depends on the user's `.bashrc`, invisible in the UI).

## 2. Command Prompt (open decision 6) — yes, in the project folder
`cmd.exe` through WSL interop exactly like PowerShell (argv only), with a
SERVER-injected `/k pushd <windows path of the cwd>` (PTY argv only, never
`SessionInfo.args`, re-injected on resume). The Windows path is computed by a
pure function (`/mnt/<d>/…` → `D:\…`, else `\\wsl.localhost\<distro>\…`
from `WSL_DISTRO_NAME`) and injected ONLY when the cwd matches the launcher's
allow-list shape and the distro name is well-formed — cmd parses its own
command line, so `& | ^ % "` and spaces are metacharacters there; otherwise
plain `cmd.exe` plus one warn line. No `pwsh.exe` card: not installed, and
PowerShell = `powershell.exe -NoLogo` was decided 2026-09-10.
- Rejected: plain `cmd.exe` (lands in `C:\Windows`, useless as a project
  shell); dropping the card (the user said "alles moet mogelijk").

## 3. Not-installed tools — probe, inert `Not installed`
`GET /api/tools` looks the executables up on the PATH of the very environment
a session is spawned with (`ptyEnv()`), so the card state and a spawn can
never disagree; absent → inert card with the sub-line `Not installed`
(`Not available yet` retired). Installed 2026-09-18 for a live check with the
user's consent: Gemini CLI (npm, user-level); zsh by the user's own sudo. Grok
Build not installed (subscription-only) — built from the docs, marked
unverified in code.

## 4. Start from — Claude per-id, the others last-only
Claude Code lists the selected project's ended conversations (the Earlier
section's entries) and resumes by id (`--resume <id>` composed by the dialog;
the server adopts the id as the history key, 409 while that entry is live).
Codex: `The last session` (`resume --last`) + `Pick an earlier session`
(Codex's own picker). Gemini and Grok: last only (`-r latest`,
`--continue`). Follow-ups noted, not built: Grok `-s <uuid>` and Gemini
`--session-id <uuid>` (present in 0.60.0) would allow claude-style pinning.
- Rejected: Grok per-id on docs alone (unverifiable without a subscription);
  last-only for everyone (v3 asks for the resume list).

## Permission mapping (orchestrator's, recorded)
Codex: Always ask `-a on-request -s read-only`; Auto edits `-a on-request -s
workspace-write`; Read only `-a never -s read-only`; No prompts
`--dangerously-bypass-approvals-and-sandbox` (only `on-request`/`never` —
valid on 0.116 and on the current 0.155, which retired `untrusted`). Gemini
`--approval-mode auto_edit|plan|yolo` (1:1). Grok: only Always ask (nothing)
and No prompts (`--always-approve`); Auto edits / Read only are in-TUI modes
there → inert cards with a hint. Effort: Codex `-c
model_reasoning_effort=minimal…xhigh`, Grok `--effort low|medium|high`,
Gemini none (control hidden). The (i) popover keeps its four generic lines —
an accepted approximation for Codex's sandbox semantics.

## 5. Ending a session: a signal ladder on the process group (2026-09-20)
Found by B5's `/verify-terminal` cleanup: `DELETE` on a Gemini CLI session
returned ok, but `gemini` 0.60 (a wrapper relaunching itself as a child)
ignores SIGHUP and SIGTERM to the leader — the pair lived on with
`GEMINI_API_KEY` in its environment after the user pressed Remove. Fix
(orchestrator's, not asked): SIGHUP → 2 s → SIGTERM to `-pid` → 3 s →
SIGKILL to `-pid`; each rung skipped when the GROUP is gone
(`process.kill(-pid, 0)` ESRCH — the security-auditor's correction: the
leader's exit alone must not stop the ladder, a live group pins the pid
number); shutdown/restart = SIGHUP + immediate group SIGKILL, sweeping
ladders in flight. Real gemini now dies at the SIGTERM rung (the group gets
it). Recorded limits: a `setsid` descendant escapes; shutdown loses
in-flight shell history (UX; a 300–500 ms grace is the user's call).
- Rejected: SIGKILL only (a TUI that honours SIGHUP should get to flush);
  leader-only signals (the measured defect).

Related: [[nocturne-full-switch]], [[session-history-resume]],
[[terminal-sessions-and-host-exit]] (the PowerShell precedent),
[[localhost-security-model]].
