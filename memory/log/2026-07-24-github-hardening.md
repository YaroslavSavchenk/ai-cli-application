---
type: log
created: 2026-07-24
updated: 2026-07-24
tags: [github, testing, security, refactor, dev-flow]
---
# 2026-07-24 — GitHub test-hardening (dev-flow, 1 fix cycle)

The batched test-hardening backlog from [[2026-07-24-github-build]], run as a
full `/dev-flow`: two developers in parallel → three reviewers → fixer → two
re-reviewers. **Suite 288 → 391**, typecheck clean, one fix cycle. Landed and
pushed (`9c5bacc`).

## Shipped

- `web/src/ui/github-model.ts` — pure presentation logic extracted from the
  888-line `github.ts` (chip view, expiry + relative time, language colors,
  poll cadence, dest paths, clone error copy), following the existing
  `theme-model` / `newproject-model` pattern. Clock-dependent functions take
  `now` from the caller; `clonedProject` takes the projects list instead of
  reading module state. Zero visual delta, proven by an A/B DOM dump against a
  running backend rather than asserted.
- `AI_SM_GITHUB_API_BASE` — loopback-only override of the `api.github.com` REST
  base. Recorded in the scope doc as a **test-only seam** (user's decision over
  gating it behind a run mode); see below for why it had to be env.
- `redirect: 'error'` on token-bearing requests.
- Review fixes: `Object.hasOwn` guard in `langColor`; refused starts log their
  reason to `server.log`; one shared `projectsPath` helper.

## The lessons worth keeping

**An in-process seam cannot reach an out-of-process server.** `ApiDeps.github`
and `GithubConnection`'s `fetchImpl`/`spawnImpl` already existed — the backlog
item "add a `GithubConnection` DI seam" was already satisfied. The real reason
the connected paths were untestable is that `tests/helpers.ts`
`startTestServer()` **spawns `server/index.ts` as a child process**. Env is the
only injection channel that crosses that boundary. Check which side of a
process boundary your seam lives on before building another one.

**"Unavoidable" deserves one more attempt.** The backend developer concluded a
successful `POST /api/github/clone` could not be covered offline, because the
clone URL is hard-locked to `github.com`. The test engineer refuted it: the
lock constrains the **URL**, not the **binary**. A `git` test double on `PATH`
(via the env `startTestServer` already forwards) covers the whole route with no
loosening of the lock and no product change — including a test that actually
*executes* the `GIT_ASKPASS` round-trip instead of only reading the script's
bytes. Honest self-reported gaps are good; they are still worth a second pair
of eyes.

**A guarantee inherited from the runtime is not a guarantee.** The OAuth token
was safe across redirects only because undici implements the Fetch rule that
strips `Authorization` cross-origin. Nothing in this repo pinned it, and a
redirecting upstream could still make the backend fetch an arbitrary URL and
parse the body as a repo list. `redirect: 'error'` makes it local. Both
reviewers verified the guard by **removing it and watching the tests fail** —
that is the only evidence that a security test is worth anything.

**Behavior-preserving refactors should report bugs, not fix them** — but the
report has to be honest about which is which. Four behaviors were pinned rather
than fixed; on review, three were correctly pinned and one
(`clonedProject`) was cementing a bug.

## Arbitration (orchestrator call)

The review demanded `clonedProject` stop matching owner-blind. The fixer
refused, and was right: `Project` has no remote field, and the clone flow
registers a repo under its **bare basename** — so a strict match would give
every collaborator clone a `clone` button that then 409s. The test engineer
went further and showed the shipped owner-qualified first pass is **cosmetic
for app-created clones** (it only fires for a hand-named `owner/repo` project),
and that the collision survives via the path branch anyway. Recorded as an
**open decision** in the scope doc (add `remote` to `Project`, or place clones
at `<home>/projects/<owner>/<repo>`, or accept), pinned as a `KNOWN LIMIT`
test. Not papered over.

## Found, not caused: a real PTY bug

The gate surfaced a load-dependent loss of a session's final output between
`onData` and `onExit` — see [[pty-exit-data-race]]. Pre-existing, on the app's
most important path, and it needs its own `/dev-flow` + `/verify-terminal`.

## Still true

No live OAuth round-trip has ever run; every connected test uses a **seeded**
token. The device flow and a real `git clone` against a real remote remain
manual-smoke territory.

Related: [[2026-07-24-github-build]], [[github-integration]],
[[localhost-security-model]], [[pty-exit-data-race]], [[agent-team-and-dev-flow]]
