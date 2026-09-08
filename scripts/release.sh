#!/usr/bin/env bash
#
# Tag a release -- but only a commit that CI has already proven green.
#
#   npm run release -- v0.1.1
#   npm run release -- v0.1.1 --dry-run
#
# Pushing a `v*` tag is what publishes a GitHub Release
# (.github/workflows/release.yml). That workflow runs the whole verification
# suite itself and will not publish if it fails -- but finding that out five
# minutes after tagging means a dead tag and a red release run. This script
# refuses to create the tag in the first place unless the CI workflow already
# concluded `success` for exactly this commit.
#
# It only ever reads: the single mutating pair (`git tag`, `git push origin
# <tag>`) is the last thing it does, and `--dry-run` skips even that. No `gh`
# command here changes anything on GitHub.
#
# Every external tool is called by plain name (`git`, `gh`, `node`), so tests
# can put doubles in front of them on PATH. Nothing else is shelled out to:
# bash builtins do the rest.

set -euo pipefail

# --- helpers ----------------------------------------------------------------

# One-line reason, then out. Every refusal below goes through this.
die() {
  printf '%s\n' "$1" >&2
  exit 1
}

usage='usage: npm run release -- vX.Y.Z [--dry-run]'

# --- 1. arguments -----------------------------------------------------------

TAG=''
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h | --help)
      printf '%s\n' "$usage"
      exit 0
      ;;
    -*)
      die "Unknown option \"$arg\". $usage"
      ;;
    *)
      if [ -n "$TAG" ]; then
        die "Give exactly one version tag. $usage"
      fi
      TAG="$arg"
      ;;
  esac
done

if [ -z "$TAG" ]; then
  die "Missing the version tag. $usage"
fi

if ! [[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  die "\"$TAG\" is not a version tag. It must look like v1.2.3."
fi

# --- 2. the gh CLI ----------------------------------------------------------

if ! command -v gh >/dev/null 2>&1; then
  die 'The GitHub CLI (gh) is not installed, so the CI result cannot be checked.'
fi

if ! gh auth status >/dev/null 2>&1; then
  die 'The GitHub CLI is not logged in. Run: gh auth login'
fi

# --- 3. a clean tree, on main -----------------------------------------------

if ! git rev-parse --git-dir >/dev/null 2>&1; then
  die 'This is not a git repository. Run this from your clone of the project.'
fi

# Read first, test second: a command substitution that FAILS inside `[ ]` is
# indistinguishable from one that printed nothing, and `set -e` does not see it
# either -- so a broken read would read as "the check passed".
if ! TREE_STATUS="$(git status --porcelain)"; then
  die 'Could not check for uncommitted changes (git status failed).'
fi
if [ -n "$TREE_STATUS" ]; then
  die 'There are uncommitted changes. Commit or stash them first.'
fi

if ! BRANCH="$(git rev-parse --abbrev-ref HEAD)"; then
  die 'Could not work out which branch you are on.'
fi
if [ "$BRANCH" != 'main' ]; then
  die "Releases are tagged on main, and you are on \"$BRANCH\"."
fi

# --- 4. in sync with origin/main --------------------------------------------

if ! git fetch origin >/dev/null 2>&1; then
  die 'Could not reach origin (git fetch failed).'
fi

if ! SHA="$(git rev-parse HEAD)"; then
  die 'Could not read the current commit.'
fi
if ! ORIGIN_SHA="$(git rev-parse origin/main)"; then
  die 'There is no origin/main to compare against.'
fi
if [ "$SHA" != "$ORIGIN_SHA" ]; then
  die "Your main is not the same commit as origin/main ($SHA vs $ORIGIN_SHA). Push or pull first."
fi

# --- 5. the tag must be new -------------------------------------------------

if ! LOCAL_TAG="$(git tag --list "$TAG")"; then
  die 'Could not read the local tags (git tag --list failed).'
fi
if [ -n "$LOCAL_TAG" ]; then
  die "The tag $TAG already exists locally."
fi

if ! REMOTE_TAG="$(git ls-remote --tags origin "refs/tags/$TAG")"; then
  die 'Could not ask origin whether the tag exists (git ls-remote failed).'
fi
if [ -n "$REMOTE_TAG" ]; then
  die "The tag $TAG already exists on origin."
fi

# --- 6. CI must have passed on exactly this commit --------------------------

# --branch main as well as --commit: a pull_request run and the push-to-main run
# can share a head SHA, and only the branch run is the one this tag rides on.
if ! RUNS="$(gh run list --workflow CI --commit "$SHA" --branch main --json status,conclusion,databaseId,url --limit 5)"; then
  die "Could not ask GitHub for the CI status of commit $SHA."
fi

# gh lists newest first; the first entry is the run that counts. Parsed with
# node (already required to run this project) so the script needs no jq.
SUMMARY="$(
  printf '%s' "$RUNS" | node -e '
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { raw += d; });
    process.stdin.on("end", () => {
      let runs;
      try {
        runs = JSON.parse(raw);
      } catch {
        process.stdout.write("BAD-JSON");
        return;
      }
      // Valid JSON that is not a list of runs ({}, null, a string) is an
      // answer we cannot read -- NOT the same thing as "no run exists yet",
      // whose only honest shape is an empty array.
      if (!Array.isArray(runs)) {
        process.stdout.write("BAD-JSON");
        return;
      }
      if (runs.length === 0) {
        process.stdout.write("NONE");
        return;
      }
      const r = runs[0] ?? {};
      const url = r.url ? String(r.url) : "";
      // Unit separator, not a tab: bash treats runs of IFS WHITESPACE as one
      // delimiter, which would swallow an empty conclusion field below.
      process.stdout.write(
        ["RUN", String(r.status ?? ""), String(r.conclusion ?? ""), url].join(
          "\u001f",
        ),
      );
    });
  '
)"

