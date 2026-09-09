---
type: knowledge
created: 2026-09-10
updated: 2026-09-10
tags: [update, cache, etag, incident, testing]
---
# An ETag validates the payload, never a verdict derived from it

**Incident (2026-09-09 night → 2026-09-10).** The in-app updater's
release check ([[in-app-update]]) cached `{ etag, release }` in
`<dataDir>/update-check.json`, where `release` was the *verdict*: the
offer, or `null` when the latest release was not newer than the running
version. The ETag is GitHub's validator for the `releases/latest`
*payload*; the verdict additionally depends on `bundle.json.version`.
The user installed v0.3.1 first (verdict `null`), then v0.3.0 by hand to
test the Update button. The v0.3.0 backend adopted the cache, sent
`If-None-Match`, got `304`, and re-used "no offer" — every 6 h, forever.
No Update button, nothing in the log above debug.

Reading the cache already re-judged a cached *offer* against the current
version (drop it when not newer) but trusted a cached *null*
unconditionally. Asymmetric gates on the same field are the tell.

**Rule.** Cache only what the validator covers — the *descriptor* of the
latest release — and derive every version-relative decision at use time
(`offer()` = `latest` newer than `currentVersion`). When the on-disk
shape changes, rename the field so the old file fails the read (one
unconditional 200 is the whole cost). Fixed in commit `1cdb766`
(dev-flow, 2 cycles, mutants 8/8 killed, suite 1160 → 1165).

**Same shape elsewhere.** The retention tests in
`tests/installer-helpers.test.ts` assumed a monotonic wall clock for
ctime order; a backward step of 0.22 s during a full-suite run pruned the
wrong fixture once. Fixed in the same commit with `proveNewer()` (re-touch
until ctime order is proven), not by a longer sleep.

**How to apply.** Any cache keyed by a remote validator (ETag,
Last-Modified, content hash) may hold only data the validator covers; a
downgrade or a config change must not be able to make a stale verdict
look fresh. When a "not newer" verdict is ever persisted, ask what
else it was computed from.
