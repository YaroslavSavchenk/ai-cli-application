---
type: log
created: 2026-07-25
updated: 2026-07-25
tags: [github, security, statusline, start-here]
---
# 2026-07-25 (pt.3) — pasted-token path shipped · START HERE next

Third phase of a long day (after [[2026-07-25-pty-tail-rescue]] and
[[2026-07-25-ui-copy-and-clone-paths]]). **Landed and pushed: `84da3f0`.**
Suite 462 → 533. Tree clean.

## What shipped

The **pasted GitHub token** path beside the device flow ([[github-token-paste-path]]).
`POST /api/github/token` validates with `GET /user` + a repo probe, stores in
`github.json` 0600 with `source`/`scopes`/`expiresAt`; `remember:false` writes
nothing and deletes any existing file. `configured` → `deviceFlowAvailable` on
the wire, and the three connected routes no longer require a client id —
without that the paste path would have been hidden in exactly the situation it
exists for. The panel recommends a fine-grained token limited to selected
repositories with an expiry, and admits what that costs (it cannot create a new
repo from the app).

## The process fact worth keeping

**The security gate ran BEFORE any code, on the user's explicit request, and
was committed first (`4f23fe2`).** The auditor then audited against its own
published list rather than against memory — it could not quietly soften a
requirement. It re-derived every constraint against a running server: forced
`#persist()` to fail with `chmod 0500` to confirm `persisted` reports reality,
proved GitHub's response body is structurally unreachable on failure paths
(`#mapTokenFailure` takes a `number`), and reproduced the predicted log leak by
mutating the guard away in a *copy* of the repo. Do this again for anything
that stores a credential.

## What the gate + reviewers caught that would otherwise have shipped

- **A strip that lied in the user's own configuration.** With `remember:false`,
  a plain backend restart told the user GitHub had rejected their credential —
  three named causes, all false. Someone would have revoked a healthy token.
- **Two measured log leaks.** Node embeds a fragment of the request body in
  `JSON.parse` errors, and the shared handler logged `String(err)` plus the
  full URL. Fixed on the token route *and* repo-wide (error class + pathname
  only). Rule recorded: any future secret-bearing route copies the safe reader,
  and no credential ever rides in a query string.
- **A 403 as an opaque 502** on create-repo — the most predictable failure of
  the credential we recommend.
- **Two mutually-shadowing tests**: the existing test stubbed 500 on *both*
  upstream calls, so either `!ok` guard could be deleted unnoticed. Consequence
  of the `/user` half: a partial GitHub outage would connect the app with an
  unverified identity.
- A live mutation-test mutant (`if (true) // MUT r2`) sat in the tree for ~13
  minutes while the test engineer worked. Harmless — the suite kills it — but
  **verify `git diff | grep MUT` is empty before every commit** now.

## Honest limits recorded, not papered over

- `0600` is not a boundary against Windows ([[wsl-0600-not-a-boundary]]).
- No keyring exists in this distro; same-disk encryption is theatre; BitLocker
  covers the only case it would address. **User action pending: check BitLocker
  on `C:`.**
- "No lateral movement after app access" cannot be promised — `POST
  /api/sessions` spawns arbitrary commands as the user *because that is the
  product*. The deliverable promise is "unauthorized parties cannot reach the
  app", which was verified to hold.
- Unsetting `AI_SM_GITHUB_CLIENT_ID` is NOT a kill switch for a stored
  credential. Disconnect is.

# START HERE — the statusline phase (researched, not built)

**User decisions (2026-07-25), all taken, none open:** our per-pane status strip
is **removed** and replaced by Claude Code's own status line; the settings panel
keeps ONLY the status-line config — **launch defaults, usage display AND the
auto-run startup command are deleted**, including their backends
(`/api/usage`, `/api/telemetry`, `ui/startup.ts`, `ui/statusbar.ts`, their prefs
keys). This reverses the 2026-07-20 "decided four" — say so in the scope doc.
Scoped to app-launched sessions only; the user's `~/.claude/settings.json` is
never touched. A notice must tell the user when sessions need restarting.

**Verified contract** (docs fetched 2026-07-25 — re-verify version-gated items):

- **`claude --settings /abs/path.json`** — key-level merge, that session only,
  writes nothing, leaves their hooks/MCP/permissions/model alone. This is the
  mechanism. `CLAUDE_CONFIG_DIR` would take out their credentials, history and
  trust state — rejected. A project `.claude/settings.json` mutates their repo
  and loses to their own local settings — rejected.
- **Live updates need no restart.** The command re-runs on every assistant
  message, `/compact`, permission-mode change, and on `refreshInterval` (min 1 s)
  if set. Point `command` at a stable script that reads a config file each
  invocation → toggles apply to running sessions. Only sessions started WITHOUT
  our `--settings` need a restart — and those are detectable, so the notice can
  name them instead of nagging everyone.
- **stdin gives natively**: `model`, `cost.total_cost_usd`,
  `cost.total_lines_added/removed`, `context_window.used_percentage` +
  `context_window_size`, `transcript_path`, `session_id`, `workspace.*`.
  **NOT in the payload: git branch** (shell out to `git branch --show-current`,
  cache on `session_id` ~5 s — never on pid) and **permission mode** (so the
  per-session settings file carries it as an argument).
- **`rate_limits` IS in the payload** (five-hour + seven-day, with reset
  timestamps; Claude.ai Pro/Max, after the first API response). This revives
  the `usage %` item we shipped as an honestly-disabled row — it can now be
  real. See [[2026-07-24-status-bar]] for why it was deferred.
- **Build for this failure mode**: the status line does not run until the
  workspace trust dialog is accepted for that cwd — the bar is simply blank,
  no error. A newly created project is exactly that case.
- Non-zero exit or empty output → blank. No documented timeout. Emoji width
  policy undocumented → prefer ASCII. Invoke as `node /abs/x.mjs` so a missing
  exec bit cannot silently blank the bar.

**Also still open, both user-side and both now four sessions old:**
`/verify-terminal` live pass on Windows, and registering the GitHub OAuth App
(no longer blocking — the token path works without it).

Related: [[github-token-paste-path]], [[wsl-0600-not-a-boundary]],
[[no-code-in-ui-copy]], [[2026-07-25-ui-copy-and-clone-paths]],
[[2026-07-24-status-bar]], [[localhost-security-model]]
