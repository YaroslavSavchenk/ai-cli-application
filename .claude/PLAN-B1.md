# B1 — The pane status bar shows what Claude Code reports

Status: STARTED 2026-09-17 (user: "continue met het ontwikkelen"; the next
part in the plan order); developed, reviewed and fixed the same day — see
"Landed shape" below. Part B1 of `PLAN-NOCTURNE.md`; data source = open
decision 2, DECIDED 2026-09-16 by the user
(`memory/decisions/pane-status-bar-data-source.md`). Written by the
orchestrator; this file names functions and regions, never line numbers.

## What B1 is

Since A3 the strip under each terminal (`web/src/ui/pane-status-model.ts`)
states only what the app knows from argv: Model, Mode, Time. B1 makes it the
configurable status bar of the v3 design: the SAME checklist as Settings →
Status bar, fed by the payload Claude Code already hands
`server/statusline.mjs` on every turn.

## User decisions (fixed, 2026-09-16)

1. Data source: the status-line payload (model, cost, context %, account
   usage %, lines changed) plus the branch the script already probes. No
   hooks, no transcript watching.
2. The script writes a per-session snapshot into the app data dir (0600,
   wiped at boot, bounded); the backend carries it in the session info; the
   pane bar renders the same checklist as Settings → Status bar.
