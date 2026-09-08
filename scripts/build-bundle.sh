#!/usr/bin/env bash
#
# build-bundle.sh -- build the self-contained Linux bundle
# (`ai-session-manager-linux-x64.tar.gz`).
#
#   scripts/build-bundle.sh --version v0.2.0 --node 24.20.0
#   scripts/build-bundle.sh --version 0.0.0-dev+abc1234 --node 24.20.0 --out /tmp/out
#
# What it produces: ONE top-level directory named exactly <version>, holding a
# pinned official Node runtime, the backend, production node_modules (node-pty
# compiled against exactly that runtime's ABI), the built frontend and the
# start script -- so an end user needs no Node, no git and no build tools:
#
#   <version>/bundle.json
#   <version>/node/bin/node          pinned official Node 24 linux-x64
#   <version>/node/LICENSE
#   <version>/package.json           (never package-lock.json: a bundle is not a clone)
#   <version>/node_modules/...       production deps only
#   <version>/server/...             (incl. statusline.mjs)
#   <version>/shared/...
#   <version>/web/dist/...
#   <version>/launcher/start-backend.sh   (0755; prefers ../node/bin/node)
#
# `bundle.json` is what puts the backend in INSTALLED MODE: it is read from the
# app root, and every field is charset-gated on the reading side, so nothing but
# the shapes below may ever be written here.
#
# Where it runs: this WSL Ubuntu 24.04 clone AND GitHub's ubuntu-22.04 runner.
# The release builds on 22.04 ON PURPOSE -- node-pty and the Node runtime then
# link against the older glibc, so the bundle also runs on 22.04, while a bundle
# built on 24.04 would not run on 22.04. `glibcMin` in bundle.json records which
# machine it came off.
#
# Requirements on the build machine: curl, tar (+ xz), sha256sum, and a C/C++
# toolchain + python3 for the node-pty compile (node-pty 1.1.0 ships no
# linux-x64 prebuild). Node itself is NOT required -- the downloaded runtime
# runs `npm ci`, compiles node-pty, and drives the smoke test.
#
# Nothing here is `eval`ed and every path is quoted. The only network access is
# the two nodejs.org downloads, and the tarball is SHA256-verified against the
# official SHASUMS256.txt BEFORE anything is extracted.
#
# AI_SM_NODE_DIST_BASE overrides the download base (default
# https://nodejs.org/dist). It exists as a TEST SEAM -- tests/build-bundle.test.ts
# points it at a `file://` mirror to exercise the checksum refusal without the
# network. It is ALLOW-LISTED: only `file://...` or exactly
# https://nodejs.org/dist are accepted, anything else is refused before any
# download (a foreign HTTPS mirror would only be verified against its own
# SHASUMS256.txt, which proves nothing). Internal mirrors are therefore not
# supported; the checksum check is never relaxed.

set -euo pipefail

# --- helpers ----------------------------------------------------------------

# One-line reason, then out. Every refusal below goes through this.
die() {
  printf '%s\n' "$1" >&2
  exit 1
}

say() {
  printf '%s\n' "$1"
}

usage='usage: scripts/build-bundle.sh --version <vX.Y.Z|0.0.0-dev+sha> --node <24.x.y> [--out <dir>] [--skip-smoke]'

# --- 1. arguments -----------------------------------------------------------

VERSION=''
NODE_VERSION=''
OUT='dist-release'
SKIP_SMOKE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version needs a value. $usage"
      [ -z "$VERSION" ] || die "Give --version once. $usage"
      VERSION="$2"
      shift 2
      ;;
    --node)
      [ "$#" -ge 2 ] || die "--node needs a value. $usage"
      [ -z "$NODE_VERSION" ] || die "Give --node once. $usage"
      NODE_VERSION="$2"
      shift 2
      ;;
    --out)
      [ "$#" -ge 2 ] || die "--out needs a value. $usage"
      OUT="$2"
      shift 2
      ;;
    --skip-smoke)
      SKIP_SMOKE=1
      shift
      ;;
    -h | --help)
      say "$usage"
      exit 0
      ;;
    *)
      die "Unknown argument \"$1\". $usage"
      ;;
  esac
done

