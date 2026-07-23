---
type: decision
created: 2026-07-23
updated: 2026-07-23
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
