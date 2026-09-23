# How code is written here

Decided 2026-09-23 (user's call, `.claude/plans/PLAN-QUALITY.md` § Q0): the
repo was cleaned up in one day — files split, duplicates folded, dead code
removed — and these rules keep it that way. Every session and every agent
that writes code reads this first. Tests have their own rules:
`tests/README.md`. The architecture and the hard constraints are in
`.claude/PROJECT-SCOPE.md`; those win over anything here.

The rules that can be measured are enforced by the suite
(`tests/repo/file-size.test.ts`, `tests/repo/no-duplicate-code.test.ts`); the
rest is checked in review (`/dev-flow`: the scope-reviewer reads a change
against this file).

## The stack, and what it rules out

- TypeScript run directly by Node 24 (type stripping) on the server and
  bundled by Vite for the browser. **Erasable syntax only**
  (`erasableSyntaxOnly`): no `enum`, no `namespace`, no constructor
  parameter properties. Use a union of string literals and a `const` object.
- `strict` everywhere. No `any` — use `unknown` and narrow it. A cast
  (`as X`) only where a check just proved it, never to silence the compiler.
- Imports name their extension (`./util.ts`), and a type-only import says
  `type`.
- No framework in the browser (decided): plain DOM through the helpers in
  `web/src/ui/util.ts`.
- A new dependency needs the user's word and a security look. The platform
  and the standard library come first.

## Functions first, classes for things with a lifetime

This code base is modular, not object-oriented, on purpose. The default is
a module of plain functions with explicit inputs and outputs. A **class**
is right for something that lives, holds state and is stopped:
`SessionManager`, `AgentsWatcher`, `GithubConnection`, `SessionHistory`,
`RingBuffer`. Private state in a new class is `#private` (a few older
classes still use TypeScript `private`). No inheritance hierarchies — the
one use of `extends` is an error class over `Error` (`GithubError`,
`RestartRefusal`, `ApiError`) so a caller can tell failures apart; share
behaviour by passing functions in.

## Where code goes — module shapes

| Shape | Holds | May import |
| --- | --- | --- |
| `*-model.ts` | pure rules: parse, decide, format, the copy text | other models, `shared/` — no DOM, no app state, no I/O |
| `*-store.ts`, `state*.ts` | app state and its changes, notifications; I/O is passed in, never imported | models, `util.ts`'s `promiseOf` |
| view module (`files.ts`, `panes.ts` …) | DOM, event handlers, wiring | models, stores, `util.ts` |
| `server/api-<family>.ts` | one family of HTTP routes | `server/api-http.ts` plumbing, the domain modules |
| `server/<domain>.ts` | one domain (sessions, git, github, fs …) | `server/config.ts`, other domains |
| `shared/protocol*.ts` | the wire contract: types, limits, shared sentences | nothing |

- A rule a test must reach goes in a model, not in a view — then the test
  calls it instead of reading source text.
- A file stays at **1 000 lines at most** (a test module: 800). Over that,
  split it by topic into `<stem>-<topic>.ts` **in the same folder** (no new
  subfolders — `server/` and `web/src/ui/` stay flat), and keep the original
  as the module importers use, re-exporting what moved.
- Module-level state (`let` at the top of a module) has ONE owner module.
  Others read it through an exported function; never copy a `let` into a
  second module.
- No import cycle that runs code at import time. A cycle between two
  modules that only call each other's functions later is allowed, and its
  header says so.
- Top-level side effects only in entry modules (`server/index.ts`,
  `web/src/main.ts`, `web/src/main-shell.ts`).

## One home per helper

Before writing a helper, look for it. The shared homes:

- `server/config.ts` — data dir, file writes (atomic, 0600), request
  predicates (`isJsonContentType`, `isStringArray`, `isDirectory`),
  `USER_AGENT`.
- `server/sanitise.ts` — cleaning untrusted text for logs and rows
  (`clean`, `plainObject`, `CONTROL_CHAR`).
- `server/fsbrowse.ts` — the path boundary (`isUnder`) and file-system
  listing.
- `web/src/ui/format-model.ts` — pure formatting: `relativeTime` (the one
  "5 minutes ago"), `MONTHS`, uptime and counts.
- `web/src/ui/util.ts` — DOM helpers only (`el`, `button`, `ModalSlot`),
  plus `errorText` and `promiseOf`.
- `web/src/ui/fs-model.ts` `joinPath`, `web/src/ui/slots-model.ts`
  `fileName` (a path's last segment) — path text in the browser.
- `web/src/ui/home-store.ts` — the one cache of the user's home folder.
- `shared/protocol*.ts` — anything the server and the browser must agree on
  (limits, shapes, sentences, and the shared predicates `commandBase`,
  `isClaudeCommand`, `isPort`, `VERSION_SHAPE`, `FULL_HASH`).

The same function body in two source files fails the suite
(`tests/repo/no-duplicate-code.test.ts`). Two helpers that LOOK alike but
answer differently for some input are worse than a duplicate: pick the
correct behaviour, give it one home, and pin the edge case in a test.
`server/statusline.mjs` is the one exception — it runs standalone and
imports nothing from `server/`.

## No dead code

- Export only what another module imports. A test is a legitimate importer
  only for a model's rules — not for a function the app no longer calls.
  One more: a named test seam that replaces a clock or a timer
  (`setClickSwallowClock` in `web/src/ui/dnd.ts`) so a test steps time
  instead of sleeping — say so in its doc comment.
- A function the app no longer calls is deleted with its test, in the
  change that stopped calling it. Not "kept for later": git keeps it.
- No commented-out code, no `TODO` without a backlog item
  (`memory/BACKLOG.md`), no flag that is always on or always off.

## Comments and headers

- Every file opens with a header: what it holds, the plan part it came from,
  and — when it is a piece of a split — its origin and siblings.
- A comment says WHY (a constraint, a decision, a bug it prevents, with its
  note: `memory/decisions/<note>.md`), not WHAT the next line does.
- A comment that stops being true is fixed in the same change. A doc that
  names where code lives (`README.md`, `.claude/PROJECT-SCOPE.md`,
  `web/DESIGN.md`) is updated when the code moves.
- Example paths are `/home/you/...` — never the author's real home
  (`tests/repo/no-author-paths.test.ts`).

## Errors, copy and logging

- The server answers a refusal with the right status and ONE plain sentence
  a user can read (`This file changed on disk since you opened it.`); the
  sentence is a constant, shared through `shared/` when the browser shows
  it.
- No commands, flags or code in the UI (`.claude/PROJECT-SCOPE.md` §
  Features — No commands, flags, or code in the UI).
- Log everything worth knowing, never a secret: tokens, API keys and file
  contents never reach a log line, an error text or argv. Custom command
  text is logged as its shape, not verbatim.
- Validate every input at the boundary (HTTP body, WS frame, file read from
  disk) with a size cap and a type check before it is used.

## The hard constraints

The PTY and resize seam, keyboard capture, the file-system path boundary,
spawning and argument handling, and auth are in `.claude/PROJECT-SCOPE.md` §
Hard technical constraints. A change there gets the full review
(security-auditor, the full mutation probe, `/verify-terminal`) — never a
rewrite "while we are here".

## Before you call it done

1. `npm run typecheck && npm run build` green.
2. `git add -A`, then `npm test` green (the guards read tracked files).
3. The change follows this file; `/dev-flow` for anything nontrivial.
