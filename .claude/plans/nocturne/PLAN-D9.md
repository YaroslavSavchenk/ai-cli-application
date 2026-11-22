# D9 — Sessions survive an update: a pty-host keeps the terminals, the backend re-attaches

Status: STARTED 2026-11-20 (P1 landed `21b9bec`: the PTY layer behind PtyHost; P2 landed `006d058`: the pty-host process + wire; P3 committed 2026-11-21, its RingBuffer.restore fix in `afc25fa`, the P3 gate re-run in progress; P4 landed 2026-11-21: restart and update keep the sessions, 409 `sessions-would-end` + "Restart anyway", reviewed + full mutation gate; P5 landed 2026-11-22 (reviewed scope + security, mutation gate 52 mutants): installer retention keeps a live pty-host's version dir, `launch.ps1 -Stop` ends a lone pty-host, installed status line through `<app>/current`, verify-terminal D9 checks); earlier: DECIDED 2026-11-20 (the user's ask the same day — "ik wil dat wnr een update is de sessies niet afgesloten hoeven te worden. Dus als je een update uitvoert dat na de update alles gewoon open is"; approach and decisions 25–27 of `.claude/plans/PLAN-NOCTURNE.md` asked the same day).

Part D9 of `.claude/plans/PLAN-NOCTURNE.md` (Track D, fixes and asks after the v0.4.0 release). Conventions: `.claude/plans/README.md`.

## What the user gets

- **Update or Restart service, and every session is still there**: same tabs, same panes, same scrollback, and a Claude that was mid-turn kept working through it. The window reconnects as it does today; nothing is resumed or relaunched — it is the same process.
- **A backend crash** no longer takes the sessions with it: relaunch the app within 10 minutes and everything re-attaches. After 10 minutes without a backend they end as a crash does today (History → resume).
- **Closing the app window** still ends every session after the grace, exactly as today.
- The restart/update confirmation says the sessions keep running. In the rare case the session holder itself cannot be kept (an incompatible version), the dialog says beforehand that this time the sessions WILL end, with a "Restart anyway"; they come back through History → resume as today.
- **The first release that carries D9 cannot do it yet** for its own install: the backend that runs the update is the old one without a pty-host. Survival starts from the next update. The release notes say so.

## Decided (user, 2026-11-20) — do not re-ask

1. Approach: a separate long-lived session-holder process (the **pty-host**) owns the PTYs; on restart/update only the backend restarts and re-attaches. Rejected: resume-based restore (a running turn is interrupted, shells lose state); tmux under every session (it sits between the app and the CLI — terminal fidelity, extra dependency).
2. Decision 25: closing the app window keeps ending all sessions after the grace (`lifecycle-bound-backend` stands). D9 covers restart, update and crash only.
3. Decision 26: after a backend crash the sessions wait 10 minutes (orphan grace) for a backend to re-attach, then end.
4. Decision 27: an incompatible pty-host ⇒ the sessions end as today, with a warning in the dialog beforehand ("Restart anyway"); recovery through History → resume. Automatic resume-restore is not part of D9 (a possible later part).

## Defaults (orchestrator, within the decisions — not asked)

