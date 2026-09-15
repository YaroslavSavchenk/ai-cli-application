# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue or pull
request: **Security → Report a vulnerability** on this repository (GitHub's
private vulnerability reporting). You will get a reply there; a fix ships
as a new release and the advisory is published once it is out.

Please include what you can of: the version (`Settings → Background service` in the app,
or the release tag), how to reproduce it, and what an attacker gains. A
proof of concept is welcome; a working exploit against someone else's
machine is not needed.

## Supported versions

Only the **latest release** receives security fixes. There is no
long-term-support line; update to the newest release before reporting, in
case the issue is already fixed.

## What counts

The app is a localhost service whose core feature is **spawning shells**
inside WSL: a Node.js backend on `127.0.0.1`, a browser (WebView2) window
as the only client, and real pseudo-terminals for the sessions. The
attacker in its threat model is not on the network. It is any web page open
in the user's browser, which can silently fire `fetch()` and WebSocket
connections at `localhost:<port>`. An endpoint that page could reach
without the app's token would be drive-by remote code execution.

Reports in scope, roughly in order of severity:

- Reaching the backend without the per-run token (the token is generated at
  start, stored in a user-only-readable file, and injected into the served
  page), or a WebSocket upgrade that succeeds without it.
- Getting past the `Origin` / `Host` checks: a foreign page's request being
  accepted, or DNS rebinding (an attacker's name resolving to `127.0.0.1`).
- Client-supplied values (a project path, command, arguments, session name)
  reaching a shell as a string instead of an argv array, or influencing
  which binary is spawned.
- Reading or writing outside a registered project directory through the
  file panel, the directory browser, the file editor, or path parameters
  (`..`, symlinks, absolute paths).
- The Windows launcher or the native host starting a backend from a
  location or distro the user did not choose, or the update path running
  code that did not come from a verified release.
- Secrets leaking: the auth token, a GitHub token, or terminal scrollback
  (which can contain anything the user typed) ending up in logs, error
  messages, HTTP responses, or world-readable files.
- A dependency with a known vulnerability that this app actually exposes.

Out of scope: anything that needs the attacker to already run code as the
same Windows or WSL user (they already own the sessions), and the
`--dangerously-skip-permissions` launch mode itself. That mode is a
deliberate, visible choice in the launch dialog; a way to enable it without
the user seeing it would be in scope.

## Automated checks

Every push and pull request runs the test suite (which includes the
authentication, origin and path tests), CodeQL code scanning for the
TypeScript, the C# host and the workflows, and GitHub secret scanning.
Findings are handled in the repository before a release is tagged.
