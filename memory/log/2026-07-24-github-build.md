---
type: log
created: 2026-07-24
tags: [github, project-creation, oauth, device-flow, scaffold, dev-flow, security, milestone]
---
# 2026-07-24 (pt.2) — Project creation + GitHub connection (Phase 2a + 2b)

Continuation of [[2026-07-24-status-bar]]. Built the project-creation / GitHub
feature ([[github-integration]]) in phases. **2a + 2b landed; 2c (GitHub
actions) remains.** All sub-agents on opus; orchestrator (Fable 5→Opus this
session) arbitrated.

## Phasing (decided while building, recorded in PROJECT-SCOPE)
- **2a** = local create (blank dir + git-init toggle) + clone-from-URL +
  folder picker. No GitHub account needed. `ccfbe7f`.
- **per-project defaults** re-added to the create dialog (user's call over the
  prototype's omission). `4c7915e`.
- **2b** = GitHub OAuth device-flow connection + repo listing (view). Backend
  `4d858ad`, frontend `7ec01ee`.
- **2c** = clone-by-picking (token-auth clone) + create-repo. **LANDED**
  (`ecbc07f`). Token-safe clone via GIT_ASKPASS-through-env (token never in
  argv/URL/`.git/config`/log); cloneUrl rebuilt + host-locked to exactly
  github.com — security resisted every exfil bypass tried
  (`github.com.evil.com`, backslash, trailing-dot, port, IDNA). createRepo =
  create-remote-then-clone-then-register. Push-of-local-commits deferred.
  Suite → 288. **Phase 2 (project creation + full GitHub integration) COMPLETE.**

## Key user decisions (this session)
- Sequencing: status bar first, then GitHub (done in [[2026-07-24-status-bar]]).
- Blank create: **"Initialize git repo" toggle, default on**.
- OAuth scope: **`repo` (write) up front** (one grant covers list/clone/create).
- client_id sourcing: **build now, config-driven** (`AI_SM_GITHUB_CLIENT_ID`;
  dormant until the user registers the OAuth App) over register-first.
- Per-project default model/mode: **add back** to the create dialog.

## Security posture (the load-bearing part)
- **2a write-side** (`server/scaffold.ts`): git via `spawn(...,{shell:false})`,
  `git clone -- <url>` (`--` guard); url allowlist (http(s)/git/ssh/scp),
  rejects `-`-leading / control-chars / `file://` / `ext::`; no-clobber (409);
  single-segment mkdir (rejects `/`,`..`,dots,control); `GIT_TERMINAL_PROMPT=0`
  (no hang); `stdio:'ignore'` (no leak/OOM). createLocalDir made **atomic**
  (cleans the created dir if git init fails — a review should-fix).
- **2b credential** (`server/github.ts`): token in `github.json` **0600**,
  server-side ONLY — never in a response, never logged (all 12 log calls
  fixed-string/status-only; one `#load` catch that could echo a token fragment
  was fixed to a fixed string — arbitrated a scope-vs-security split in favor
  of the module's own invariant). Fixed github.com hostnames (no SSRF).
  Bounded polling (MAX_POLLS 300 / 900s / unref'd timers — respects the
  presence-bound backend). **No client_secret** (public device-flow app).
- **Frontend**: all foreign GitHub strings via `textContent` (no XSS); lang
  dot color from a fixed lookup (no CSS injection); no token/localStorage on
  the page. Corrected the prototype's WRONG copy: `repo` scope (not
  "read-only"), server-side token (not "OS keychain").

## Honesty calls
- **disconnect() is local-only** — a public device-flow app can't self-revoke
  at GitHub (no client_secret). UI says so ("remove the app in GitHub
  settings"). Surfaced to the user.
- **not-configured** (no client_id) renders an honest setup panel + muted chip,
  never a dead 409 button.
- Repo list is real GitHub data; 2b is view-only (clone button = 2c seam).

## Dev-flow tally
2a: dev(backend)→dev(frontend)→review(scope+sec+test)→fixer(1: atomicity)→
janitor n/a. 2b: dev(backend)→review→fixer(1: log leak)→commit; dev(frontend)
→review→clean. Security CLEAN on every phase. Suite 247→270 (+~50 tests across
2a/2b, incl. a network-free fetch seam for the OAuth state machine).

## Lessons
- **Phase by external dependency.** The OAuth client_id is an unavoidable
  external prereq; building **config-driven + dormant** let the whole flow land
  and be reviewed now, activating when the user registers — no blocking.
- **Public device-flow ≠ revocable server-side.** Design the disconnect UX
  around "local drop + tell the user to revoke the grant" from the start.
- **A stated security invariant is absolute.** "Token never in the log" meant
  fixing an *unreachable* `String(err)` leak vector anyway (arbitrated over
  "no attack path"). Cheap; honors the contract.

## Loose ends / next
- **2c** — token-auth clone-by-picking + create-repo + push.
- **Blocked-on-user:** register the GitHub OAuth App + set
  `AI_SM_GITHUB_CLIENT_ID`; then a live device-flow smoke test.
- **Test-hardening (batched):** extract `web/src/ui/github-model.ts` + tests;
  add `AI_SM_GITHUB_API_BASE` seam for offline connected-repos tests.
- **verify-terminal** live pass still pending (status bar + create/clone) —
  Windows UI, not drivable from WSL.
- **Backlog (user-reported):** white native title bar in fullscreen — native
  WebView2 host fix (DWM caption color OR frameless + custom title strip).

Related: [[2026-07-24-status-bar]], [[github-integration]],
[[localhost-security-model]], [[handoff-design-primary]], [[thin-windows-launcher]]
