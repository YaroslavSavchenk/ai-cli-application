---
type: decision
created: 2026-07-25
updated: 2026-07-25
tags: [github, security, secrets, auth]
---
# A pasted GitHub token as a second credential path

**Status:** decided (2026-07-25, user's request) — **implementation queued**,
design gate passed, no code written yet

The user asked for an "add token" button in the GitHub UI, and separately asked
that the token be stored securely with the security auditor involved. That
auditor ran as a **design gate before any code existed** — the constraint list
it produced is the specification, and a later audit checks it line by line.

This **extends** the 2026-07-23 decision (device flow chosen *over* a pasted
PAT); it does not replace it. Both paths will exist, one credential at a time.

**Why it matters beyond convenience:** the device flow needs a registered OAuth
App (`AI_SM_GITHUB_CLIENT_ID`), which the user has not set up, so the whole
GitHub feature is dormant. A pasted token needs no client id — this path makes
the feature usable immediately. Consequence baked into the design:
`configured` (= "a client id exists") is replaced by `deviceFlowAvailable` and
must NOT hide the paste affordance, or the button would be invisible in exactly
the situation it exists for.

## User decisions (2026-07-25)

- **Persisted by default, with a "remember this token" toggle.** Off = the
  credential lives only in the backend process, which already exits ~30 s after
  the last window closes; the user re-pastes next start. Chosen over
  never-persist and over always-persist — it is the only control that genuinely
  removes the on-disk copy, so it should exist, but not be forced.
- **The WSL/Windows finding is recorded, not chased.** See
  [[wsl-0600-not-a-boundary]]: there is no data-dir location that hides from
  the Windows user, so the fix is the comments and the threat model, not code.

## What the gate settled

- **Storage ceiling, stated plainly:** 0600 plus discipline. No keyring exists
  in this environment (verified absent, not assumed), and file permissions do
  not hold against the Windows side at all. Encryption with a key on the same
  disk is theatre; BitLocker covers the only case it would have addressed.
- **The highest-value advice is about the credential, not our storage:** a
  fine-grained token limited to selected repositories, with an expiry, is
  *strictly safer than our own device flow*, which requests read/write on every
  repository of the account with no expiry. That recommendation belongs in the
  panel where the user reads it before pasting.
- **A leak caught before it existed:** a malformed request body would have put
  a fragment of the token into `server.log` via the generic error logger
  (Node embeds part of the input in `JSON.parse` errors — measured). The route
  must catch its own body-parse failure and log nothing.
- **Risks the device flow does not have:** a token for the wrong account
  (so the resolved `@login` must be shown as part of accepting it), and an
  attacker-supplied token pasted by a socially-engineered user (so the copy
  must warn: never paste a token someone else gave you). Revocation copy must
  branch on the source — the existing "remove the app in Settings →
  Applications" sentence is wrong for a PAT and would leave a live credential
  the user believes is revoked.

## Refused outright (from the gate)

Any claim that the token is encrypted, in a keychain, or protected beyond file
permissions; any promise that a compromise of the app is contained (it cannot
be — `POST /api/sessions` spawns arbitrary commands as the user *by design*);
app-level encryption with a same-disk key; any ingress other than the
authenticated POST body; any response returning the token, a prefix, a length
or a masked form; a prefix-based token-format allowlist.

## Rejected alternatives

- **Device flow only** (status quo): leaves the feature dormant until the user
  registers an OAuth App.
- **Delegating to the local `gh`/git credential helper** — the only design with
  zero new stored credential, already rejected by the user 2026-07-23 in favour
  of a self-contained connection. Not re-litigated.

Related: [[github-integration]], [[wsl-0600-not-a-boundary]],
[[localhost-security-model]], [[no-code-in-ui-copy]]
