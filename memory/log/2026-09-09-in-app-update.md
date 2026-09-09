---
type: log
created: 2026-09-09
updated: 2026-09-09
tags: [log, update, installer, security, ui]
---
# 2026-09-09 (evening/night) — phase E: the in-app updater SHIPPED

Decision: [[in-app-update]] (user, after v0.2.0: "melding en hetzelfde
knop, zoals andere apps"; code signing declined the same evening). Built on
[[installer-and-self-contained-bundle]] and [[restart-preflight-standby]].

## What landed

- **Release check** (`server/update-release.ts`): installed mode only, never
  for `0.0.0*` builds; 20 s after listen then every 6 h, ETag-cached in
  `<dataDir>/update-check.json`, no credentials, 1 MiB body cap, release
  gated (not draft/prerelease, tag shape, CONSTRUCTED asset name + URLs must
  equal the API's, size ≤ 200 MiB); `a new version is installed` beats
  `a new version is available`.
- **Download + verify + launch** (`server/update-install.ts`): sums file
  first, Setup as `.part` with inline SHA-256, exact size, caps and
  timeouts, manual redirects ≤ 3 hops to `github.com`/`*.githubusercontent.com`
  only; the `.part` → `.exe` rename after the check is the only way a
  runnable file exists; `%TEMP%` probed via `cmd.exe`, staging through
  drvfs, `powershell.exe` by full path with argv only; single-flight
  controller (409), flight held until the child exits; script stdout piped
  into `server.log` (64 KiB, `oneLine`); idle shutdown deferred only while
  the install is active; `POST /api/restart` refused (409) while an install
  is active.
- **`launcher/run-update.ps1`** (shipped in the bundle): gates, re-hash
  with `Get-FileHash`, `Unblock-File`, `/SILENT /SUPPRESSMSGBOXES
  /NORESTART /LOG=`, exit 0/2/3, prints the `setup.log` tail on failure,
  removes its staging dir (guarded by the `ai-session-manager-update`
  segment; steps out of the cwd first — the cwd trap was measured).
- **Installer (flow B)**: `CloseApplications=no` stays, no `[Run]`; host
  binaries staged to `{app}\host\next` and promoted by the launcher at the
  next start (`Move-AiSmHostNext`, measured against a real file lock);
  `LoadPreviousInstall` reuses `install-info.txt` via `WizardDirValue`
  (`{app}` cannot be expanded in `InitializeWizard` — measured);
  `SetupMutex`. Compiled locally with the portable ISCC each time.
- **UI**: toast verb `Update` vs `Restart now`; one dialog `Update the
  app?` → `Downloading… n%` → `Verifying…` → `Installing…` → the existing
  restart phases; `Nothing was updated` + constant sentence + `Download it
  yourself`; pill `updating…`; reload mid-install re-adopts; `Later` is
  per version.
- Suite 1063 → 1160; `npm test` now has `--test-timeout=120000`.

## Review (2 cycles + a dedicated test gate)

- MED: 1 Hz status poll flooded server.log at info; an install did not hold
  the backend alive through the presence grace; the Setup's diagnostics
  were discarded. LOW ×9: 503 body rendered verbatim, `Later` keyed on the
  reason (silenced the NEXT release too), timeout released the single
  flight while the Setup ran, exit-code mapping, owner/repo unpinned,
  `+build` shape drift, interval seam 0 = tight loop, `wslpath` by PATH,
  path caps disagreeing (max composed path = TEMP + 2·tag + 57).
- Cycle 2: the deferral must follow the install STATE, not the held flight
  (else a hung Setup defers the lifecycle forever); restart during a
  download would wipe the `.part`.
- Test gate: 13/13 mutants killed; zero non-loopback `connect(2)` proven
  with an `LD_PRELOAD` tracer and in a network namespace; redirect
  allow-list measured against 12 bypass spellings.

## Windows-only (user)

The one-button run itself: toast → Update → progress → same port on the
new version, no SmartScreen; `host\next` promoted at the next start; a
`/SILENT` upgrade reusing the recorded distro; `%TEMP%` with a space. The
first updater-capable release (v0.3.0) must be installed by hand once —
v0.2.0 has no button.