3. Active skill has NO source and is DROPPED — no row, no placeholder.
4. Known consequence, accepted: with both on, the same values stand twice
   (Claude's own line inside the terminal and the pane bar under it) unless
   the user switches Claude's line off in the checklist.

## Orchestrator defaults (adopted 2026-09-17; the user has not confirmed them)

- The checklist gets TWO switches instead of one master switch: `enabled`
  (existing: Claude's own line INSIDE the terminal) and `paneBar` (new: the
  bar UNDER the terminal). Both default ON — the existing default is not
  changed under the user's feet; the Settings page says in one line that both
  on shows the values twice.
- `Session time` becomes a checklist row (`time`, default ON) that only the
  pane bar honours; its caption says "under the terminal only". Claude's line
  cannot show it (the payload carries no start time) and the script ignores
  the key.
- The snapshot file is keyed by the APP session id, handed to the script as a
  fourth argument (the absolute snapshot path, server-composed), NOT by the
  payload's `session_id`. Reason: a resumed conversation's `session_id` is the
  old id, and the app must never guess a mapping. One file per session in a
  dedicated directory — no shared-file races between concurrent sessions.
- Pane bar labels follow the v3 mock (`session-manager-v3.html`, `statusDefs`
  / the pane's item builder): `Model`, `Mode`, `Branch`, `Cost`, `Context`,
  `Usage`, `Time`, `Changed`, in that order. `Usage` turns amber at ≥ 80 %
  (v3's `C.warn`); everything else stays neutral except `Mode`'s existing
  danger tone.
- An exited session keeps the last snapshot it had (cost so far is still
  true after the exit); `Time` disappears as today.

OUT of scope: the amber pulse on Files rows (decision 3), background agents
(B7), any change to what Claude's own line prints (its items are untouched;
only its argv grows by one path).

## Contract (Phase 0 — the orchestrator lands this first, in one commit)

### `shared/protocol.ts`

```ts
/** What Claude Code last reported about a session, via server/statusline.mjs. */
export interface SessionTelemetry {
  /** ISO-8601: when the snapshot was written. */
  at: string;
  /** `model.display_name` (falls back to `model.id`). */
  model?: string;
  /** Branch probed in the workspace dir. Absent when the toggle is off or it is not a repo. */
  branch?: string;
  /** `cost.total_cost_usd`, only when > 0. */
  costUsd?: number;
  linesAdded?: number;
  linesRemoved?: number;
  /** 0-100 integer. */
  contextPct?: number;
  usage5hPct?: number;
  usage7dPct?: number;
}
```

`SessionInfo.telemetry?: SessionTelemetry` — present once a snapshot for
that session was read; replaced on every change; kept after exit.

`UiStatusLine` gains `paneBar?: boolean` (default ON, the bar under the
terminal) and `time?: boolean` (default ON, pane bar only).

### Snapshot file (script → server)

Path: `<dataDir>/statusline-snapshots/<appSessionId>.json`. Directory
0700, created and WIPED at boot beside `session-settings/`. File 0600,
written with the script's existing atomic `tmp` + `rename` idiom.

```json
{ "v": 1, "at": 1726560000000, "model": "Opus 4.1", "branch": "main",
  "cost": 0.42, "linesAdded": 128, "linesRemoved": 41,
  "context": 62, "usage5h": 38, "usage7d": 12 }
```

Every field except `v` and `at` is OPTIONAL and absent when the payload has
no real value (the script's honesty rule: zero cost, null context, absent
rate limits → no key). The script writes ONLY when the drawable content
(everything except `at`) differs from what the file already holds, so an
idle session's 2 s refresh causes no churn. The script writes the snapshot
REGARDLESS of `enabled` (the pane bar may be on while Claude's line is off)
and before the `enabled` early-return.

### Script argv

`node statusline.mjs <permission-mode> <prefs.json> [<snapshot file>]`.
The fourth argument is optional: without it the script behaves exactly as
today (the existing tests keep passing). `SessionSettingsStore.command()`
gains the session id and composes the path from a new `snapshotDir` config
member; the id is already `SAFE_ID`-checked in `write()`.

### Server → client

No new message type. Whenever a session's telemetry CHANGES (deep compare),
the manager updates `info.telemetry` and broadcasts the existing
`{ type: 'info', session }` to attached clients. The client's `onInfo` →
`upsertSession` → `notify('sessions')` path already re-renders the pane
status bar.

## Phase A — backend (backend-pty)

Files: `server/statusline.mjs`, `server/session-settings.ts`,
`server/config.ts`, `server/index.ts`, `server/sessions.ts`, new
`server/telemetry.ts`.

1. `config.ts`: `DataPaths.statuslineSnapshotDir = join(dataDir,
   'statusline-snapshots')`, documented like `sessionSettingsDir`.
2. `session-settings.ts`: config gains `snapshotDir`; `command(mode, id)`
   appends `shellQuote(join(snapshotDir, `${id}.json`))`; `write()` passes
   the id; `remove(id)` also unlinks the snapshot file (idempotent).
   `resetDir()` also wipes + recreates the snapshot dir (0700). The security
   comment at the top stays true: the fourth argument is server-composed
   from a `SAFE_ID`-checked id and a server-known directory.
3. `statusline.mjs`: `main()` reads `process.argv[4]`; a new
   `writeSnapshot(file, payload, branch)` builds the snapshot object with the
   SAME extraction helpers the line uses (`obj`, `num`, `pct`, `clean`),
   compares with the current file content (parse, drop `at`, JSON-equal)
   and writes atomically only on change. The branch it records is the one
   `branchFor` returned for the line (only probed when `config.branch` is
   on; no second git call). Any failure is silent, never fatal, never
   printed. The header comment documents the new argument and the
   write-on-change rule. `DEFAULT_CONFIG` already carries `paneBar` and
   `time` (Phase 0) with a comment that the script ignores both.
4. `telemetry.ts` (new): `parseSnapshot(text: string): SessionTelemetry |
   null` — pure, exported, untrusted input: size cap 8 KiB (refuse larger),
   JSON parse in try, plain-object check, `v === 1`, every string through a
   `clean()` twin (strip C0/C1/DEL, collapse whitespace, cap 64), every
   number finite and clamped (cost ≥ 0, lines ≥ 0 integers, percentages
   0-100 integers), `at` a finite ms epoch → ISO; unknown keys dropped. And
   `class TelemetryWatcher` with `start(onChange: (id: string, t:
   SessionTelemetry) => void)` / `stop()`: `fs.watch(dir, { persistent:
   false })`, filename must match `^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.json$`
   (the id is the capture group; anything else is ignored, never joined
   into a path), per-id debounce ~150 ms, then read (cap enforced on read)
   → `parseSnapshot` → callback. If `fs.watch` throws, fall back to a 2 s
   `readdir` + mtime poll. Never throws out of a callback; logs at debug.
   A read of a file that vanished (session ended) is silently skipped.
5. `sessions.ts`: `setTelemetry(id, t)` — no such session → ignore (the
   watcher may fire for a file whose session already ended); deep-equal to
   the current → ignore; else set `info.telemetry` and broadcast `info`.
   `destroy()` / the exit path already call `#settings.remove(id)`, which
   now also removes the snapshot; `info.telemetry` stays.
6. `index.ts`: construct the watcher on `paths.statuslineSnapshotDir`,
   `resetSessionArtifacts()` covers the dir (via the store's `resetDir`),
   `start()` after `sessions` exists with `(id, t) => sessions.setTelemetry(id,
   t)`, `stop()` on shutdown beside the other teardown.

Tests (test-engineer after review; the developer writes the targeted ones it
needs to self-verify): `tests/statusline-script.test.ts` — snapshot written
with the fourth arg (fields, 0600, absent-when-unknown, `enabled:false`
still writes, write-on-change: a second identical run leaves mtime/content
alone, a changed cost rewrites), no fourth arg → no file, unwritable dir →
line still printed. `tests/telemetry.test.ts` — `parseSnapshot` honesty and
sanitising (controls stripped, caps, non-finite, > 8 KiB refused, wrong
`v`), watcher: temp dir, write file → callback with the id; an unsafe
filename never reaches the callback; stop() detaches. `tests/session-
settings.test.ts` — the command carries the snapshot path, quoted;
`remove()` deletes both files. `tests/sessions.test.ts` — `setTelemetry`
broadcasts `info` once per change to attached clients, not for equal data,
not for an unknown id.

## Phase B — frontend (terminal-ui)

Files: `web/src/ui/pane-status-model.ts`, `web/src/ui/panes.ts`,
`web/src/ui/statusline-model.ts` (Phase 0 did the keys), `web/src/ui/
settings.ts`, `web/src/styles/app.css`, `web/DESIGN.md`.

1. `pane-status-model.ts`: `paneStatusItems(session, cfg: StatusLineCfg,
   now)`. Empty array when the session is not the known agent OR
   `cfg.paneBar` is false. Items, in v3 order, each only when its toggle is
   on AND the value is real:
   - `Model`: `telemetry.model` when present (what Claude reports beats the
     argv guess), else the argv label as today.
   - `Mode`: argv as today (the payload carries no mode), danger tone as
     today.
   - `Branch`: `telemetry.branch`.
   - `Cost`: `$` + `costUsd.toFixed(2)`, only when > 0.
   - `Context`: `${contextPct}%`.
   - `Usage`: `${usage5hPct}% of 5h`; both present → `38% of 5h, 12% of
     7d` (a comma, not the mock's middle dot: the A2 copy rule in
     `tests/ui-copy-separators.test.ts` bans `·` in `web/src` literals);
     only 7d → `12% of 7d`. Tone `warn` when the shown 5h (or, without
     it, 7d) value is ≥ 80.
   - `Time`: as today (running sessions only).
   - `Changed`: `+${linesAdded} -${linesRemoved}` when either > 0.
   `StatusTone` gains `'warn'`; `.pane-status-v.is-warn` uses the existing
   amber status token (find the one `.status-attn` / the attention pill
   uses — status colours are semantic, never themed).
2. `panes.ts`: `updateStatus` passes `getStatusLine()`; the signature
   string already covers tone. A checklist change must repaint every pane:
   the settings page calls `st.notify('sessions')` (or an exported
   `repaintStatus()` — pick the one that fits the existing subscription in
   `initPanes`) after `setStatusLine`.
3. `settings.ts` → Status bar page: the single master row becomes two rows
   in the same `sg-rows` block: `Inside the terminal` (`enabled`, caption
   "Claude Code's own line, drawn at the bottom of the terminal") and
   `Under the terminal` (`paneBar`, caption "the app's bar below the
   terminal"). The items group dims only when BOTH are off. `ITEM_ROWS` gains
   `{ key: 'time', label: 'Session time', sample: '2h 15m', caption: 'under
   the terminal only' }` placed before `Lines changed` (v3 order). The lead
   line under the preview gains one sentence: "With both on, the same values
   show twice." The preview keeps showing Claude's line and follows
   `enabled` only. `persist()`'s debug line lists the two switches. Reset
   restores both ON.
4. `web/DESIGN.md`: the status-line section describes the two places, the
   pane bar's items and where they come from (one paragraph; no line
   numbers).

Tests: `tests/ui-pane-status-model.test.ts` — every item's on/off/absent
case, order, tones, telemetry model beats argv, `paneBar:false` → [],
exited keeps Cost drops Time. `tests/ui-statusline-model.test.ts` — the
factory set still matches the script (already covers the new keys after
Phase 0). A settings DOM test (pattern: `tests/ui-a7-parity.test.ts` /
`fake-dom.ts`) — two switches, the Time row and its caption, items dim only
when both are off, persist writes `paneBar` and `time`.

## Landed shape (2026-09-17, after the review round)

- Both developers ran in parallel on the Phase 0 contract; suite 2418 → 2470
  before the fix round. Scope: PASS, no blockers. Security: no must-fix.
- Fix round (one, lean rule 1): the script's write-on-change comparator reads
  the existing snapshot the way the server does (`O_NOFOLLOW`, regular file
  only, 8 KiB cap — a planted FIFO symlink hung the script every tick);
  both atomic writers open their tmp file with `wx`; `snapshotFor()` is
  `SAFE_ID`-guarded; the poll fallback prunes ids whose file vanished; the
  git probe is also skipped when `paneBar` is off (the script reads that one
  key for that one purpose; `time` stays ignored); `web/DESIGN.md` and
  `README.md` brought in line.
- Test gate (37 mutants) found one real defect: a named pipe planted at the
  snapshot path blocked `openSync` in BOTH readers before `isFile()` could
  refuse it — the backend's main thread froze, the script hung every tick.
  Fixed with `O_NONBLOCK` on both opens (`memory/knowledge/fifo-open-blocks-main-thread.md`).
- Accepted as-is: a snapshot written < 150 ms before the process exits is
  unlinked before the debounce delivers it (the pane keeps the previous
  values; `info.telemetry` is never cleared); a claude killed between the
  tmp write and the rename leaves one `.tmp` until the boot wipe (the
  watcher's filename gate ignores it); `paneBar` and `enabled` both default
  ON, so a stock install shows Model/Branch/Cost/Context twice until the
  user switches one off (the plan's rule: never change an existing default
  under the user's feet).
- Repaint after a checklist change goes through an injected
  `repaintStatus()` (panes.ts → settings deps), not `notify('sessions')`:
  no session changed, and the drawer / tab strip / statusline must not
  re-render for a preference that concerns this bar alone.

## Review

- `scope-reviewer` (always): honesty rule, the two-switch model, no
  placeholder for Active skill, plan decisions above.
- `security-auditor`: Phase A only — the fourth argv (composition,
  quoting), the watcher (filename regex, path join, size cap, symlink
  stance), `parseSnapshot` sanitising, what reaches the DOM (textContent
  only — the renderer already uses `el()` text nodes).
- `test-engineer`: mutation probe on Phase A's `parseSnapshot` + watcher +
  the script's snapshot write (hard-constraint adjacent: file paths from a
  foreign process → full probe), capped probe on the UI model.

## Final gate

`/verify-terminal` once, the checks that touch the spawn seam (the argv now
carries one more path; sessions still spawn, resize, and exit cleanly) and
one real claude session showing the pane bar populated after the first
reply. Janitor pass. Docs: `PLAN-NOCTURNE.md` B1 entry + status line,
`PROJECT-SCOPE.md` status-line bullets, `web/DESIGN.md`.
