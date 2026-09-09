---
type: knowledge
created: 2026-07-25
updated: 2026-07-25
tags: [security, wsl, threat-model, secrets, gotcha]
---
# `0600` in the WSL data dir is not a boundary against Windows

Verified 2026-07-25 by the security auditor during the pasted-token design
gate — executed, not reasoned. From inside WSL, with no elevation:

```
powershell.exe -NoProfile -Command "Get-Content -TotalCount 3 \
  '\\wsl.localhost\Ubuntu-24.04\home\you\.ai-session-manager\runtime.json'"
```

It printed the live `port` and the full app `token`. **The WSL 9p file server
runs as root inside the distro, so Linux permission bits do not gate reads from
the Windows side.** Every 0600 file in `~/.ai-session-manager/` —
`runtime.json`, `github.json`, `projects.json`, `history.json` (since
2026-09-06; formerly `journal.json`/`previous.json`), `server.log` — is
plaintext-readable by anything running as
the Windows user.

And the port is reachable from there: `netstat.exe -ano` on the Windows side
showed the WSL2 relay `LISTENING` on `127.0.0.1:<port>` (loopback only — no LAN
exposure, that part holds).

## The chain this completes

Windows-side process → read `runtime.json` → connect to `127.0.0.1:<port>` →
`POST /api/sessions` → arbitrary command execution **inside WSL** as the user.
A non-browser client sends no `Origin`, and `originAllowed(undefined)` returns
true by design, so the app token is the only gate — and it was just read from
the file.

## What this does and does not mean

- It is **not a bug in our code**. It is a property of WSL2. There is nothing
  to patch: everything inside the distro is reachable through
  `\\wsl.localhost\`, so there is no data-dir location that hides from the
  Windows user (user's call 2026-07-25: record it, don't go hunting).
- It **is** a correction to comments that claimed more. `server/github.ts` said
  the clone env token is "visible only via /proc to the SAME user — same trust
  boundary as github.json 0600"; the Linux half is right, the implied
  protection is not.
- The trust boundary is therefore: **the WSL user AND the Windows user**, plus
  our own served page (which receives the app token by injection into
  `window.__AUTH__` — which is why the zero-`innerHTML` rule is load-bearing:
  XSS in our own UI is remote code execution, not a defacement).

## The honest ceiling on secret storage here

There is **no OS keyring** in this environment — verified absent: `secret-tool`,
`gnome-keyring-daemon`, `kwalletd5/6`, `pass`, and libsecret itself. A D-Bus
session bus exists with no Secret Service behind it. Installing gnome-keyring
in a headless distro just relocates the question to "what unlocks it", whose
usual answer is an empty password or a key file on the same disk. That is
exactly the theatre the design prototype's "token stored in your OS keychain"
caption already claimed once, and which we corrected — see
[[no-code-in-ui-copy]] for the honesty rule this falls under.

Encryption at rest with a key on the same disk defends against nobody who can
actually take the token. The only attacker position it addresses is the offline
copy (backup, cloud sync, stolen disk), and **BitLocker on `C:` covers that
case for free** — the whole `ext4.vhdx` lives at
`/mnt/c/Users/<user>/AppData/Local/wsl/{...}/ext4.vhdx`, one ordinary Windows
file. (OneDrive exists on this machine but neither the data dir nor the vhdx is
inside it — no cloud-sync exposure today.)

## The bigger truth it forces

Asked whether an attacker who reaches the app could be prevented from moving
laterally, the honest answer is no, and no storage scheme changes it:
`POST /api/sessions` spawns arbitrary commands as the user **because that is
the product**. The deliverable promise is "unauthorized parties cannot reach
the app" (loopback bind + app token + Host/Origin parity, all verified to hold,
including against DNS rebinding), not "reaching the app is harmless". What
remains genuinely useful is shrinking what each credential is worth once
spent — hence the fine-grained-token recommendation in
[[github-token-paste-path]].

Related: [[localhost-security-model]], [[wsl-interop]],
[[github-token-paste-path]], [[github-integration]],
[[auto-port-discovery]]
