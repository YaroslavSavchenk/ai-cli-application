---
type: log
created: 2026-10-13
updated: 2026-10-13
tags: [quality, q5, backend, refactor]
---
# 2026-10-13 — Q5: `server/index.ts` split (994 → 663 lines)

Before D6 (the Claude Code compat guard), the backend entry point had to
make room: it was 6 lines under the 1 000-line limit.

**The cut:** each piece is a factory that takes an explicit deps object.
`index.ts` calls it at the spot where the code used to sit, at module load.
- `server/index-banner.ts`: the boot banner and the env redaction
  (`logBootBanner`, `logWebBuild`).
- `server/index-stores.ts`: `createStores`. It builds the stores and
  watchers, does the boot wipe (skipped while a standby waits), and holds
  the `AI_SM_GITHUB_API_BASE` refusal. It returns the stores and the
  reset functions.
- `server/index-update.ts`: `createUpdateWiring`. The installed check, the
  `AI_SM_UPDATE_API_BASE` refusal, the update interval env vars, the
  release checker and the `UpdateController`.

`index.ts` stays the composition root: env refusals, the standby decision,
lifecycle, listen, restart, shutdown, signals.

**Proof of no change:** the boot logs of the old and new `index.ts` match
line for line (timestamps, pids and ports stripped). Checked for the
default run, for a full set of env overrides, and for both URL refusals.
Values that `index.ts` changes later (`webBuild`) are still read through
a getter. Scope review: no ordering or capture change. The stale comments
and the five exports nothing imports were fixed in the one fix round.
