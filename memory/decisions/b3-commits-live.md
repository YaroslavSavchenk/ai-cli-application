---
type: decision
created: 2026-09-21
updated: 2026-09-21
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
