---
type: log
created: 2026-11-24
updated: 2026-11-24
tags: [github, repos, ui, bug]
---
# 2026-11-24 — a repository created on GitHub now shows up in the app

User: "stel je voor je voegt een nieuwe repo aan github, zie je hem niet in
de app, dit moet je zelf testen door op de knoppen te klikken".

## Cause

The repo list loaded ONCE, when the status first reached connected
(`web/src/ui/github-state.ts` `applyStatus` → `loadRepos('')`); reopening
the From GitHub tab only loaded when `repoState === 'idle'`. The server keeps
no cache (`server/github.ts` `listRepos`). Proven live: a dev instance with
the user's `gh` token pasted, `gh repo create aism-refresh-test --private`,
close + reopen → old build: still 11 rows, 1 `listRepos requested` in the
log; fixed build: 12 rows, the new repo first.

## Fix

- Every time the list becomes visible, and on window focus while it is
  open, it is re-asked in the background (`refreshRepos`): the old rows stay
  (no loading flash), a newer search wins, an identical answer does not
  rebuild, a failed reload keeps the rows. Rules `repoRefreshMode` /
  `sameRepoList` in `github-model.ts`.
- The row's facts line read "Python , Updated …": language and push time are
  now one text span (the flex gap sat before the comma).
- Tests: `tests/ui/ui-github-refresh.test.ts` (13); the fake DOM gained
  `childElementCount`.

## Left

- The test repo `YaroslavSavchenk/aism-refresh-test` (private) still exists:
  the `gh` token lacks `delete_repo`. The user deletes it on github.com or
  after `gh auth refresh -h github.com -s delete_repo`.
- A fine-grained token limited to "only select repositories" never sees a
  repo created later — GitHub's grant, not the app.