- The pty-host is minimal and stable: PTY, raw output ring with absolute byte offsets, the final-output rescue, the kill ladder, exit record, an opaque per-session metadata blob (≤ 16 KiB). All interpretation (BEL attention, OSC title idle, earlyExit, history, settings files, argv/env composition, telemetry) stays in the backend.
- Started by the backend, lazily on the first spawn when none answers: `spawn(process.execPath, [<serverDir>/pty-host-main.ts, <dataDir>], { detached: true, stdio: 'ignore', cwd: dataDir })` + `unref()`; it writes `<dataDir>/pty-host.json` `{ pid, startedAt, proto, build, appDir, token }` (0600, atomic); it loads all its code at start (no lazy import), so a pruned version dir does not hurt it. It exits after 60 s with 0 sessions, so new pty-host code arrives with the next spawn.
- Socket `<dataDir>/pty-host.sock`, created under umask 0177; refuse to start unless the data dir is owned by our uid with mode 0700; first frame `hello` with the token (timing-safe) within 2 s or the connection closes. The bind is the single-instance lock (stale socket: connect refused ⇒ unlink + bind; answered ⇒ exit). Path > 108 bytes ⇒ a `server.log` line and today's behaviour (no pty-host).
- Wire (`server/pty-host-wire.ts`, both sides): `u32 length | u8 kind | payload`, length ≤ 1 MiB + header (bigger closes); kinds JSON control / output (uuid + u64 offset + utf8) / input (uuid + bytes). Handshake `hello { proto, token, role: owner|probe, takeover }` → `welcome { proto, build, pid, startedAt }` | `refuse { reason }`; v1 = exact `PTY_HOST_PROTOCOL` match. Owner verbs: `spawn`, `snapshot`, `input`, `resize`, `kill {mode: ladder|now}`, `set-meta`, `forget`, `list`, `shutdown-all`, `detach`; pty-host → owner: `spawned`/`spawn-error`, `exit`, output frames. Probe: `list-count`, `shutdown-if-empty`. Backpressure: owner socket `writableLength` > 8 MiB ⇒ pause every PTY, resume on drain; never pause with no owner. Never log bytes or env.
- Backend keeps a mirror ring so `attach()` stays synchronous; after re-attach it re-scans only `ring[scannedTo..endOffset]` (scan state, `attention`, `pendingSince`, `titleIdleSince` live in the metadata blob, flushed on change and on `detach`). A gap bigger than the ring loses old bells — logged once.
- Lifecycle: grace expiry / SIGTERM / `-Stop` ⇒ history `shutdown` + `shutdown-all` (unchanged). Restart/update ⇒ `detachAll()` (flush meta, `detach`, close WS 1012, history NOT stamped). Standby probes the pty-host during preflight and reports `ptyHost: compatible|incompatible|none` in `standby-ready`; incompatible ⇒ `409 sessions-would-end` unless `POST /api/restart { endSessions: true }`. Boot (normal and standby `go`): connect as owner (takeover, 2 s timeout) → `list` → history stamps `crash` only for non-live ids → wipe session artifacts except live ids → adopt (rebuild SessionInfo from meta, mirror ring, gap re-scan; exited-in-gap ⇒ `markEnded('exit')` + earlyExit) → rewrite `--settings` for adopted Claude sessions → listen.
- Backend crash ⇒ orphan grace `AI_SM_PTY_HOST_ORPHAN_MS` (default 600 000) ⇒ `shutdown-all`. Pty-host crash ⇒ backend group-probes each known pid and SIGKILLs `-pid`, marks the sessions exited, history `crash` (a new live end reason).
- Exited sessions (scrollback kept) survive too.
- Boot wipe keeps the per-id artifacts of adopted sessions, and keeps the whole `statusline-cache.json` once any session is adopted (it is one file for all sessions) (P3, orchestrator).
- The pty-host writes its own `<dataDir>/pty-host.log` (lifecycle, ids, pids, counts — never bytes, env, argv or the token; rotated like `server.log`, honours `AI_SM_LOG_LEVEL`). New data-dir files: `pty-host.json`, `pty-host.sock`, `pty-host.log` (P2 review, orchestrator).
- The data dir must be ours and 0700: the backend tightens an existing data dir it owns to 0700 (one `server.log` line) and the installer creates it 0700 — a fresh install used to make it 0755, which would refuse the pty-host forever (P2 review, orchestrator).
- Files are flat in `server/` (`pty-host-main.ts`, `pty-host-server.ts`, `pty-host-wire.ts`, `pty-host-client.ts`) — CONTRIBUTING's flat `server/` wins over a `server/pty-host` subfolder this spec first named.
- Dev and installed each get their own pty-host (one per data dir). `/api/runtime` gains `ptyHost: { build, proto } | null` for diagnosis.
- Installer: retention also keeps the pty-host's `appDir` while its pid lives; `launch.ps1 -Stop` with no backend but a live pty-host SIGTERMs it (its handler = `shutdown-all` + exit). In installed mode the status-line command in `--settings` points at `<app>/current/...`, not a version dir.
- Automatic install of updates stays rejected for now (ask again once survival is proven on Windows).

## Found 2026-11-20 (line numbers drift)

- Sessions: `SessionManager.#sessions` (`server/sessions.ts` ~:203) holds the node-pty handle, the 1 MiB ring (`server/sessions-output.ts` ~:23) and the sockets; `create()` (~:291-537) spawns synchronously (~:347). The browser keys tabs/panes by session id (`web/src/state-persist.ts`; `reconcileViews` `web/src/state-views.ts` ~:179) — same ids ⇒ no frontend change.
- What ends sessions: restart teardown `server/index-restart.ts` ~:115 (`history.endAllLive('shutdown')` + `sessions.destroyAll()`); the update continues into that restart; `shutdown()` `server/index.ts` ~:519; crash ⇒ boot stamps `crash` (`server/history.ts` ~:159); boot wipes `session-settings/`, `statusline-snapshots/`, `statusline-cache.json` (`server/index-stores.ts` ~:89, standby `go` `index.ts` ~:635).
- Kill ladder (SIGHUP, +2 s TERM, +3 s KILL to `-pid`), `#groupGone`, `signalableChildPid`: `sessions.ts` ~:98-118, ~:800-886. Final-output rescue: `sessions-output.ts` ~:388-554. node-pty on Linux forks natively (no spawn-helper).
- Installer retention protects only the backend's dir from `runtime.json` (`installer/helpers/install-bundle.ps1` ~:34-38, ~:195-215).

