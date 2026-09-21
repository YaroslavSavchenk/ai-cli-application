---
type: knowledge
created: 2026-09-21
updated: 2026-09-21
tags: [git, security, backend, spawning, testing]
---
# "Read-only" git calls run programs the REPOSITORY names — and `log -1 -- <path>` answers for another commit

Found in Nocturne B3 (2026-09-21), all measured on git 2.43.0 with marker
files. Context: the backend runs `git log` / `git diff` / `git rev-parse` in
folders the user merely OPENED (an unpacked archive can carry its own
`.git/config`). B2's lesson was `core.fsmonitor`; these are the rest.

## What executes on a plain read

| Repo-local config | Runs on | Stopped by |
| --- | --- | --- |
| `extensions.partialClone` + `remote.<n>.promisor` + `remote.<n>.uploadpack=<prog>` (or an `ssh://` url + `core.sshCommand`) and ONE missing object | `log --numstat`, `diff --numstat`, even `rev-parse --verify <absent hash>^{commit}` — git starts a LAZY FETCH | env `GIT_NO_LAZY_FETCH=1` (no argv form; a git older than the CVE-2024-32004 backport ignores it) |
| `log.showSignature=true` + `gpg.program=<prog>` | `git log` on a commit that HAS a `gpgsig` header | `--no-show-signature` |
| `.gitattributes diff=x` + `diff.x.textconv=<prog>` | any patch output (`log -p`, `show`); not `--numstat` | `--no-textconv` |
| `diff.external` / `GIT_EXTERNAL_DIFF` | bare `git diff`; NOT `log -p` / `show` (they default to no-ext-diff) | `--no-ext-diff` anyway |
| `core.fsmonitor=<prog>` | `status`, `diff` | `GIT_CONFIG_*` env pin (B2) |

Inert without a tty: `core.pager`, `pager.log`. The reviewer who found the
promisor route was the security-auditor, by asking "what did the developer's
measured list MISS" — put that question in every such brief.

`GIT_TERMINAL_PROMPT=0` and `stdio: ignore` stop none of these.

## Output shaping that breaks a parser

- `i18n.logOutputEncoding=ISO-8859-1` re-encodes `%s` into invalid UTF-8 →
  pin `--encoding=UTF-8`.
- `diff.orderFile=<missing>` → exit 128 → pin `-O/dev/null` (order unchanged).
- `diff.noprefix` / `diff.mnemonicPrefix` rewrite `a/` `b/` → parse from the
  first `@@`, never from the header.
- **The git VERSION shapes output too**: a newer git prints a UTC `%aI` / `%cI`
  as `…T21:45:00Z`, git 2.43 prints `+00:00`. A strict regex that knew one
  spelling kept CI red for three pushes with a green local suite — when a
  test asserts the SHAPE of a tool's output, think of the runner's version.
- `core.abbrev` decides `%h` (1–40 chars). `diff.context` → `--unified=3`.
- Locale → `LC_ALL=C`. Pathspec magic (`:(glob)*`) → `GIT_LITERAL_PATHSPECS=1`.
- `log.mailmap` only touches `%aN` / `%cN`; `%an` / `%cn` never read a file.
- git truncates `%s` / `%b` at a NUL, so `%x00` between fields and `%x01` at
  the record start cannot be forged by a commit message (a `\x01` inside a
  subject CAN appear — never `split('\x01')`, parse positionally).

## Two semantics traps

- **`git log -1 <hash> -- <path>` does history simplification.** When `<hash>`
  did not touch `<path>` it walks to the nearest ANCESTOR that did and prints
  that commit's numstat / patch — under the hash you asked for. `--no-walk`
  fixes it (still correct for a root commit and for a merge with
  `--diff-merges=first-parent`). Never on a LIST call: it collapses the page
  to one commit. The first test for this was vacuous (asked the ROOT commit,
  which has no ancestor) — use a later commit and a path only an ancestor
  touched.
- **`git show` implies `-p`**: `show --numstat -z` prints numstat AND the
  whole patch. Default `log --numstat` on a MERGE prints nothing; with
  `--diff-merges=first-parent` it prints the merge against its first parent.

## Proving "not executed" without fooling yourself

Every marker-file test needs the NON-VACUITY half: plain git on the same
fixture DOES create the marker, asserted, then removed. The first gpg proof
was vacuous because fixture commits were unsigned — write the commit object
by hand (`git hash-object -t commit -w --stdin` with a `gpgsig` header). A
date fixture `+9900` still formats as ISO (`+99:00`); `notanumber` makes `%aI`
print the literal `%aI`.

Related: [[localhost-security-model]], [[path-normalization-delete-primitive]].
