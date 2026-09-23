---
type: decision
created: 2026-09-09
updated: 2026-09-23
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

## From the scope doc (moved 2026-09-23)

Verbatim wording of the `.claude/PROJECT-SCOPE.md` bullet before part O1 condensed it; the scope doc holds the current rule.

### Architecture (decided) — In-app update

- **In-app update — decided 2026-09-09 evening (user's call: a
  notification and ONE button, like other apps; the same experience the
  clone-based app had with "New version available → Restart"), phase E.**
  Installed mode only; a developer clone and a `0.0.0*` bundle make no
  outbound request and answer `422` on `POST /api/update`. **Check**
  (`server/update-release.ts`): 20 s after `listen`, then every 6 h (15 min
  backoff × 3 on failure; never in a standby child), one GET to
  `api.github.com/repos/<owner>/<repo>/releases/latest` with ETag /
  `If-None-Match`, no credentials, 15 s timeout, 1 MiB body cap; the release
  passes only if not draft/prerelease, the tag matches the version shape,
  the Setup asset name and both asset URLs EQUAL what the backend constructs
  itself, and the size is ≤ 200 MiB; the answer is cached in
  `<dataDir>/update-check.json` (0600, atomic, ≤ 8 KiB, every field gated on
  read; what is cached is the LATEST RELEASE DESCRIPTOR (`latest`), never the
  verdict — the ETag validates only the payload, so "newer than what I run" is
  decided at USE time; the field was renamed `release` → `latest` on purpose,
  so a file in the old shape fails the read and costs one unconditional 200).
  Precedence: `a new version is installed` (the bundle on disk moved)
  beats `a new version is available` (online); `/api/runtime.update.release`
  carries the offer. **Button** (`POST /api/update`, authed, no body:
  `202 {version}` · `409` in flight · `422` nothing / not installed · `503`
  no updater; progress via `GET /api/update/status` polled at 1 Hz;
  since Nocturne B6 (2026-09-22) `POST /api/update/check`, authed, no body,
  runs the release check NOW — a check already in flight, the periodic
  one included, is shared, never doubled — and answers the same composed
  status `/api/runtime` carries, 503 without a checker; its access line
  carries `note="<constant sentence>"`, the one 2xx route that logs an
  outcome, `reason=` stays a refusal word):
  `server/update-install.ts` downloads `SHA256SUMS.txt` then the Setup as
  `<dataDir>/updates/<version>/<name>.part` with the SHA-256 computed inline,
  exact size, 200 MiB cap, 60 s idle / 15 min total, free-space precheck,
  manual redirects ≤ 3 hops to `github.com` / `*.githubusercontent.com`
  only; a mismatch unlinks the `.part` — the `.part` → `.exe` rename after
  the check is the ONLY way a runnable file ever exists. It then probes
  `%TEMP%` once (`cmd.exe /c echo %TEMP%` → validated → `wslpath -u`), stages
  the exe + `launcher/run-update.ps1` (from the bundle) there through the
  drvfs mount, and runs `powershell.exe` by full path with argv only
  (`-File run-update.ps1 -SetupPath … -ExpectedSha … -LogPath …`); the
  script re-hashes with `Get-FileHash`, refuses on mismatch (exit 2), and
  runs the Setup `/SILENT /SUPPRESSMSGBOXES /NORESTART`; a Setup that has
  not returned after 15 min counts as failed, but the single flight stays
  HELD until that child really exits (a second `Update` answers `409` until
  then; `SetupMutex=AiSessionManagerSetup` is the second lock against two
  concurrent Setups), and the idle-shutdown deferral that an install earns
  ends with the install's active states, never with a held flight. The
  script's stdout is piped into `server.log` (bounded 64 KiB, `debug` on
  exit 0, `warn` otherwise, incl. the last 30 lines of Inno's `setup.log`
  on failure). `POST /api/restart` answers `409` while an install is
  downloading/verifying/installing (a handoff would wipe the `.part`). **The Setup closes nothing
  (flow B)**: `CloseApplications=no` stays, there is no `[Run]`; Windows
  scripts are replaced (not in use), the host binaries land in
  `{app}\host\next` and are promoted to `{app}\host` by the launcher at the
  NEXT start (`Move-AiSmHostNext`, retries, never fails a launch); the WSL
  bundle is unpacked and `current` flipped by the existing helper with its
  live-dir guards; then the existing installed-mode checker reports `a new
  version is installed` and the UI continues AUTOMATICALLY into the proven
  same-port `POST /api/restart` handoff — sessions end like Restart, the session history
  keeps them, the page reloads on the same origin. A silent upgrade reuses
  the previous install's distro and app dir from `install-info.txt`
  (`LoadPreviousInstall`, read via `WizardDirValue` — `{app}` cannot be
  expanded in `InitializeWizard`), never the WSL default. Rejected: closing
  and relaunching the app from the Setup (the old backend survives the 30 s
  grace, so the relaunch attaches to it; `CloseApplications=yes` makes the
  wizard ask too). UI: toast verb `Update` vs `Restart now` by reason; one
  dialog (`Update the app?` → `Downloading… n%` → `Verifying…` →
  `Installing…` → the restart phases); failure = `Nothing was updated` + a
  constant sentence + `Download it yourself` (the one sanctioned browser
  exit); pill `Updating`; a reload mid-install re-adopts progress. Test
  seams: `AI_SM_UPDATE_API_BASE` (loopback-only, refuse-to-start otherwise;
  collapses the asset allow-list to itself), `AI_SM_UPDATE_FIRST_MS`,
  `AI_SM_UPDATE_INTERVAL_MS` (floored at 1000 ms with a boot warning, capped
  at the timer maximum). The exe stays unsigned (signing declined
  2026-09-09); a backend-written file carries no Mark-of-the-Web, so
  SmartScreen does not interrupt this route. Details and rejected
  alternatives: `memory/decisions/in-app-update.md`.
