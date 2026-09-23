---
type: decision
created: 2026-09-21
updated: 2026-09-23
tags: [nocturne, commits, git, github, security]
---
# B3: the Commits tab and the commit view on the real repository

**Status:** decided 2026-09-21 (user: "continue werken aan de app" — B3 was
the next row of the status table). Part B3 of
`.claude/plans/PLAN-NOCTURNE.md`; spec `.claude/plans/nocturne/PLAN-B3.md`.

## 1. The list is the last 10 commits with `Show more` (user)
"laatste 10 commits met show more, met datums en andere dingen en ook door
wie dit gecommit is." Each press loads 10 more; a row carries the subject,
short hash, author, the ABSOLUTE date and the relative time, `+a -d`.
- Offered and not chosen: 50 + Show more; a fixed 100; the whole history
  (the 2 MiB stdout cap would cut it).
- v3 has a fixed list of five and no paging — a recorded user decision
  outranks handoff parity ([[v3-parity-vs-user-decisions]]).

## 2. `Open on GitHub` is github.com only (user)
`origin` on github.com (https, `git@github.com:o/r`, `ssh://git@github.com/o/r`,
the scp form without a user; host compare case-insensitive) → the commit's
page through the ONE sanctioned exit. Any other remote, or none: the button
is ABSENT, not disabled.
- Rejected: GitLab / Bitbucket behind an `Open in browser` label — every host
  has its own commit URL shape; a dead link is worse than no button.
- The server hands out `{ owner, repo }` only; the PAGE builds the URL with a
  literal `github.com` and re-checks both patterns and the 40-hex hash. A
  remote URL holding a token still gives the button; the credential never
  leaves the server, a response or a log line.

## Orchestrator defaults (recorded, not asked; each a cheap flip)
History of `HEAD`, merges against their FIRST parent; renames as delete +
add; header `main, 214 commits` (`Detached, …` on a detached head); author
NAME only, `Committed by` when the committer differs, the message body, no
e-mail and no network avatar; 5 s poll on the Changes tab's rule sharing ONE
interval, same `head` = no-op; paging pinned with `from=<head of page one>`;
first 10 file blocks unfolded, the rest fetch on unfold; 2000 files / 2000
diff lines / 2000 chars per line; `Open file` opens the working-tree file
(B4 owns a missing one).

## Known limits, recorded
- `/api/git/commit-diff` reads the object store of the WHOLE repository — a
  tracked file above a project anchor included, when the repository root lies
  above it. Same reach as B2's "the tab is about the whole repository"; a
  token holder can already spawn a shell. The user was told 2026-09-21.
- `GIT_NO_LAZY_FETCH` is an env variable an old git ignores.
- A file of few enormous lines still ends at the 2 MiB cap with the constant 500.
- `/api/git/changes` still 500s on a broken repo-local `diff.orderFile`
  (nothing executes; B2's argv, left alone).

Why the hardening looks the way it does: [[git-read-calls-run-repo-config]].

## From the scope doc (moved 2026-09-23)

Verbatim wording of the `.claude/PROJECT-SCOPE.md` bullet before part O1 condensed it; the scope doc holds the current rule.

### Features (decided) — The commits routes

- **The commits routes (Nocturne B3, 2026-09-21; spec
  `.claude/plans/nocturne/PLAN-B3.md`, rationale
  `memory/decisions/b3-commits-live.md` and
  `memory/knowledge/git-read-calls-run-repo-config.md`).** Three authed GETs
  beside `/api/git/changes`, same home/project boundary on `root`, in
  `server/git-log.ts` on B2's one git runner: `GET /api/git/commits?root&limit
  (1..50, default 10)&skip&from` (the history of HEAD, newest first, `total`
  from `rev-list --count` — a floor when that times out — `more`, paging
  pinned by `from=<head of page one>`; not a repository = 200 `isRepo:false`;
  an empty one = `branch` + `head:null`), `GET /api/git/commit?root&hash`
  (subject, body ≤ 8 KiB, author NAME, committer name only when it differs,
  both dates, parents, branch, the files with `+a -d` ≤ 2000 then `truncated`,
  and `github: { owner, repo } | null` parsed from `origin` — github.com
  only, https and the ssh/scp spellings, a credential in the URL discarded
  and never in a response or a log line), `GET
  /api/git/commit-diff?root&hash&path` (one file of one commit as numbered
  lines; `binary`; `tooLarge` past 2000 lines, decided from numstat before
  the patch is asked for). Every client string is gated BEFORE argv: `hash` /
  `from` `^[0-9a-f]{40}$` then `rev-parse --verify --quiet <h>^{commit}`
  (400 `The app cannot open that commit.` / 404 `This commit is no longer
  there.`), `limit` / `skip` strict integers, `path` relative without
  `.`/`..`/NUL and only after `--`. Nothing the repository configures may run
  or reshape: `--no-show-signature --no-notes --no-color --no-ext-diff
  --no-textconv --no-renames --diff-merges=first-parent --encoding=UTF-8
  -O/dev/null`, `--no-walk` on the three single-commit calls (a walking `log
  -1 -- <path>` answers with an ANCESTOR's diff — measured), and
  `GIT_NO_LAZY_FETCH=1` in the shared environment — found by the security
  review: a partial-clone config with one missing object made `log`,
  `rev-parse` and B2's shipped `diff` RUN the transport program the repository
  named. Records are `%x01`-led with `%x00` between fields (git cuts `%s` at
  a NUL, so no commit can forge one); subject, names, body and diff text are
  control-stripped and capped, file paths are git's verbatim bytes (they must
  round-trip as a pathspec; the page draws them as text, bidi-isolated). No
  e-mail address anywhere. Logging: one line per request, counts only. The
  page: 10 rows + `Show more` (user decision), three-line rows (subject;
  hash, author, `+a -d`; date + relative time), one 5 s interval shared with
  the Changes tab, the first ten file blocks unfolded and fetched in
  parallel, the rest on unfold, one block repainted per answer, never a pane
  render while the grid is hidden. Known limits, recorded: the object store
  of the WHOLE repository is readable through `commit-diff` (a tracked file
  above a project anchor included — B2's whole-repository reach; a token
  holder can already spawn a shell); a git older than the CVE-2024-32004
  backport ignores `GIT_NO_LAZY_FETCH`; a file of few enormous lines ends at
  the 2 MiB cap with the constant 500; `/api/git/changes` still 500s on a
  broken repo-local `diff.orderFile`.
