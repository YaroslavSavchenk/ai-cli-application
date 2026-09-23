---
type: decision
created: 2026-07-23
updated: 2026-09-23
tags: [scope, github, projects, security, auth]
---
# Project creation + GitHub integration (OAuth device flow, full v1)

**Status:** decided (2026-07-23, user's call — GO into scope)

The app was a passive registrar: "Add project" = browse to an existing
directory + name it. The user wants it to *create* projects itself and to
grow a real GitHub connection — inspect the user's repos and offer to clone
them locally or create a new one.

## User's decisions (2026-07-23, direct answers)

- **GitHub auth = OAuth device flow.** Chosen over the two alternatives
  offered (pasted PAT; reuse the local `gh`/git credentials). App registers
  as a GitHub OAuth app, user approves a device code, a scoped + revocable
  token is stored **server-side** in the data dir beside `prefs.json`.
- **v1 = the full shape** (chosen over a local-projects-only first slice):
  1. **Create a local project** — new dir + `git init` + register in
     `projects.json`.
  2. **Clone from GitHub** — list the user's repos in-app, clone a chosen
     one into a new project.
  3. **Create a new GitHub repo** — from the app: local + create/push remote.

## Rejected alternatives

- **Reuse local `gh`/git** (no new secret; matches the CLI-manager model) —
  my recommendation, rejected by the user in favor of a self-contained
  in-app connection.
- **Paste a PAT** — simplest to build; rejected.
- **Local-projects-only first slice** — ship creation without GitHub, add
  clone/create later; rejected, user wants the full shape in v1.

## Security (the load-bearing constraint)

This is a **localhost service that already spawns shells**, guarded by the
token-auth + Origin/Host model in [[localhost-security-model]]. Adding a
GitHub OAuth token is a new stored credential, so:

- The token lives server-side only (data dir, user-only perms); it is
  **never** returned to the browser or embedded in any page. The drive-by
  web-page threat means every GitHub endpoint keeps the same auth token +
  Origin/Host parity as the rest of `/api`.
- `git clone` / `git init` / repo-create run via **argv spawning**, no shell
  string interpolation (same discipline as session spawning). Clone/create
  target paths are user-chosen and validated like existing project paths.
- Device-flow polling and token storage must not leak the token into
  `server.log` or any status output (cf. the runtime.json token-redaction
  rule already in the launcher).

## Open sub-questions for the build (dev-flow decides, surface to user if forky)

- Where new local projects / clones are rooted (a configurable base dir vs
  per-create path pick). Default: pick-a-path, like Add project.
- Whether repo-create defaults private; visibility toggle in the UI.
- Token revocation / "disconnect GitHub" affordance in the settings panel.

## Notes

- This lands through `/dev-flow` (multi-part: backend OAuth + git ops, shared
  protocol schema for the new endpoints, frontend UI). Not one commit.
- Unrelated to the Edge taskbar-icon bug tracked in the same session (that
  is a launcher/Chromium issue, not part of this feature).

Related: [[localhost-security-model]], [[handoff-design-primary]],
[[auto-port-discovery]], [[agent-team-and-dev-flow]]

## From the scope doc (moved 2026-09-23)

Verbatim wording of the `.claude/PROJECT-SCOPE.md` bullet before part O1 condensed it; the scope doc holds the current rule.

### Features (decided) — Project creation + GitHub integration

- **Project creation + GitHub integration — GO given 2026-07-23, user's
  call; shape decided the same day.** The app stops being a passive
  registrar of existing directories and can *create* projects itself, and
  it grows a first-class GitHub connection. Decided pieces:
  - **GitHub auth = OAuth device flow** (user's choice 2026-07-23 over a
    pasted PAT or reusing the local `gh` CLI): the app registers as a
    GitHub OAuth app, the user approves a device code, and a scoped,
    revocable token is stored **server-side** in the data dir beside
    `prefs.json` (never in localStorage, never returned to the browser).
  - **A pasted token is a SECOND credential path — decided and LANDED
    2026-07-25, user's request.** Extends (does not replace) the
    device-flow decision: an "add token" affordance stores a user-pasted
    GitHub token server-side and uses it wherever the device-flow token is
    used. It needs no OAuth App, so it makes the feature usable before the
    client id exists — hence `configured` becomes `deviceFlowAvailable` and
    must never hide the paste affordance. **Persisted by default with a
    "remember this token" toggle** (off = process-memory only, gone when the
    backend exits). A security design gate ran *before* any code: storage
    ceiling is 0600 + discipline (no keyring exists here, verified; same-disk
    encryption is theatre), the UI must claim nothing stronger than "stored on
    this machine, readable by your own user account", it must recommend a
    fine-grained token limited to selected repositories with an expiry (which
    is strictly safer than our own `repo`-scoped device flow), show the
    resolved account before accepting, warn against pasting a token someone
    else supplied, and branch the revocation copy on the credential source.
    Full constraint list and refusals in
    `memory/decisions/github-token-paste-path.md`.
  - **v1 is the full shape** (user's call over a local-only first slice):
    (1) **create a local project** — new directory + register in
    `projects.json`, with an **"Initialize git repo" toggle (default on)**
    controlling the `git init` (decided 2026-07-24, reconciling the
    prototype's "no git init" caption with the earlier always-init: user
    chose a per-create toggle); (2) **clone** — from a pasted git URL
    (the Phase 2a foundation, no GitHub account needed) and, once connected,
    by picking from the user's in-app repo list (Phase 2c); (3) **create a
    new GitHub repo** from the app (local + create/push the remote).
    Phasing (implementation, 2026-07-24): **2a** = local create + URL clone +
    folder picker (landed); **2b** = GitHub OAuth device-flow connection +
    repo listing; **2c** = clone-by-picking + create-repo.
  - **OAuth scope = `repo` (write) up front** (decided 2026-07-24, over a
    read-only-then-escalate flow): a single device-flow grant covers list +
    clone + create-repo + push with no re-auth, matching the full v1 shape.
    The prototype's "read-only by default" caption is superseded.
  - **Security gate (non-negotiable):** the OAuth token is a new stored
    credential on a localhost service that already spawns shells. Every
    GitHub-touching endpoint stays behind the same token-auth +
    Origin/Host parity as the rest of `/api`; the GitHub token itself is
    never exposed to the page. `git clone`/`git init`/repo-create run via
    argv spawning (no shell string interpolation), into user-chosen paths
    validated the same way project paths already are. Token-bearing
    requests set `redirect: 'error'` (added 2026-07-24) so the guarantee
    that a credential never follows a redirect is enforced here rather
    than inherited from the runtime's fetch implementation. Threat-model
    detail in `memory/decisions/github-integration.md`.
  - **`AI_SM_GITHUB_API_BASE` is a test-only seam** (decided 2026-07-24,
    user's call, over gating it behind a build/run mode). It overrides the
    `api.github.com` REST base so the *connected* HTTP paths can be tested
    offline — the server spawns as a child process in tests, so no
    in-process seam can reach it. It is **loopback-only** (`127.0.0.1`,
    `localhost`, `[::1]`, no userinfo, no path/query/fragment) and any
    other value makes the server **refuse to start** (exit 1 before
    `listen`, no `runtime.json`), so it can never be a legitimate
    production or GHES setting. It moves neither the device-flow URLs nor
    the clone host-lock to `github.com`. Unlike the other `AI_SM_*` knobs
    this one has no production use by construction; that is deliberate and
    recorded rather than hidden.
