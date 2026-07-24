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

## Guidelines for next session (START HERE)

**Read first:** `.claude/PROJECT-SCOPE.md`, `memory/INDEX.md`, this note +
[[2026-07-24-status-bar]]. Recall [[github-integration]],
[[localhost-security-model]], [[native-webview2-host]], [[thin-windows-launcher]].

**State:** Phase 1 (status bar) + Phase 2 (project creation + full GitHub
integration: connect / clone-by-pick / create-repo) are LANDED, reviewed
(security CLEAN throughout), and pushed to origin/main. Suite 288 green. Tree
clean. The GitHub feature is **built but dormant** until a client_id is set.

**Queue — suggested order:**

1. **User actions to unblock live use** (the user does these; then a live
   smoke test): register a **GitHub OAuth App** with **device flow enabled**,
   set env **`AI_SM_GITHUB_CLIENT_ID`** (non-secret; no client_secret needed).
   Then smoke-test the real device flow: chip → connect → user_code at
   github.com/login/device → connected → repo list → clone one → create one.
   Nothing GitHub has had a live round-trip yet (only fetch-seam + not-
   configured paths).

2. **White native title bar** (user-requested backlog; native host / launcher).
   `/dev-flow`, agent `wsl-launcher`. The bar is the WebView2 host's standard
   Windows caption (white + "AI Session Manager"), from the C# host (`113533e`).
   Two routes: (a) QUICK — DWM `DwmSetWindowAttribute` `DWMWA_CAPTION_COLOR` +
   `DWMWA_TEXT_COLOR` + `DWMWA_USE_IMMERSIVE_DARK_MODE`, match `--bg-app`
   #171d25; (b) user's preferred INTEGRATED — frameless host (extend client
   area over caption) + a custom draggable title strip in the web UI
   (host-assisted min/max/close; WebView2 has no Electron `-webkit-app-region`).
   Confirm with the user which route (quick color vs full frameless) before
   building the bigger one.

3. **verify-terminal live pass** (Windows UI; not drivable from WSL) — the
   status-bar resize (#4) + the create/clone flows. Checklist was handed to the
   user; fold the result back.

4. **Test-hardening (batched, non-blocking):**
   - Extract `web/src/ui/github-model.ts` (chipView, fmtExpiry(now-injected),
     langColor, relTime(now-injected), GH_POLL_MS/debounce) + unit tests —
     repo's `newproject-model`/`theme-model` pattern.
   - `GithubConnection` DI seam into `createRequestHandler` (like the fetch/
     spawn seams) so the CONNECTED `/api/github/clone` + `/api/github/repos`
     HTTP success paths are offline-testable.
   - `AI_SM_GITHUB_API_BASE` override so connected `/api/github/repos` is
     offline-testable.

**Deferred features (not bugs):** push-of-local-commits beyond create+clone;
GitHub-search API for `q` when a user has >500 repos (2b uses a 500-cap +
client-side filter); an editable dest picker for pick-clone (fixed
`<home>/projects/<name>` today — falls back to the 2a URL-clone tab on collision).

**Process reminders:** all subagents on opus; orchestrator only orchestrates/
arbitrates. Commit+push after every landed dev-flow phase (standing auth).
Caveman replies. UI → /frontend-designer then /dev-flow. Honesty rule held all
session: real value or omit, never fake (usage% deferred; clone spinners
indeterminate; corrected the prototype's wrong GitHub copy).

Related: [[2026-07-24-status-bar]], [[github-integration]],
[[localhost-security-model]], [[handoff-design-primary]], [[thin-windows-launcher]],
[[native-webview2-host]]
