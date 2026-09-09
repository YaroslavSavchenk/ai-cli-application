---
type: decision
created: 2026-09-09
updated: 2026-09-09
tags: [update, installer, release, security, ux]
---
# In-app update: a notification and one button

**Status:** decided 2026-09-09 evening (user), IN PROGRESS as phase E of
[[installer-and-self-contained-bundle]]. Reverses the orchestrator's v1
default "no update *checking* over the network" recorded there; the
"Check for updates" link stays as the manual fallback.

## What the user asked

After v0.2.0 shipped, the user asked whether a new release would show
"a new version — update please?" like other apps do — a notification and
ONE button, "hetzelfde wat wij hadden voordat wij vanuit locale versie
volledige app gingen maken" (the clone-based app's "New version available
→ Restart" toast). Code signing was declined the same evening (the
SmartScreen prompt on the unsigned exe is accepted).

## The design (installed mode only)

1. **Check.** The backend GETs `releases/latest` from the GitHub API at
   boot and periodically (ETag-cached, rate-limit aware, failures silent).
   Newer than `bundle.json.version` → `/api/runtime.update` carries the
   release (version, Setup asset URL + size, sums-file URL).
2. **Toast.** "Version vX.Y.Z is available" with **Update** (plus the
   existing dismissal). Copy stays plain — no URLs, no commands.
3. **Button (authed, user-initiated).** The backend downloads the Setup
   exe and `SHA256SUMS.txt` from the release, verifies the exe's SHA-256
   against the sums file BEFORE anything else touches the file, places it
   where Windows can run it, and starts it silently via `powershell.exe`
   (full path, argv only). Progress/failure is reported back to the UI.
4. **The Setup (silent) closes NOTHING — flow B.** `CloseApplications=no`
   stays, no `[Run]`. It reuses the previous install's distro and app dir
   from `install-info.txt` (read via `WizardDirValue`; `{app}` cannot be
   expanded in `InitializeWizard` — measured), replaces the Windows scripts
   (not in use), stages the host binaries in `{app}\host\next` (promoted by
   the launcher at the next start), unpacks the bundle in WSL and flips
   `current` with the existing live-dir guards. The existing installed-mode
   checker then reports "a new version is installed" and the UI continues
   automatically into the proven same-port `POST /api/restart` handoff.
   Open sessions end like "Restart backend"; HISTORY keeps them; the page
   reloads on the same origin.

Why the Setup and not an in-place swap: the Windows side (host exe, DLLs,
launcher scripts, uninstaller) can only be replaced by the installer, and
the installer already knows how to swap `current`, prune and refuse.

## Security stance

- Only the backend downloads; only what was verified against the release's
  own `SHA256SUMS.txt` is ever executed; the sums file and the exe come from
  the same origin (github.com release assets) — the same trust as a manual
  download, no more, no less (the exe is unsigned by decision).
- Outbound traffic: two hosts (`api.github.com`, `github.com` +
  its asset redirect), only in installed mode, only for this feature; a
  `AI_SM_UPDATE_*` seam for tests must be loopback/file-only like the
  other seams.
- The exe runs from a Windows-owned location with `/SILENT
  /SUPPRESSMSGBOXES`; every message box in the Setup is suppressible
  (phase B audit) so nothing can block invisibly.
- A file the backend downloads has no Mark-of-the-Web → SmartScreen does
  not interrupt this route. Not a bypass of anything the user did not
  already accept on first install.

## Rejected alternatives

- **Flow A — the Setup closes and relaunches the app** (`/CLOSEAPPLICATIONS`
  + a `[Run]`/`ssDone` relaunch): the old backend survives the 30 s presence
  grace and `runtime.json` still points at it, so the relaunched launcher
  attaches to the OLD backend; fixing that needs a hard `-Stop` instead of
  the proven preflight; `CloseApplications=yes` makes the wizard ask too;
  the host has no close handler to verify from WSL. Flow B has one cost:
  the host exe/DLLs lag one version until the next app start — harmless,
  the host only navigates to `127.0.0.1:<port>`.

- **Host-side updater** (C# downloads + runs): needs a page→host message
  channel, a host rebuild for every change, and does nothing for the Edge
  fallback. The backend already owns HTTP, verification and spawning.
- **In-place bundle swap without the Setup**: leaves the Windows side
  stale and duplicates the installer's prune/refusal logic.
- **Auto-install without a click**: rejected — sessions end at update time;
  the user decides when.
