---
type: knowledge
created: 2026-07-25
updated: 2026-07-25
tags: [security, paths, filesystem, cleanup, gotcha]
---
# A cleanup that "removes only what we created" breaks on un-normalized paths

Found 2026-07-25 by the security auditor, on code written the same day (the
owner-qualified clone paths). Reproduced end-to-end against a real server, then
found a second, **pre-existing** instance of the identical shape on a route
nobody had touched.

## The shape

Three ingredients, each individually reasonable:

1. A destination path accepted with `isAbsolute()` only — no `resolve()`, no
   containment check. `..` survives into the string.
2. Code that **creates** a directory along that path (`mkdirSync`), then
   records "did it exist before?" by `statSync`-ing the raw string **before**
   the creation.
3. Failure cleanup that removes the destination `rmSync(dest, {recursive:
   true})` when the "existed before" flag is false.

With `dest = <X>/<owner>/..` where `<X>/<owner>` does not yet exist:
`statSync` throws ENOENT → "did not exist" → we create `<X>/<owner>` → the
operation fails → `rmSync` runs on `<X>/<owner>/..`, which **the kernel
resolves through the `..`**, and every entry inside the pre-existing `<X>` is
deleted. The final `rmdir` on the `..`-terminated path fails, which is the only
reason `<X>` itself survives — as an empty shell.

## Why it is easy to miss

`path.resolve()` is **lexical**; the kernel is not. The bug lives exactly in
that gap: `statSync` was asked about a string that *lexically* names a missing
directory while *kernel-wise* naming an existing one. Reviewing either half
alone looks correct. And the guard that would have caught it — "the parent must
already exist" — was **removed on purpose** to make the owner directory
creatable. Removing a precondition is what opened the window; the new code
looked strictly narrower.

## The fix, and the deliberate asymmetry

Two shapes, both correct, chosen per route:

- `/api/github/clone` **rejects** a non-normalized dest (`resolve(dest) !==
  dest` → 400). The app is the only caller and always builds a clean path.
- `/api/projects` (create) and `/api/projects/clone` **normalize** instead:
  `resolve()` once, then every consumer — `statSync`, the vacancy check,
  `mkdirSync`, the `git` cwd/argv, the cleanup, and the path stored in
  `projects.json` — reads that one resolved value. Rejecting would have broken
  existing callers and stored data.

The asymmetry is documented at both sites so it reads as a choice, not a
mistake.

## Lessons

**One normalization is worth nothing if one consumer still reads the raw
string.** The test gate proved this: the first regression test used a
*non-empty* victim directory, so the vacancy check 409'd and shadowed
everything after it — 4 of 6 consumers were mutation-undetectable. Driving the
test through an *empty* landing directory (where lexical and kernel resolution
genuinely disagree) is what made each consumer pinnable. **Ask of every guard
test: does an earlier guard shadow the one I am trying to pin?**

**`isAbsolute` must stay BEFORE `resolve`.** `resolve('x')` silently anchors to
`process.cwd()` — normalizing first would turn a rejected relative path into a
write inside the server's working directory.

**Fail-safe is not the same as correct.** After the fix, `<base>/link/..`
(symlink then `..`) still denotes a *different* directory to us than to a
shell, because `resolve()` does not follow links. It is safe — deletion stays
gated on the same resolved path — but it silently reinterprets a path a user
typed. Worth knowing before someone reports it as a bug.

**Severity, honestly.** This was never an authentication bypass: a caller
holding the app token can already spawn arbitrary commands by design, and
GitHub rejects `..` as a repo name so the genuine API could not trigger it.
What made it worth fixing before landing is that it was a *new, irreversible
data-destruction primitive* resting on an invariant the code did not implement
— the same class as [[pty-exit-data-race]]'s comment asserting a guarantee the
code lacked.

Related: [[owner-qualified-clone-paths]], [[localhost-security-model]],
[[github-integration]], [[2026-07-25-ui-copy-and-clone-paths]]
