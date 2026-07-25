---
type: decision
created: 2026-07-25
updated: 2026-07-25
tags: [github, projects, paths]
---
# App clones land at <home>/projects/<owner>/<repo>

**Status:** decided (2026-07-25, user's call) — settles the open decision
raised by the 2026-07-24 GitHub test-hardening review

`Project` is `{id, name, path, defaultModel, defaultMode, createdAt}` — it
carries no remote. Clones from the in-app GitHub repo list registered a repo
under its **bare basename** in the default projects folder, which broke two
things at once for two repos with the same name under different owners
(`acme/api` vs `myorg/api`): the second clone 409'd because the folder was
taken, and `clonedProject()` matched it as already-cloned, so its repo-list
button opened the *wrong* local project. The review pinned this honestly as a
`KNOWN LIMIT` test rather than pretending it was fixed.

**User's decision — option (b):** GitHub-list clones go to
`<home>/projects/<owner>/<repo>`. Both repos can exist locally, so the 409
disappears with the mis-identification: `clonedProject()` matches the
`<owner>/<repo>` path tail first and falls back to the bare basename only for
projects registered before this change. Project name stays the repo basename
unless that name is already taken, in which case the clone registers as
`<owner>/<repo>` — a UI that shows names everywhere must not show two
identical ones.

The URL-clone tab is deliberately unchanged: the owner is only reliably known
on the GitHub-list path, and that tab already has a user-chosen destination.

The **create-repo chain uses the same layout** (`<home>/projects/<created
owner>/<created name>`, registered under the created name) — a developer
judgement call I accepted at review time, and the scope reviewer independently
judged it consistent rather than creeping: it meets the same two conditions
that keep the URL tab out of the rule (the owner is authoritative, coming from
GitHub's create response, and the destination is the app's choice rather than
the user's), and one panel with two clone conventions would be the odd result.

## Rejected alternatives

- **(a) An optional `remote`/`fullName` on `Project`**, stamped by the clone
  endpoints and matched first: more explicit data, and it fixes the UI — but it
  changes the `projects.json` schema and `shared/protocol.ts`, and it leaves
  the underlying 409 in place (two same-basename repos still cannot share the
  default folder). Rejected in a direct user answer; still the natural upgrade
  if the app later needs to know a project's remote for its own sake.
- **(c) Accept the limit** and keep the `KNOWN LIMIT` test: rejected.

## Notes

- Every existing guarantee is preserved: argv-only spawning, the clone
  host-lock, the same path validation project paths get, the server-side-only
  token, the token-auth + Origin/Host gate.
- 409 now means precisely "this `<owner>/<repo>` folder already exists".
- The `KNOWN LIMIT` test becomes a real behavioral test — two same-basename
  repos from different owners, both cloned, both identified correctly.

Related: [[github-integration]], [[localhost-security-model]],
[[2026-07-24-github-hardening]]
