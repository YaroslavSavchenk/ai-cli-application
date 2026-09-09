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
4. **The Setup** (silent) must reuse the existing install's distro and app
   dir from `install-info.txt` (never the WSL default), replace the bundle
   in WSL, close the app window cleanly (Inno close-applications; the host
   handles the close), and relaunch the app → new `current` boots. Open
   sessions end like "Restart backend"; HISTORY keeps them.

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

- **Host-side updater** (C# downloads + runs): needs a page→host message
  channel, a host rebuild for every change, and does nothing for the Edge
  fallback. The backend already owns HTTP, verification and spawning.
- **In-place bundle swap without the Setup**: leaves the Windows side
  stale and duplicates the installer's prune/refusal logic.
- **Auto-install without a click**: rejected — sessions end at update time;
  the user decides when.
