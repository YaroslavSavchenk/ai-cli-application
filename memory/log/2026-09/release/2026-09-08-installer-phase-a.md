---
type: log
created: 2026-09-08
updated: 2026-09-08
tags: [log, installer, bundle, restart, release]
---
# 2026-09-08 — the app becomes a product: phase A (installed mode + bundle build) SHIPPED

**Decision of the day:** the user: "het is tijd om hiervan een app te maken,
met een frontend en backend, zodat andere mensen dit makkelijk kunnen
gebruiken." Four choices asked and answered the same evening → recorded in
[[installer-and-self-contained-bundle]] (self-contained bundle, explicit
opt-in for every third-party install, Inno Setup unsigned per-user, no WSL2 =
explain and stop, repo goes public). An architecture plan (Plan agent) split
the work into phases A–D; the plan for B–D is carried in the orchestrator's
scratch and summarised in the decision note.

## What landed (phase A)

- `server/bundle.ts`: `readBundleInfo` (charset-gated marker, >4 KiB / any
  bad field → null, non-ENOENT read errors reported via a `warn` callback),
  `createInstalledUpdateChecker` (single reason `a new version is installed`
  — only when `<app>/current` resolves to a SIBLING dir with a valid marker
  other than the running one), `resolveInstalledTarget` (containment: direct
  child of `<app>`; valid marker; `server/index.ts`; executable
  `node/bin/node`; built `web/dist`; failures = `REFUSED_STANDBY`).
- `server/index.ts` installed branches: banner `installed build …`, update
  checker, `/api/runtime` `version` + `installed`, runtime.json `appDir`,
  restart deps (verify target instead of vite build; swap/revert/commit
  no-ops; standby spawned from the TARGET's own node + entry).
- `server/restart.ts`: `resolveTarget` option on the standby starter;
  `FrontendBuild.note` so the preflight log line tells the truth in both
  modes ("staged, not served yet" vs "bundled dist, verified in place").
- `scripts/build-bundle.sh`: pinned Node download SHA-verified BEFORE
  extraction, `npm ci --omit=dev` with the bundled node (node-pty compiled
  against the shipped ABI), runtime stripped to `bin/node` + LICENSE, single
  top-level `<version>/` dir, `bundle.json`, smoke test (import node-pty, boot,
  `/api/runtime` says installed), `.sha256` sidecar. `AI_SM_NODE_DIST_BASE`
  allow-listed to `file://` or exactly `https://nodejs.org/dist`.
- `launcher/start-backend.sh`: physical cwd (`cd -P`), bundled node wins.
- Real build here: Node 24.20.0, 58 MB tarball, smoke passed, PTY spawn OK.
- Suite 908 → 964, green ×3 incl. fair CPU starvation (2 nice-19 spinners on
  the suite's two cores: 8× wall, 0 flakes).

## What review caught (2 fix cycles → 1 needed)

- MED `builtAt` only `Date.parse`d and printed raw → V8 accepts newlines in
  parenthesised comments → server.log line forgery from a tampered marker.
  Fix: ISO shape gate + `oneLine`. Lesson: "every field is charset-gated" was
  a comment asserting a guarantee one field lacked.
- MED update checker lit the pill for a half-finished unpack or an
  out-of-tree `current` → permanent "New version available" + 422 on every
  Restart. Fix: same containment + marker check as the target resolver.
- MED `AI_SM_NODE_DIST_BASE` retargeted the sums file too → "verified"
  meant "mirror agrees with itself". Fix: allow-list (precedent: loopback-only
  `AI_SM_GITHUB_API_BASE`).
- MED `readBundleInfo` swallowed EVERY errno as "developer clone" — proven
  with `ulimit -n 64`: an installed backend would boot as a dev clone for its
  whole life, silently. Fix: only ENOENT is silent.
- LOW version regex admitted `.`, `..`, `-h` (→ `rm -rf build/`, tar option
  injection); `--` before the tar member; identical regex both sides.
- Test-engineer killed 3 surviving mutants, incl. a `cd -P` test that was
  vacuous by construction (the stub's own `pwd -P` resolved the symlink for
  it) — replaced by a deterministic mid-launch `current` flip.

## Observations / open

- Test infra: a failed test in `tests/github-token.test.ts` leaves its stub
  listener open → `npm test` hangs forever (`--test-timeout` unset). Backlog.
- Unproven class: `frontend rebuilt` compares an mtime with a later
  non-monotonic `Date.now()`; WSL2 clock steps could false-positive. Watch.
- Frontend not yet updated (phase C): `version`/`installed` fields, the new
  reason sentence, Settings "Check for updates" link.
- `AI_SM_WEB_DIST_DIR` in installed mode serves a dist the restart never
  verifies — test seam only, pinned as observed behaviour.

Next: phase B (launcher config file + Inno Setup installer + helpers), then C
(release workflow, README, UI copy), then D (go-public prep; two user
decisions pending: vault visibility, commit e-mail).
