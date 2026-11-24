# Release process

How a version is built, checked and published. The checks it is gated on:
[development.md § Continuous integration](development.md#continuous-integration).

Tagging is the whole release: pushing a `v0.1.1` tag starts
`.github/workflows/release.yml`, which builds four things and publishes them
together:

- `AI-Session-Manager-Setup-<version>.exe` — the Windows Setup, compiled with
  Inno Setup on a Windows runner. This is the app;
- `ai-session-manager-linux-x64.tar.gz` — the self-contained Linux bundle the
  Setup unpacks inside WSL (backend, production dependencies, built frontend,
  pinned Node runtime), built on **ubuntu-22.04** so its glibc floor is 2.35;
- `AiSessionManagerHost-win-x64.zip` — the four files of the native WebView2
  host window, flat, no folder inside, for people running from a clone;
- `SHA256SUMS.txt` — one `sha256sum`-compatible list covering all three plus
  the four files inside the zip, rehashed in the publish job from the files it
  is about to attach.

Five jobs: `verify` (the **full verification suite on the tagged commit** — the
same `.github/workflows/verify.yml` jobs CI runs), `host` and `bundle` in
parallel, `installer` after those two (it needs both binaries), and the publish
job after all four. So a failing test blocks the release: nothing is ever
published from a commit the suite did not pass, and no bundle ships that did
not boot in its own smoke test. The release body leads with the Setup, then the
bundle, then the host zip, and carries the Setup's SHA-256.

The Node runtime the bundle ships is defined once per workflow file, as
`NODE_VERSION`; `tests/release/release-workflow.test.ts` pins that `verify.yml` and
`release.yml` agree on it, that every action is pinned to a commit SHA, and
that nothing is published from anything but a `v*` tag.

The recommended way to tag is:

    npm run release -- v0.1.1
    npm run release -- v0.1.1 --dry-run   # run every check, tag nothing

`scripts/release.sh` refuses to create the tag unless the commit is already
proven: exactly one `vX.Y.Z` argument, `gh` installed and logged in, a clean
working tree on `main`, `HEAD` equal to `origin/main` after a fetch, the tag
unused locally and on origin, and — the point of the whole thing — a **CI run
for exactly this commit that concluded `success`** (no run yet, still running,
or failed all stop it, printing the run's URL). Only then does it
`git tag -a` and `git push origin`. `--dry-run` performs every check and prints
what it would do without tagging or pushing. Tagging by hand
(`git tag v0.1.1 && git push origin v0.1.1`) still works and is gated by the
workflow anyway — the script just moves the failure from five minutes after the
push to before it, so you do not end up with a dead tag.

Running the workflow by hand (`workflow_dispatch`) builds all four artifacts
and uploads them as workflow artifacts without publishing anything — that is
how a Setup gets tested on Windows before a tag exists, and it is the way to
test a change to the workflow itself. Its version is then `0.0.0-dev+<short
sha>`, which nothing can mistake for a release. Dispatched on a `v*` tag it
publishes exactly like a tag push (the publish job's condition is the ref, not
the trigger). Re-running a publish for a tag that already has a release
re-uploads every asset over the old ones and rewrites the release notes, so the
hashes in the body always match the attached files. The version lives only in
the tag; `package.json` has no version field. `scripts/build-bundle.sh` also
runs by hand — `scripts/build-bundle.sh --version v0.1.1 --node 24.20.0` — for
building a bundle locally; the Node version that CI actually ships is the
`NODE_VERSION` pinned in `.github/workflows/verify.yml`, not the one in that
example.