[ -n "$VERSION" ] || die "Missing --version. $usage"
# Exactly the shape the backend accepts when it reads bundle.json (VERSION_SHAPE
# in server/bundle.ts): anything else would build a bundle that refuses to enter
# installed mode. It must start with a digit or `v<digit>`, which is what a
# version looks like AND what keeps `.`, `..` and a leading `-` out: this string
# is a directory name under build/bundle (`rm -rf "$STAGE"` would wipe build/
# itself for `..`) and a tar member argument.
if ! [[ "$VERSION" =~ ^v?[0-9][A-Za-z0-9._+-]{0,63}$ ]]; then
  die "\"$VERSION\" is not a usable bundle version: it must start with a digit or v<digit>, then letters, digits, . _ + - only, up to 64 more characters (e.g. v0.2.0 or 0.0.0-dev+abc1234)."
fi

[ -n "$NODE_VERSION" ] || die "Missing --node (the exact Node runtime to bundle, e.g. --node 24.20.0). $usage"
if ! [[ "$NODE_VERSION" =~ ^24\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
  die "\"$NODE_VERSION\" is not an exact Node 24 version. Give the full three-part version, e.g. --node 24.20.0."
fi

REPO="$(cd -P "$(dirname "$0")/.." >/dev/null 2>&1 && pwd -P)" ||
  die 'Could not find the repository root from this script.'

# A relative --out is relative to the repo, not to wherever this was invoked
# from, so the default `dist-release` means the same thing everywhere.
case "$OUT" in
  /*) OUT_DIR="$OUT" ;;
  *) OUT_DIR="$REPO/$OUT" ;;
esac

# --- 2. preflight: tools, the frontend build, glibc -------------------------
#
# Everything that can be known before a byte is downloaded is checked here, so a
# missing frontend build or a missing tool costs no network and no compile.

for tool in curl tar sha256sum xz; do
  command -v "$tool" >/dev/null 2>&1 ||
    die "\"$tool\" is not installed, and the bundle cannot be built without it."
done

DIST="$REPO/web/dist"
for needed in index.html build-id.json; do
  [ -f "$DIST/$needed" ] ||
    die "The frontend build is missing ($DIST/$needed) -- run npm run build first."
done

[ -f "$REPO/package.json" ] || die "No package.json at $REPO."
[ -f "$REPO/package-lock.json" ] || die "No package-lock.json at $REPO -- the bundle installs from the lockfile."
[ -f "$REPO/server/index.ts" ] || die "No server/index.ts at $REPO."
[ -f "$REPO/server/statusline.mjs" ] || die "No server/statusline.mjs at $REPO."
[ -f "$REPO/launcher/start-backend.sh" ] || die "No launcher/start-backend.sh at $REPO."

# glibcMin: the build machine's glibc, i.e. the OLDEST glibc this bundle can
# run on. `ldd --version` line 1 ends with the version on every glibc build
# ("ldd (Ubuntu GLIBC 2.35-0ubuntu3.11) 2.35").
GLIBC_LINE="$(ldd --version 2>/dev/null | head -n 1 || true)"
GLIBC_MIN="$(printf '%s' "$GLIBC_LINE" | grep -oE '[0-9]{1,2}\.[0-9]{1,3}$' || true)"
[ -n "$GLIBC_MIN" ] ||
  die "Could not read the build machine's glibc version. \`ldd --version\` said: ${GLIBC_LINE:-nothing}"

# --- 3. the Node runtime: download, then verify BEFORE extracting -----------

# AI_SM_NODE_DIST_BASE retargets BOTH the tarball and SHASUMS256.txt, so a
# remote override does not weaken the checksum gate -- it REPLACES it with "the
# mirror agrees with itself", while the release note claims verification against
# nodejs.org. So it is allow-listed, in the spirit of the loopback-only
# AI_SM_GITHUB_API_BASE: a local `file://` directory (the offline test seam) or
# nodejs.org itself, nothing else, refused before a byte is fetched.
BASE="${AI_SM_NODE_DIST_BASE:-https://nodejs.org/dist}"
BASE="${BASE%/}"
BASE_IS_LOCAL=0
case "$BASE" in
  file://*) BASE_IS_LOCAL=1 ;;
  https://nodejs.org/dist) ;;
  *)
    die "AI_SM_NODE_DIST_BASE=\"$BASE\" is refused: the Node runtime is downloaded from https://nodejs.org/dist, or from a file:// directory for offline tests. Any other base would only verify the mirror against its own SHASUMS256.txt."
    ;;
esac

CACHE="$REPO/build/node-cache/v$NODE_VERSION"
TARBALL_NAME="node-v$NODE_VERSION-linux-x64.tar.xz"
TARBALL="$CACHE/$TARBALL_NAME"
SUMS="$CACHE/SHASUMS256.txt"

mkdir -p "$CACHE"

fetch() {
  # $1 url, $2 destination. Downloads to a .part file so an interrupted
  # download can never be mistaken for a cached one.
  curl -fsSL --retry 3 --retry-delay 2 --max-time 900 -o "$2.part" "$1" ||
    die "Download failed: $1"
  mv -f "$2.part" "$2"
}

if [ -f "$TARBALL" ]; then
  say "Node $NODE_VERSION: using the cached download ($TARBALL)."
else
  say "Node $NODE_VERSION: downloading $BASE/v$NODE_VERSION/$TARBALL_NAME"
  fetch "$BASE/v$NODE_VERSION/$TARBALL_NAME" "$TARBALL"
fi
# Always re-fetched, never cached: it is the thing the tarball is judged by.
fetch "$BASE/v$NODE_VERSION/SHASUMS256.txt" "$SUMS"

# --ignore-missing: SHASUMS256.txt lists every platform's artifact and we have
# one. It still fails when NO listed file was verified, so an empty or wrong
# sums file cannot pass.
if ! (cd "$CACHE" && sha256sum --ignore-missing -c SHASUMS256.txt >/dev/null 2>&1); then
  rm -f "$TARBALL"
  die "Checksum mismatch: $TARBALL_NAME does not match SHASUMS256.txt from $BASE. The download was deleted; nothing was extracted."
fi
say "Node $NODE_VERSION: SHA-256 verified against SHASUMS256.txt."

# --- 4. staging -------------------------------------------------------------

STAGE_ROOT="$REPO/build/bundle"
STAGE="$STAGE_ROOT/$VERSION"
rm -rf "$STAGE"
mkdir -p "$STAGE/node"

tar -xJf "$TARBALL" -C "$STAGE/node" --strip-components=1 ||
  die "Could not extract $TARBALL_NAME."

STAGED_NODE="$STAGE/node/bin/node"
[ -x "$STAGED_NODE" ] || die "The extracted runtime has no bin/node."

REPORTED="$("$STAGED_NODE" -v)" || die "The extracted runtime does not run on this machine."
[ "$REPORTED" = "v$NODE_VERSION" ] ||
  die "The extracted runtime reports $REPORTED, not v$NODE_VERSION."

# --- 5. production dependencies, compiled against the bundled runtime -------
#
# `npm ci` runs INSIDE the staging dir with the bundled node first on PATH, so
# node-gyp builds node-pty against exactly the ABI that will ship. Lifecycle
# scripts are explicitly enabled -- node-pty 1.1.0 has no linux-x64 prebuild, so
# skipping them would ship a package with no binding at all.

cp "$REPO/package.json" "$STAGE/package.json"
cp "$REPO/package-lock.json" "$STAGE/package-lock.json"

say "Installing production dependencies (node-pty compiles here, ~30 s)..."
(
  cd "$STAGE"
  PATH="$STAGE/node/bin:$PATH" npm ci --omit=dev --ignore-scripts=false
) || die "npm ci failed in the staging directory."

# A bundle is not a clone: it has no lockfile, which is also how the backend's
# "dependencies changed" check knows to stay quiet in installed mode.
rm -f "$STAGE/package-lock.json"

# --- 6. strip the runtime ---------------------------------------------------
#
# Keep the binary and its license; everything else in the dist is a development
# tool an installed app never uses (npm alone is ~30 MB).

rm -rf \
  "$STAGE/node/lib/node_modules" \
  "$STAGE/node/include" \
  "$STAGE/node/share"
rm -f "$STAGE"/node/bin/npm* "$STAGE"/node/bin/npx* "$STAGE/node/bin/corepack"
rm -f "$STAGE/node/CHANGELOG.md" "$STAGE/node/README.md"

[ -x "$STAGED_NODE" ] || die "Stripping removed node/bin/node."
[ -f "$STAGE/node/LICENSE" ] || die "The Node runtime's LICENSE is missing from the bundle."

# --- 7. the app itself ------------------------------------------------------

cp -R "$REPO/server" "$STAGE/server"
cp -R "$REPO/shared" "$STAGE/shared"
mkdir -p "$STAGE/web"
cp -R "$DIST" "$STAGE/web/dist"
mkdir -p "$STAGE/launcher"
cp "$REPO/launcher/start-backend.sh" "$STAGE/launcher/start-backend.sh"
chmod 0755 "$STAGE/launcher/start-backend.sh"

[ -f "$STAGE/server/statusline.mjs" ] || die "server/statusline.mjs did not make it into the bundle."
[ -f "$STAGE/web/dist/index.html" ] || die "web/dist/index.html did not make it into the bundle."
[ -f "$STAGE/web/dist/build-id.json" ] || die "web/dist/build-id.json did not make it into the bundle."

# --- 8. bundle.json ---------------------------------------------------------
#
# Every value below is either a literal or has passed a charset check, so the
# JSON needs no escaping. The backend re-validates all of it anyway.

COMMIT="$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || true)"
if [[ "$COMMIT" =~ ^[0-9a-f]{7,40}$ ]]; then
  COMMIT_JSON="\"$COMMIT\""
else
  COMMIT="(none)"
  COMMIT_JSON='null'
fi
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cat >"$STAGE/bundle.json" <<EOF
{
  "version": "$VERSION",
  "commit": $COMMIT_JSON,
  "nodeVersion": "v$NODE_VERSION",
  "builtAt": "$BUILT_AT",
  "platform": "linux-x64",
  "glibcMin": "$GLIBC_MIN"
}
EOF

# --- 9. smoke test: the acceptance gate -------------------------------------
#
# A bundle that packages cleanly and cannot boot is worse than no bundle, so the
# build does not finish until the bundled runtime has imported the compiled
# node-pty binding and the bundled backend has come up, answered, and shut down
# cleanly -- using ONLY files from the staging directory and a throwaway data
# dir. Nothing here touches ~/.ai-session-manager.

SMOKE_TMP=''
cleanup() {
  if [ -n "$SMOKE_TMP" ] && [ -d "$SMOKE_TMP" ]; then
    rm -rf "$SMOKE_TMP"
  fi
}
trap cleanup EXIT

smoke_test() {
  SMOKE_TMP="$(mktemp -d)"
  local data="$SMOKE_TMP/data"
  local out="$SMOKE_TMP/server.out"

  say 'Smoke test: importing node-pty with the bundled runtime...'
  (cd "$STAGE" && "$STAGED_NODE" --input-type=module -e 'await import("node-pty");') ||
    die "The bundled node-pty does not import under the bundled runtime (v$NODE_VERSION). The bundle is not usable."

  say 'Smoke test: booting the bundled backend...'
  (
    cd "$STAGE"
    exec env AI_SM_DATA_DIR="$data" "$STAGED_NODE" server/index.ts
  ) >"$out" 2>&1 &
  local pid=$!

  local runtime="$data/runtime.json"
  local i
  for i in $(seq 1 300); do
    [ -f "$runtime" ] && break
    if ! kill -0 "$pid" 2>/dev/null; then
      say "--- server output ---"
      cat "$out" >&2 || true
      die "The bundled backend exited before it published runtime.json."
    fi
    sleep 0.2
  done
  [ -f "$runtime" ] || {
    kill -TERM "$pid" 2>/dev/null || true
    die "The bundled backend never published runtime.json (60 s)."
  }

  # The probe runs on the bundled runtime too (no jq, no system node): it reads
  # the port + token from runtime.json, checks /health and /api/runtime, and
  # prints one line. The token never reaches this script or the console.
  cat >"$SMOKE_TMP/probe.mjs" <<'PROBE'
import { readFile } from 'node:fs/promises';

const [runtimeFile, expectedVersion] = process.argv.slice(2);
const rt = JSON.parse(await readFile(runtimeFile, 'utf8'));
const base = `http://127.0.0.1:${rt.port}`;

const health = await fetch(`${base}/health`);
if (health.status !== 200) throw new Error(`/health answered ${health.status}`);
const healthBody = await health.json();
if (healthBody?.ok !== true) throw new Error(`/health said ${JSON.stringify(healthBody)}`);

const res = await fetch(`${base}/api/runtime`, {
  headers: { 'x-auth-token': rt.token },
  redirect: 'error',
});
if (res.status !== 200) throw new Error(`/api/runtime answered ${res.status}`);
const body = await res.json();

// The bundle marker is the whole point: a bundle whose bundle.json the backend
// refuses (one bad field means the marker is ignored WHOLESALE) boots, serves,
// and behaves like a developer clone -- rebuilding the frontend on restart,
// reporting "dependencies changed", never seeing a newer `current`. That is a
// silent wrong answer, so it is checked here rather than discovered in the
// field.
if (body.installed !== true) {
  throw new Error(`/api/runtime says installed=${JSON.stringify(body.installed)}`);
}
if (body.version !== expectedVersion) {
  throw new Error(
    `/api/runtime says version=${JSON.stringify(body.version)}, expected ${JSON.stringify(expectedVersion)}`,
  );
}
console.log(`installed mode confirmed: version ${body.version}`);
PROBE

  if ! "$STAGED_NODE" "$SMOKE_TMP/probe.mjs" "$runtime" "$VERSION"; then
    kill -TERM "$pid" 2>/dev/null || true
    say '--- server log ---'
    tail -n 40 "$data/server.log" >&2 2>/dev/null || true
    die 'The bundled backend did not answer as expected (see above).'
  fi

  say 'Smoke test: shutting the bundled backend down...'
  kill -TERM "$pid" 2>/dev/null || true
  for i in $(seq 1 150); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -KILL "$pid" 2>/dev/null || true
    die 'The bundled backend did not exit on SIGTERM (30 s).'
  fi
  [ ! -e "$runtime" ] ||
    die 'The bundled backend left runtime.json behind after SIGTERM.'

  say 'Smoke test: passed.'
}

if [ "$SKIP_SMOKE" = '1' ]; then
  say 'Smoke test: SKIPPED (--skip-smoke).'
else
  smoke_test
fi

# --- 10. the tarball --------------------------------------------------------

mkdir -p "$OUT_DIR"
ARCHIVE="$OUT_DIR/ai-session-manager-linux-x64.tar.gz"
rm -f "$ARCHIVE" "$ARCHIVE.sha256"

# --sort/--mtime/--owner/--group/--numeric-owner: member order, timestamps and
# ownership are fixed, so a diff between two bundles is a diff of their files
# and not of when or by whom they were packed. (NOT bit-for-bit reproducible:
# the node-pty compile and npm's own bookkeeping differ between runs -- measured
# 2026-09-08, two builds of the same commit produced different tars.)
# -C <staging root> <version>: exactly one top-level directory, named for the
# version -- the installer unpacks into <app>/<version>/ and moves `current`
# onto it.
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner \
  -czf "$ARCHIVE" -C "$STAGE_ROOT" -- "$VERSION" ||
  die "Could not pack $ARCHIVE."

(cd "$OUT_DIR" && sha256sum 'ai-session-manager-linux-x64.tar.gz' >'ai-session-manager-linux-x64.tar.gz.sha256') ||
  die "Could not write the checksum file."

SIZE="$(du -h "$ARCHIVE" | cut -f1)"
SHA="$(cut -d' ' -f1 <"$ARCHIVE.sha256")"

say ''
say "Bundle:    $ARCHIVE"
say "Version:   $VERSION (commit $COMMIT)"
say "Node:      v$NODE_VERSION"
if [ "$BASE_IS_LOCAL" = '1' ]; then
  say "Node from: $BASE (a local mirror, NOT nodejs.org)"
fi
say "glibcMin:  $GLIBC_MIN (built on this machine's glibc)"
if [ "$SKIP_SMOKE" = '1' ]; then
  say 'Smoke test: SKIPPED (--skip-smoke) -- this bundle was never booted.'
fi
say "Size:      $SIZE"
say "SHA-256:   $SHA"
