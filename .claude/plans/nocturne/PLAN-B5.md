# Plan B5 — New session dialog live (Nocturne Track B)

Status: LANDED 2026-09-20 (started 2026-09-18 on the user's "continue"; limit-killed at the verify gate that day; verify-terminal V1–V7 PASS 2026-09-20 plus the kill-escalation ladder in `server/sessions.ts` — see `memory/log/2026-09/nocturne/2026-09-20-nocturne-b5.md`). Windows check owed.
Parent: `.claude/plans/PLAN-NOCTURNE.md` part B5. Runs through `/dev-flow` (lean
rules 1–11), `security-auditor` mandatory (spawning, argv injection, a new
stored credential, a new environment seam), `/verify-terminal` once at the end.

## Decisions (user, 2026-09-18 — all four the orchestrator's advice)

- **Open decision 4 — API keys.** Stored SERVER-SIDE in `<dataDir>/keys.json`
  (0600, atomic, like the GitHub token), one optional key per tool that honours
  an environment variable directly: Claude Code → `ANTHROPIC_API_KEY`, Gemini
  CLI → `GEMINI_API_KEY`, Grok → `XAI_API_KEY`. The page only ever learns
  saved / not saved; the key is injected into THAT tool's child environment at
  spawn, never into argv, never into `server.log`. Codex gets NO key field:
  an `OPENAI_API_KEY` alone does not authenticate it (its docs: `codex login`
  or `codex login --with-api-key`), so the honest line is "Signs in inside the
  terminal". Rejected: no storage at all; env-only detection.
- **Open decision 6 — Command Prompt.** Yes, via WSL interop like PowerShell,
  starting in the project folder: `cmd.exe` refuses a UNC working directory
  (measured 2026-09-18: "UNC paths are not supported. Defaulting to Windows
  directory"), so the server injects `/k pushd <windows path of cwd>` — cmd
  maps a drive letter and the prompt opens in the folder (measured: `Z:\home\…`).
  PowerShell stays `powershell.exe -NoLogo` (decided 2026-09-10); NO `pwsh.exe`
  card — it is not installed and the v3 mention was never adopted.
- **Not-installed tools.** The backend probes PATH; a card whose executable is
  absent stays inert with the sub-line `Not installed` (replaces `Not
  available yet`). Installed for the live check 2026-09-18: Gemini CLI 0.60.0
  (npm, user-level); zsh = `sudo apt install zsh` by the user's own hand;
  Grok Build NOT installed (needs a SuperGrok / Premium+ subscription) — its
  card is built from the docs and stays `Not installed` here.
- **Start from.** Claude Code: per-conversation entries of the selected
  project (the same entries the Earlier section lists), each resuming by id.
  Codex: `The last session` + `Pick an earlier session` (Codex's own picker
  inside the terminal). Gemini CLI and Grok: `The last session` only. Grok's
  `-s <uuid>` pinning and Gemini's `--session-id` (present in 0.60.0,
  verified locally) are cheap follow-ups, NOT this part.

## Verified CLI contracts (2026-09-18)

Sources: `codex --help` (installed 0.116.0; the current 0.155 retired
`untrusted`/`on-failure`, so only `on-request`/`never` are used — valid in
both), `gemini --help` (installed 0.60.0), docs.x.ai/build (Grok Build, not
installed; unverified locally, marked in code comments), `claude --help` 2.1.276.

| | Claude Code `claude` | Codex `codex` | Gemini CLI `gemini` | Grok Build `grok` |
|---|---|---|---|---|
| Model | `--model <id>` (unchanged) | `-m <id>`; `Default` emits nothing | `-m pro\|flash\|flash-lite`; `Auto` (default) emits nothing | `-m grok-4.6`; `Default` emits nothing |
| Effort | `--effort low..max` (unchanged) | `-c model_reasoning_effort=<minimal\|low\|medium\|high\|xhigh>`; `Default` emits nothing; no `max` | NONE — control hidden | `--effort low\|medium\|high`; `Default` emits nothing |
| Always ask | (nothing) | `-a on-request -s read-only` | (nothing; `default`) | (nothing) |
| Auto edits | `--permission-mode acceptEdits` | `-a on-request -s workspace-write` | `--approval-mode auto_edit` | INERT card, hint `Grok switches this inside the session` |
| Read only | `--permission-mode plan` | `-a never -s read-only` | `--approval-mode plan` | INERT card, same hint |
| No prompts | `--permission-mode bypassPermissions` | `--dangerously-bypass-approvals-and-sandbox` | `--approval-mode yolo` | `--always-approve` |
| Fresh | (nothing) | (nothing) | (nothing) | (nothing) |
| Last | `--continue` | subcommand `resume --last` (options BEFORE the subcommand: `codex -m x -a … resume --last`; `codex resume --help` accepts `-m -s -a -c` too) | `-r latest` | `--continue` |
| Earlier by id | `--resume <uuid>` (from history) | `resume` (Codex's picker; no `--last`) | — | — |
| Key env | `ANTHROPIC_API_KEY` (optional; login is the norm) | none — signs in inside the terminal | `GEMINI_API_KEY` | `XAI_API_KEY` |

Codex model ids offered (docs, 2026-09): `gpt-6-astra`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini` —
`Default` first (the CLI picks its recommended model). Labels = the id with
the vendor's casing (`GPT-6 Astra`, `GPT-5.6 Sol`, …). Gemini labels `Auto`,
`Pro`, `Flash`, `Flash Lite`. Grok `Default`, `Grok 4.6`.

Argv order per tool is FIXED and pinned by tests (byte-exact), the way
`composeArgs` pins claude's: model, permission, effort, then the start-from
tail (`--continue` / `-r latest` / `resume --last` / `resume` / `--resume <id>`).

Shells: `Zsh` = `zsh -l` (PATH-resolved, probe `zsh`); `Command Prompt` =
client sends `{ command: 'cmd.exe', args: [] }`, the SERVER injects the
working-directory tail (below). PowerShell and Bash unchanged.

## Phase 0 (orchestrator, inline) — the contract in `shared/protocol.ts`

```ts
/** GET /api/tools -> which launchable executables the backend can find on ITS PATH. */
export interface ToolAvailability {
  claude: boolean; codex: boolean; gemini: boolean; grok: boolean;
  zsh: boolean; cmd: boolean; powershell: boolean;
}
/** The tools that take a stored API key. */
export type KeyedTool = 'claude' | 'gemini' | 'grok';
export const KEYED_TOOLS: readonly KeyedTool[] = ['claude', 'gemini', 'grok'];
/** The environment variable each keyed tool reads. */
export const KEY_ENV: Record<KeyedTool, string> = {
  claude: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY', grok: 'XAI_API_KEY',
};
/** GET /api/keys -> saved in keys.json / present in the backend's own environment. */
export interface KeyStatus {
  saved: Record<KeyedTool, boolean>;
  env: Record<KeyedTool, boolean>;
}
/** PUT /api/keys/:tool body. */
export interface SaveKeyRequest { key: string }
```

Routes (token + Origin/Host like every `/api` route):
- `GET /api/tools` → `ToolAvailability`. PATH lookup of `claude`, `codex`,
  `gemini`, `grok`, `zsh`, `cmd.exe`, `powershell.exe` in the PTY env's PATH
  (the same env a session is spawned with — `ptyEnv()` — so the probe and
  reality cannot disagree): regular file, `X_OK`. No spawn. Cached ≤ 5 s.
- `GET /api/keys` → `KeyStatus`. `PUT /api/keys/:tool` `{ key }` → `OkResponse`
  (`400` unknown tool / bad key). `DELETE /api/keys/:tool` → `OkResponse`.
- `POST /api/sessions` unchanged in shape; new server behaviour below.

## Phase 1 — backend (`backend-pty`)

1. `server/tools.ts`: `probeTools(env)` + the cached route.
2. `server/keys.ts`: `KeyStore` — `keys.json` (0600, atomic rename, `{ [tool]: key }`),
   load gated (object, string values only; anything else = empty store + one
   warn line), `status(env)`, `save(tool, key)`, `clear(tool)`. Key
   validation: trim, 1–4096 chars, printable ASCII without spaces
   (`/^[\x21-\x7e]+$/`); reject otherwise with the constant sentence
   `That does not look like an API key.` Never log the value; log
   `key saved for <tool>` / `key cleared for <tool>` only.
3. Spawn-time injection in `server/sessions.ts` (narrow, by
   `basename(command)`, exactly like the `--settings` / `--session-id`
   injections — PTY argv/env only, never `SessionInfo.args`):
   - `claude` / `gemini` / `grok`: when a key is SAVED for that tool, set its
     `KEY_ENV` variable in the child env (a saved key beats an inherited one —
     saving it was the user's explicit act). No saved key → env untouched.
   - `cmd.exe` with EMPTY client args: append `/k pushd <winPath>` where
     `winPath` is computed by a pure function `windowsPathFor(cwd, distro)`:
     `/mnt/<d>/rest` → `<D>:\rest`; anything else →
     `\\wsl.localhost\<distro>\<cwd with backslashes>`; `distro` =
     `WSL_DISTRO_NAME`. The tail is injected ONLY when the cwd matches the
     launcher's allow-list shape `^/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$` AND
     `WSL_DISTRO_NAME` is a valid distro name (`^[A-Za-z0-9._-]+$`) — cmd
     parses its own line and `& | ^ % " space` are metacharacters there;
     otherwise spawn plain `cmd.exe` and log one warn line
     (`cmd.exe: working directory not passed (path shape)`). A resume
     re-injects (history stores the client's `[]`).
   - `--resume <uuid>` adopted from client args (the dialog's per-id resume)
     while that history entry is LIVE → `409 { error: 'That conversation is already running.' }`
     (the history route already refuses the same case).
4. `commandLabel`-side: nothing on the server; history rows keep the command.
5. Tests (test-engineer + developer): tools probe with a temp PATH dir of
   fake executables (present / absent / non-executable / directory named like
   a tool); keys routes (validation table, 0600, atomic, `server.log` never
   contains the key — grep after save/clear/spawn); env injection via a fake
   `gemini` script on PATH that prints the variable into the PTY (and a fake
   `claude`? no — the `--settings`/`--session-id` injection would fire; use
   `gemini`), plus "no saved key → variable absent even when the backend's
   own env has none"; `windowsPathFor` table; `cmd.exe` injection via a fake
   `cmd.exe` script that echoes its argv (present on the temp PATH; on CI no
   real interop exists); the 409 on a live `--resume`. Hard-constraint code
   (spawning, argv, env, a stored credential) → FULL mutation probe (rule 10).

## Phase 2 — frontend (`terminal-ui`, `frontend-designer` applies)

1. `launch-args.ts`: per-tool vocab tables (models, efforts, permission
   availability, start-from options) + `composeSpawn` for the kinds `codex`,
   `gemini`, `grok` (one composition path stays; `KINDS` grows; every
   pre-B5 argv byte-identical, pinned by the existing tests). `TOOL_CARDS`
   kinds filled; `SHELL_CARDS` zsh + cmd wired to `SHELLS` entries
   (`{ id: 'zsh', label: 'Zsh', command: 'zsh', args: ['-l'] }`,
   `{ id: 'cmd', label: 'Command Prompt', command: 'cmd.exe', args: [] }`).
   `commandLabel` names `codex` → `Codex`, `gemini` → `Gemini CLI`, `grok` →
   `Grok`, `zsh` → `Zsh`, `cmd.exe` → `Command Prompt` (basename rule like
   claude). `modelFromArgs` also reads `-m <v>` (Codex, Gemini, Grok) so the
   pane status bar's Model row is honest for them; Mode stays claude-only.
2. `launch.ts`: on open, `GET /api/tools` + `GET /api/keys` (+ `GET
   /api/history` when Claude Code is the tool); the card grid follows
   availability — an absent tool = inert card, sub-line `Not installed`
   (`NOT_YET` retired; the constant is renamed, no `Not available yet` left
   anywhere). Per-tool control set: Model options per tool; Effort per tool
   (hidden for Gemini, like the claude-only controls are hidden for
   Terminal); Permissions cards with per-tool inert cards (Grok: Auto edits
   and Read only inert, hint text above); the (i) popover keeps its four
   generic lines. Start from per tool (table above); for Claude Code the
   select lists the selected project's ended conversations
   (`conversation === true`, `projectId` match — with no project, entries
   whose `cwd` is the home folder), newest first, label = title + relative
   time (the Earlier section's wording), value = the conversation id;
   choosing one presets Name to the entry's title (still editable) and emits
   `--resume <id>` in place of `--continue`. Notice row for Gemini and Grok
   when `!saved && !env`: `Needs an API key, or sign in inside the terminal
   the first time.` + button `Add key` → closes the dialog, opens Settings →
   Preferences with that tool's key field focused. Codex: no notice; its
   Settings row explains. Claude Code: no notice.
3. `settings.ts` Preferences: the key rows go LIVE for Claude Code, Gemini
   CLI, Grok (password field, `Save` / `Remove`, `Show` toggle as today's
   GitHub token field; after save the field shows `Saved` state, never the
   key back — the page only knows saved/not saved; a saved key can be
   replaced or removed). Codex row: `Signs in inside the terminal`, no field.
   Claude row: `Uses your Claude login. A saved key is used instead.` The
   tool-visibility + Defaults blocks stay mock (B6) — the placeholder note
   moves under Defaults and says only that.
4. Copy rule: no flag or command anywhere (the mapping lives in
   launch-args.ts only). State words as before.
5. Tests: `tests/ui-launch-args.test.ts` (per-tool argv tables, byte-exact;
   pre-B5 forms unchanged), `tests/ui-launch-dialog.test.ts` through the real
   dialog in the fake DOM (availability → inert cards, notice logic, resume
   entries, control hiding per tool), settings key rows. Mutation cap ~10
   (UI surface), except `composeSpawn` (argv = hard constraint → full probe).

## Final gate

- `/verify-terminal`, once: a real `codex` session, a real `gemini`
  session (to its sign-in screen at least), `zsh -l`, `cmd.exe` in the
  project folder (prompt shows the mapped drive), one claude per-id resume
  from the dialog. Resize, keys, attach/replay as the seams demand.
- Janitor: `NOT_YET` gone, the Settings mock markers reduced to B6's.
- Windows check owed to the user afterwards (Command Prompt prompt, the
  dialog's Not-installed cards, the key fields).

## Out of scope (recorded)

Tool visibility toggles (B6); Grok per-id pinning and Gemini `--session-id`
(follow-up); `pwsh.exe`; Codex per-id entries (their picker covers it);
per-tool permission help lines (the popover stays generic — accepted
approximation, revisit if the user asks).