if [ "$SUMMARY" = 'BAD-JSON' ]; then
  die 'Could not read the CI status from the GitHub CLI (unexpected output).'
fi

if [ "$SUMMARY" = 'NONE' ]; then
  die "No CI run exists for commit $SHA. Push the commit and wait for CI to finish, then try again."
fi

IFS=$'\037' read -r _kind RUN_STATUS RUN_CONCLUSION RUN_URL <<EOF
$SUMMARY
EOF

if [ "$RUN_STATUS" != 'completed' ]; then
  die "CI is still running for commit $SHA. Wait for it to finish, then try again: $RUN_URL"
fi

if [ "$RUN_CONCLUSION" != 'success' ]; then
  die "CI did not pass for commit $SHA (result: ${RUN_CONCLUSION:-unknown}): $RUN_URL"
fi

# --- 7. tag and push --------------------------------------------------------

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
if [ -n "$REPO" ]; then
  RELEASE_RUNS_URL="https://github.com/$REPO/actions/workflows/release.yml"
else
  RELEASE_RUNS_URL='the Actions tab of this repository'
fi

if [ "$DRY_RUN" = '1' ]; then
  printf '%s\n' "Dry run: every check passed for $SHA (CI: $RUN_URL)."
  printf '%s\n' "Would run: git tag -a $TAG -m $TAG"
  printf '%s\n' "Would run: git push origin refs/tags/$TAG"
  printf '%s\n' "Would then watch: $RELEASE_RUNS_URL"
  exit 0
fi

git tag -a "$TAG" -m "$TAG"
# refs/tags/ and not a bare "$TAG": with a local BRANCH of the same name git
# refuses ("matches more than one") and pushes nothing, leaving the tag local.
git push origin "refs/tags/$TAG"

printf '%s\n' "Tagged $SHA as $TAG and pushed it."
printf '%s\n' "The release workflow is starting: $RELEASE_RUNS_URL"
