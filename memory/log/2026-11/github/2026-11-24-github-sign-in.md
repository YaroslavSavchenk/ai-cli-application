---
type: log
created: 2026-11-24
updated: 2026-11-24
tags: [github, oauth, device-flow, bug]
---
# 2026-11-24 — Sign in with GitHub, built in; the poll that never finished

User: "hoezo zie ik nog steeds niet alle repos" → the pasted token was a
fine-grained one with public-repository access only (5 of 11 repos). User:
"kunnen wij niet zoiets doen?" (a screenshot of Authorized OAuth Apps).

## Done

- The user registered the OAuth App "AI Session Manager" (Device Flow on,
  no client secret, "Expire user access tokens" OFF — the app has no
  refresh-token handling). Its client id is baked in:
  `DEFAULT_GITHUB_CLIENT_ID` in `server/config.ts`; `AI_SM_GITHUB_CLIENT_ID`
  set overrides, set empty disables. Test servers default it to empty, so no
  test reaches github.com's device endpoints.
- **Bug found in the first real sign-in:** the device flow had never run
  against real GitHub. Polling at exactly the interval drew `slow_down` on
  every poll (7 of 8 measured; GitHub adds 5 s and names the new interval),
  so the token never landed though the user had approved. Fix: every poll
  waits interval × 1.2 (`pollDelayMs`), and `slow_down` adopts the interval
  GitHub names when longer. `tests/server/github-poll-margin.test.ts`.
- Proven live: connected as the user via the device flow, 10 repositories
  (5 private), scope `repo`, token does not expire. The test data dir (with
  the token) was deleted afterwards.

## Left

- `VilocNV/test-automation` stays hidden until that organisation approves
  the OAuth App (organisation OAuth App restrictions).