## Phases (each lands and is tested alone)

- **P1 — PTY layer behind an interface, in-process; no behaviour change.** New `server/pty-table.ts` (spawn, ring with offsets, rescue, kill ladder, exit record) moved out of `sessions.ts`/`sessions-output.ts`; `server/pty-host-api.ts` (the `PtyHost` interface + in-process implementation). `create()` becomes async (`api-sessions.ts` and every `new SessionManager` user). Gate: suite green, same test count, kill-ladder and tail tests unchanged in their assertions.
- **P2 — the pty-host process and wire.** `server/pty-host-{main,server,wire}.ts`, `server/pty-host-client.ts`, `tests/helpers/pty-host-fixture.ts`; seams `AI_SM_PTY_HOST_IDLE_MS`, `AI_SM_PTY_HOST_ORPHAN_MS` (floored), `AI_SM_PTY_HOST=inproc` (tests only, refused in installed mode). Not yet wired into `index.ts`. Tests with a real pty-host child: auth/perms refusals, frame cap, disconnect + reconnect ⇒ same pid + continuous offsets, orphan grace kills the group (SIGHUP-ignoring child too), idle exit, single instance + stale socket, deleted code dir still spawns, backpressure loses nothing.
- **P3 — backend uses the pty-host and adopts at boot (crash survival).** `index.ts` (connect before listen), `index-stores.ts`, `history.ts` (`load({ live })`, `crash` live reason), `sessions.ts` (`adopt`, meta flush, gap re-scan, holder-death group kill), `session-settings.ts`. Test: SIGKILL the backend mid-output, boot a new one ⇒ same id + pid, no gap, BEL in the gap raises attention.
- **P4 — restart and update keep sessions.** `index-restart.ts` (`detachAll`), `restart.ts` (`ptyHost` in `standby-ready`, fallback, `endSessions`), `index.ts` `go`, `web/src/ui/update-model.ts` (`confirmBody`), `update.ts`/`restart-flow.ts` (409 path). `restart-real.test.ts` inverted; new `restart-survive.test.ts`; incompatibility test. Docs: scope doc (reverse "Sessions do NOT survive a restart"), decision note `memory/decisions/pty-host-session-survival.md`, updates to `backend-restart-same-port.md`, `detached-backend.md`, `in-app-update.md`.
- **P5 — installer, launcher, status line.** `install-bundle.ps1` retention, `launch.ps1 -Stop`, `--settings` via `current`; `tests/release/` cases; verify-terminal gains: restart mid-output (same pid, no lost bytes, repaint after reload), Claude mid-turn survives Update, resize after re-attach reaches the same PTY.

## Risks (checked during the phases)

- Does Claude Code re-read a changed `--settings` file? Unverified (P5's `current` paths reduce the need).
- Async `create()` spreads through the API and tests — P1 isolates the churn.
- Socket path limit with test temp dirs — measure in P2.
- `pause()` with node-pty 1.1.0 vs the rescue patch of `socket.destroy` — re-check in P2.
- (P3 gate, FIXED 2026-11-21) `RingBuffer.restore()` stored the snapshot as ONE chunk and the ring trims whole chunks — the first append after an adopt dropped the whole restored scrollback. Now sliced into 1/64 of the cap. The gate was stopped partway (user ended the session): re-run over the P3 files.
- Pty-host processes leaking out of the test suite — every fixture kills its pty-host; short idle seam.
- (P1 reviews) Once spawn crosses a socket the `create()` await is real I/O: (a) a session in `#ptys` but not yet in `#sessions` is invisible to `destroy`/`destroyAll` — a shutdown or restart in that window leaves a live PTY nobody owns (possibly holding an API key in its env) → a pending-spawn set that `destroy`/`destroyAll`/`detachAll` respect; (b) an `exit` that beats the `spawned` reply runs `markEnded` before `recordCreate` (a live history entry that never ends) → the client queues frames after `spawned` until the spawn continuation ran, and history registration survives an early exit; (c) two concurrent resumes of one conversation no longer share a tick between the 409 check and going live → a per-conversation in-flight guard.
- (P1 gate) `SessionManager` has no injectable `PtyHost`, so a missing `host.forget` (a table entry of up to 1 MiB leaked per deleted session) is invisible to tests → P2/P3 add the seam and a test.
- (P1 reviews) The interface still lacks `detach` and a "host lost" event (P2 adds both); `setMeta`'s 16 KiB cap must be checked client-side (no-reply verb); a full 1 MiB `snapshot` ring does not fit the ≤ 1 MiB frame with a JSON envelope → a binary snapshot frame kind.

## Out of scope

- Sessions surviving a closed app window (decision 25).
- Automatic resume-restore when the pty-host is incompatible (decision 27).
- Automatic installation of updates.
