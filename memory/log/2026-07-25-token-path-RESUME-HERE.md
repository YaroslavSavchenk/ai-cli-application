---
type: log
created: 2026-07-25
updated: 2026-07-25
tags: [handoff, github, security, statusline, in-flight]
---
# RESUME HERE — token path mid-flight, statusline phase queued

Written because the session limit was about to hit. **There is uncommitted
work in the tree** — it is complete and scope-reviewed, not abandoned.

## State of the working tree (uncommitted)

The **pasted-GitHub-token path** (`[[github-token-paste-path]]`), server +
browser, both halves landed by their developers. Suite **528 pass / 0 fail**,
both typechecks clean, vite build clean. Last commit is `4f23fe2` (docs only).

- Server: `POST /api/github/token`, validation via `/user` + a repo probe,
  storage in `github.json` 0600 with `source`/`scopes`/`expiresAt`,
  `remember:false` writes nothing and deletes any existing file. `configured`
  REMOVED from the wire in favour of `deviceFlowAvailable`; `listRepos` /
  `cloneAuthenticated` / `createRepo` no longer require a client id.
- Browser: token well beside the sign-in card, remember toggle, account
  verification line, source-branched revocation copy, credential-lost strip,
  fine-grained recommendation. New repo-wide test guard banning
  "keychain/encrypted/secure"-style claims in frontend copy.

## Review status

- **scope-reviewer: conformant**, no must-fix. Findings below.
- **security-auditor** (the same agent that wrote the design gate) and
  **test-engineer**: were still running when the limit approached. Their
  verdicts are NOT in. **Do not commit before they land** — the gate list they
  are checking is `memory/decisions/github-token-paste-path.md`.

## Findings awaiting a fixer (from scope review)

- **S1 `web/src/ui/github.ts:176`** — `credentialLost = !userDropped` fires on
  ANY unasked-for disconnect, so with `remember:false` a plain backend restart
  tells the user "GitHub stopped accepting the stored credential… expired,
  revoked, or lost access" when the truth is "you chose not to store it".
  All three named causes false, in the mode the user's own toggle creates.
  `prev?.persisted === false` is already in hand to suppress it.
- **S2 `server/github.ts:1022`** — `createRepo` maps every non-ok to
  `502 github request failed`. A fine-grained token limited to selected
  repositories gets **403** there — the most predictable failure of the
  credential the panel recommends, shown in our most opaque message.
  `#mapTokenFailure` next door is the pattern to copy.
- **S3 `web/src/ui/github.ts:717`** — `.gh-tokeninput.is-err` has no CSS rule;
  the field never turns red. Error still reaches the user as text.
- Notes: N1 stale `configured` doc comment (`web/src/api.ts:234`); N2
  DESIGN.md quotes a typographic apostrophe the code does not use; N4 the
  "does not expire" claim is false if the OAuth App enables token expiry;
  N5 `expiresAt` carries two meanings gated on `state`; N6 `userDropped` can
  latch; N7 PROJECT-SCOPE still says "implementation queued" (orchestrator's).
- Settled by review, do NOT collapse: `scopes` **absent** (fine-grained — no
  scopes header) vs **`[]`** (classic token with zero scopes) are different
  facts; collapsing would tell a user their correctly-configured recommended
  token has no permissions.

## Next phase, already researched and decided — statusline in Claude Code

The user's decisions (2026-07-25): our per-pane status strip is **removed** and
replaced by Claude Code's own status line; settings keeps ONLY the status-line
config — **launch defaults, usage display AND the auto-run startup command are
deleted**, including their backends (`/api/usage`, `/api/telemetry`,
`ui/startup.ts`, the prefs keys). Scoped to app-launched sessions only — the
user's `~/.claude/settings.json` is never touched.

Verified contract (docs fetched 2026-07-25, raw copies were in the scratchpad —
re-fetch if gone):

- **`claude --settings /abs/path.json`** — key-level merge for that session
  only, writes nothing, leaves their hooks/MCP/permissions/model alone. This is
  the mechanism. `CLAUDE_CONFIG_DIR` would nuke their credentials, history and
  trust state — rejected. Project `.claude/settings.json` mutates their repo and
  loses to their own local settings — rejected.
- **Live updates need no restart**: the command re-runs on every assistant
  message, `/compact`, permission-mode change, and on `refreshInterval` (min 1s)
  if set. Point `command` at a stable script that reads a config file each
  invocation → toggles apply to running sessions. Only sessions started WITHOUT
  our `--settings` need a restart, and those are detectable — that is the honest
  scope of the "restart these sessions" notice the user asked for.
- **stdin payload gives natively**: `model`, `cost.total_cost_usd`,
  `cost.total_lines_added/removed`, `context_window.used_percentage` +
  `context_window_size`, `transcript_path`, `session_id`, `workspace.*`.
  **NOT in the payload: git branch** (shell out to `git branch --show-current`,
  cache on `session_id` ~5 s) and **permission mode** (so the per-session
  settings file must carry it as an argument).
- **`rate_limits` IS in the payload** (five-hour + seven-day, with reset
  timestamps; Claude.ai Pro/Max, after the first API response). This revives the
  `usage %` item we deferred as unsourceable — it can now be honest.
- **Honest failure mode to build for**: the status line command does not run
  until the workspace trust dialog is accepted for that cwd — the bar is simply
  blank, no error. First look at a newly created project is exactly that case.
- Non-zero exit or empty output → blank line. No documented timeout. Emoji
  width policy undocumented → prefer ASCII. Invoke via `node /abs/x.mjs` so a
  missing exec bit cannot silently blank the bar.

Related: [[github-token-paste-path]], [[wsl-0600-not-a-boundary]],
[[no-code-in-ui-copy]], [[2026-07-25-ui-copy-and-clone-paths]]
