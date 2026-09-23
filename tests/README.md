# Tests — how they are laid out and how one is written

Decided 2026-09-23 (user's call, `.claude/plans/PLAN-RESTRUCTURE.md` § O4–O8).
Every agent and every session that adds or changes a test reads this first.
`tests/repo/file-size.test.ts` enforces the measurable rules; the rest is
checked in review (`/dev-flow`, the `test-engineer`).

## Layout

| Folder | Holds |
| --- | --- |
| `tests/ui/` | the browser UI: every `ui-*.test.ts`, plus `nocturne-tokens.test.ts` |
| `tests/server/` | the backend: sessions, API, files, git, GitHub, history, keys, lifecycle, logging, restart, updates, … |
| `tests/release/` | build, bundle, installer, launcher, release script and workflow |
| `tests/repo/` | guards on the repo itself: layout, plans, author paths, file size |
| `tests/helpers/` | shared code, never a test: servers, fake DOM, fixtures, waits |
| `tests/fixtures/` | static input files (JSON, captured bytes) |

A test file is `<topic>.test.ts` in the folder of what it tests; a UI test
keeps the `ui-` prefix. Shared code is a `.ts` module in `tests/helpers/`
without `.test` in its name. Nothing else lives in `tests/` besides this file.

Run: `npm test` (all), `npm run test:ui`, `npm run test:server`, or one file
with `node --test tests/server/fs-rename.test.ts`. Node 24 is required
(`export PATH=$HOME/.nvm/versions/node/v24.14.0/bin:$PATH` in WSL — the
system node is v18 and cannot load `.ts`).

## Size: one file, one topic, at most 800 lines

- **A test file stays at or under 800 lines** (a source file: 1 000). Over
  that, it holds more than one topic — split it by topic, not by line count:
  `restart.test.ts` becomes `restart-<topic>.test.ts` files, each with its
  own header. The guard lists the files that were over the limit when the
  rule came in; that list may only shrink.
- A split keeps every `test(...)` name byte-exact and moves each test whole,
  with the setup it uses. The suite's test count before and after is equal.
- Setup that two or more of the new files need goes to `tests/helpers/`,
  not into a copy per file.

## The header

Every test file opens with a block comment that says, in this order:

1. **What** is under test — the module, route or UI surface, and the plan
   part it came from (`Nocturne B13`, with the spec path when there is one).
2. **How** — real server child, in-process call, fake DOM, source read —
   and why that seam.
3. **Why it matters**, when the answer is not obvious: what goes wrong
   silently if this breaks.
4. **NOT claimed** — what this file cannot prove (browser rendering, a real
   drvfs mount, Windows) and where that is checked instead
   (`.claude/skills/verify-terminal/SKILL.md`, the user's Windows check).

Example paths in comments and fixtures are `/home/you/...`; never the
author's real home, Windows user or handle (`tests/repo/no-author-paths.test.ts`
fails the suite on them).

## A test

- `node:test` and `node:assert/strict` — no other framework.
- **The name is a sentence about behaviour**, readable in the suite output
  without the code: `'an unwritable parent answers 403 with the DELETE
  sentence'`, not `'test delete 3'`. Names are unique in their file.
- One behaviour per test. A table of inputs is fine when every row checks
  the same rule — loop inside one test, and put the case in the assertion
  message so a failure names the row.
- Assert the thing the user or the caller sees: the HTTP status AND the
  sentence, the state on disk AFTER a refusal (nothing changed), the text on
  the row. An assertion on a private variable is a last resort.
- Every assertion that can fail with an unclear diff carries a message.
- A refusal test asserts that nothing happened, not only that an error came
  back.

## Seams — pick the cheapest one that proves the claim

| Claim | Seam | Helper |
| --- | --- | --- |
| a pure rule (parse, map, decide) | import the function, call it | — |
| an HTTP/WS route, a boundary, a log line | a real server child | `startTestServer`, `api`, `rawRequest`, `WsClient`, `waitForLog` in `helpers/helpers.ts` |
| a UI panel's plumbing | the real UI module on the DOM double | `installDom`, `dispatch`, `byClass`, `byKey` in `helpers/fake-dom.ts` |
| a Files panel flow | a fake file-system gateway | `makeFixture`, `settle` in `helpers/fs-fixture.ts` |
| a CSS token or section rule | read the stylesheet | `helpers/tokens-helpers.ts` |
| wiring that only exists in `main.ts` | read the source text | `readSource`, `helpers/source-scan.ts` — last resort: it pins text, not behaviour; say why in a comment |

A server child is a real process boot: start ONE per file in `before`,
stop it in `after`, and give tests their own paths inside it rather than
their own server.

## Time: wait for a condition, never for a clock

- Wait with `waitUntil(fn, 'what')` (polls until `fn` returns something
  other than `undefined`) or `waitForLog(...)` from `helpers/helpers.ts`. A bare `setTimeout` sleep that a test's verdict
  depends on is a flake on the CI runner (slower, UTC, no Windows interop):
  the one exception is proving that something did NOT happen, and then the
  wait is a named constant with a comment on its size.
- Never a local `sleep`/`delay` helper — use `sleep(ms)`, `nextImmediate()`
  or `settleTimers()` from `helpers/helpers.ts`.
- Clocks and dates: pass a fixed `now` (see `helpers/commits-fixture.ts`);
  never depend on the machine's time zone or on the date of the run.

## Isolation and clean-up

- Temp files only in `await makeTempDir('<topic>-')` (`makeTempDirSync` in
  synchronous setup), removed in `after` with `removeTempDir`. Never write
  inside the repo.
- A test never touches the user's real data dir, home or running app.
  `startTestServer` gives each child its own temp data dir
  (`AI_SM_DATA_DIR`); a test on the file system also sets
  `AI_SM_HOME_OVERRIDE` to a fixture home.
- Kill only processes the test started, by PID. Never by name or pattern —
  the user's live app runs the same `node server/index.ts`.
- A test is independent of order and of the other files: `node --test` runs
  files in parallel.
- A test that cannot run as root (permission refusals) skips with a reason:
  `{ skip: SKIP_IF_ROOT }` (`IS_ROOT` for the boolean), both from
  `helpers/helpers.ts`. No other skips, no `.only`, no `.todo` in a commit.

## Shared helpers — look here first

| Need | Helper |
| --- | --- |
| repo root, a source file as text, files under a folder, tracked files | `projectRoot`, `readSource`, `filesUnder`, `trackedFiles` (`helpers.ts`) |
| a program on PATH, a path that exists, git with a fixed identity | `onPath`, `exists`, `git` (`helpers.ts`) |
| a fetch `Response` for the frontend, a history entry | `jsonResponse`, `mkHistoryEntry` (`helpers.ts`) |
| string literals, class names, a function body out of source text | `helpers/source-scan.ts` |
| sessions and projects for the Files panel | `mkSession`, `mkProject` (`fs-fixture.ts`) |
| one element by class, typing into a textarea | `oneByClass`, `typeInto` (`fake-dom.ts`) |

## Mocks

- Prefer a real module on a fake boundary (gateway, DOM double, fixture
  tree) over mocking the module under test.
- `mock.method` / spied `node:fs` is for failures the machine cannot
  produce (EXDEV, a refused `link(2)`); say so in the test's comment, and
  restore in `after`/`finally`.

## Adding or changing tests in a part

- New behaviour gets a test in the same change (`/dev-flow`: the
  `test-engineer` writes or reviews it).
- Before adding a helper, look in `tests/helpers/` — the same function
  written twice is a finding.
- Before adding a file, look for the file of that topic; add to it if it
  stays under 800 lines, otherwise start `<topic>-<subtopic>.test.ts`.
- The suite count only grows. A deleted or weakened test needs the user's
  word, and the commit says so.
