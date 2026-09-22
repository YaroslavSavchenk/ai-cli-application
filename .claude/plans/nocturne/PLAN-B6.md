# Plan B6 — Settings live: tools, defaults, the keyboard page, check for updates (Nocturne Track B)

Status: LANDED 2026-09-22 (the landing commit; log `memory/log/2026-09/nocturne/2026-09-22-nocturne-b6.md`; suite 3127 → 3224; verify-terminal B6-1…7 + sanity 1/2/4 PASS; Windows check owed to the user); earlier: STARTED 2026-09-22 (user: "continue werken aan de app"; next row in the status table; decisions D1–D4 asked the same day, before the developer started; D5 after the 2b review).
Parent: `.claude/plans/PLAN-NOCTURNE.md` part B6. A7 (2026-09-13) drew the
Settings dialog with five pages; B1 made Status bar live, B5 made the API
keys live, and the Background service page has read the real version and
uptime since A7. What is still a mock after B4: the `Defaults` rows on
Preferences (disabled, with the note `These defaults are examples until the
app saves them.`), tool visibility (does not exist at all), the Keyboard page
(a hand-copied three-row excerpt of the shortcuts overlay), and `Check for
updates` (opens the releases page in the browser). B6 makes those real and
leaves Terminal colours to B9. Runs through `/dev-flow` (lean rules 1–11);
`security-auditor` on phase 1 only (one new POST that starts an outbound
fetch); `/verify-terminal` once at the end, scoped (follow output and the
one-click end must not touch resize or attach). Line numbers drift — verify
by reading.

## User decisions (2026-09-22)

- **D1 any card can be hidden, at least one stays.** Preferences gets a
  `Tools` block with one toggle per card of the New session dialog (Claude
  Code, Codex, Gemini CLI, Grok, Terminal, Other). A hidden card is absent
  from the dialog's grid. Hiding the last visible card is refused in place
  with `Keep at least one tool visible.` Running sessions are untouched.
  Rejected: only the four AI tools.
- **D2 the notifications row is dropped until C1.** No notification
  mechanism in B6; the in-app pill and badge stay unconditional. The peek
  mascot's own toggle (C1 phase 4) takes the row's place later. Rejected for
  now: the browser Notification API through the WebView2 host.
- **D3 `Reopen tabs on start` off applies only to a NEW app start.** A fresh
  backend run starts on Home; a reload within the same run (F5, the reload
  after `Restart service` or an update) keeps the layout. Keyed on the
  backend's start time. Rejected: every page load.
- **D4 `Check for updates` checks now and answers on the page.** A new
  `POST /api/update/check` runs the backend's existing GitHub check at once;
  the page answers `You have the newest version.` / `Version <tag> is
  available.` with the same `Update` act as the toast / `A new version is
  installed. Restart the service to use it.` / `Could not check for
  updates.` Hidden when the app is not installed, as today. Rejected: keep
  opening the releases page.

- **D5 the backend keeps its port across app starts (asked after the 2b
  review, 2026-09-22).** The tab layout lives in localStorage, which is tied
  to the origin INCLUDING the port; a fresh app start auto-picked a new port,
  so the layout was gone whatever D3 said, and the only run-crossing case
  that kept the bag (the same-port restart handoff) was the one D3 keeps —
  the switch would have been invisible. Decided: the backend remembers its
  last port in the data dir and tries it first on every start, auto-picking
  only when it is taken. Consequences: ON restores the file tabs and views
  after a fresh app start (new — they were lost before), OFF starts on Home
  after a fresh start and keeps the layout on F5 and after `Restart
  service`. Rejected: the switch governing restarts only (a fresh start
  always Home); dropping the row until the layout is stored server-side.

## Orchestrator defaults (recorded 2026-09-22, not asked; each a cheap flip ⟲)

- ⟲ **Prefs keys.** `UiPrefs.behaviour` (`reopenTabs`, `confirmEnd`,
  `followOutput`, all boolean, factory `true / true / false`) and
  `UiPrefs.tools` (`hidden: string[]`, factory `[]`). NOT `defaults`: that
  is a DEAD key (`DEAD_PREFS_KEYS`) the client prunes on every write for the
  retired 2026-07-20 launch-defaults store. Every member is written
  explicitly on save, like `statusLine`. The server keeps treating the bag as
  opaque (no schema change server-side); the CLIENT clamps on read like
  `clampStatusLine`.
- ⟲ **What `Reopen tabs on start` actually restores.** Sessions never
  survive a backend run (they die with it), so on a new run the switch
  decides only what is left in the localStorage bag: the editor tabs (files
  and diffs, B4 D2), the folder tabs, the empty views, their names and order,
  and which one was active. ON (factory) = today's behaviour. OFF = those go,
  the window starts on Home. The Files panel's open state and width are
  panel wishes, not tabs: restored either way. Row caption says so in words.
- ⟲ **`Confirm before ending a session`** = the existing armed two-step
  (`×` → `End` / `Sure?`, click again) on EVERY door that ends a session: the
  tab strip's `×`, the Sessions drawer's `×`, the pane header's end button
  and the exited banner's `End session`. OFF = one click ends. The unsaved-
  text question (B4 D1) is a different question and is never switched off.
  Ending a project's sessions from the Projects drawer keeps its own arm
  (that removes a project, not a session).
- ⟲ **`Follow output`** ON = every write to a terminal ends at the bottom
  (`scrollToBottom` in the write callback), even when the user had scrolled
  up. OFF (factory) = xterm's own rule: the view follows only while it is
  already at the bottom. A replay (attach) always ends at the bottom, as
  today. Read fresh on every write, so a flip applies to running sessions
  without a reattach.
- ⟲ **Tool visibility only hides cards.** The dialog's grid skips hidden
  ids; a hidden card that a project's launch defaults or the last launch
  would pre-select falls back to the FIRST visible card. `GET /api/tools`
  (`Not installed`) is unchanged and independent: a hidden tool is not
  probed for in the dialog, an absent one is still inert. The Preferences
  page's key rows stay for hidden tools (a key is about the tool, not the
  card). A hand-edited bag that hides all six clamps to the first card
  (`claude`) visible.
- ⟲ **The Keyboard page draws the whole shortcuts table from ONE source.**
  `ROWS` (+ its `Row` type) move out of `ui/shortcuts.ts` into a pure data
  module `ui/shortcuts-rows.ts`; the overlay and the Keyboard page both read
  it; `KEY_ROWS` and the `all shortcuts` link are deleted, and so is the
  `openShortcuts` dep of `initSettings`. Every row keeps its three facts
  (keys, what, the visible twin) and its note; the page lays them out in
  the Nocturne idiom for a modal page (`/frontend-designer` decides the
  shape; the overlay is untouched). The scope doc's "Keys section" sentence
  is rewritten at the landing.
- ⟲ **`Check for updates` serialises.** A check already in flight is awaited,
  never doubled (module-level promise in the route's dep); the button reads
  `Checking…` and is disabled while out. The answer line sits under the two
  facts; it is cleared when the dialog closes. After the answer the client
  re-fetches `GET /api/runtime` and runs the normal `applyRuntime()`, so the
  pill and the toast learn the same thing through the ONE existing path;
  the page's `Update` button is `openRestartConfirm('settings')`, which is
  already in update mode when the state says a release is available.
- ⟲ **Copy.** Row labels stay v3's: `Reopen tabs on start`, `Confirm before
  ending a session`, `Follow output`; captions are one sentence each. The
  Tools block's lead: `Cards shown in the New session dialog.` The
  Preferences lead `The keys your tools need.` becomes `Your tools and how
  the app behaves.` (it no longer speaks for keys alone). No code, no flags
  in copy (`memory/decisions/no-code-in-ui-copy.md`).
- ⟲ No new dependency, no new colour, no new token. Saving is immediate on
  every toggle (as the Status bar page), through `api.updatePrefs(patch,
  DEAD_PREFS_KEYS)`; a failed write flips the row back and logs.

## Frozen protocol (`shared/protocol.ts`, written by the orchestrator in phase 0)

```ts
/** Nocturne B6 — how the app behaves; every member optional, factory in ui/prefs-model.ts. */
export interface UiBehaviour {
  /** Restore the editor and folder tabs, the empty views and their order on a NEW app start (D3). Factory true. */
  reopenTabs?: boolean;
  /** Ending a session takes the armed two-step; off = one click. Factory true. */
  confirmEnd?: boolean;
  /** Every write to a terminal ends at the bottom, even after scrolling up. Factory false. */
  followOutput?: boolean;
}
/** Nocturne B6 — cards hidden from the New session dialog, by card id (`TOOL_CARDS`). */
export interface UiTools {
  hidden?: string[];
}
export interface UiPrefs {
  theme?: UiTheme;
  statusLine?: UiStatusLine;
  behaviour?: UiBehaviour;
  tools?: UiTools;
  [key: string]: unknown;
}
/**
 * POST /api/update/check — no body. Runs the release check now and answers the
 * SAME composed status GET /api/runtime carries under `update`. 503 when this
 * backend has no checker (not an installed app); 405 for any other method.
 */
// answer: UpdateStatus
```

Client (`web/src/api.ts`, phase 0): `checkForUpdates(): Promise<UpdateStatus>`
— the same `request<T>` shape as `startUpdate`.

Model (`web/src/ui/prefs-model.ts`, NEW, phase 0, pure, mirrors
`statusline-model.ts`): `BehaviourCfg` (resolved), `behaviourDefaults()`,
`clampBehaviour(raw)`, `initBehaviour(fromPrefs)`, `getBehaviour()`,
`setBehaviour(next)`, `behaviourPatch(cfg): UiPrefs`; `clampHiddenTools(raw,
ids: readonly string[]): string[]` (strings only, known ids only, deduped, in
`ids` order; all hidden → the first id is dropped from the list), `initHiddenTools`,
`getHiddenTools()`, `setHiddenTools(next)`, `toolsPatch(hidden): UiPrefs`.
Wired in `main.ts` beside `initStatusLine(prefs?.statusLine)`.

## Phase 1 — backend (`backend-pty`, small)

Files: `server/api.ts` (one route beside `/api/update/status`),
`server/index.ts` (the dep), `tests/update-check-route.test.ts` (NEW, over
real HTTP like `tests/restart.test.ts`; a fake `ReleaseChecker` through the
deps seam, never a network).

1. `deps.updateCheck?: () => Promise<UpdateStatus>`; in `index.ts`:
   `releaseChecker === undefined ? undefined : () => inflight ??=
   releaseChecker.checkNow().then(checkUpdate).finally(() => { inflight =
   undefined })` — one promise shared by concurrent callers.
2. Route: token + Origin/Host like every `/api` route (already applied
   before `handleApi`); NO body read; `POST` only (405 otherwise); dep
   absent → 503 `UPDATE_NOT_AVAILABLE`; else `sendJson(res, 200, await
   deps.updateCheck())`. `checkNow()` never rejects (a failure is a log
   line), so a network failure answers the LAST known status, not 5xx.
3. Log: `POST /api/update/check -> 200, <reason or 'up to date'>` — the
   reason is one of the constant sentences, never remote text.
4. Tests: 405; 503 without the dep; 200 with the fake's status; two
   concurrent POSTs run ONE `checkNow`; the token gate; a body is ignored.

## Phase 2a — Settings pages (`terminal-ui`, `/frontend-designer` applies)

Files: `web/src/ui/settings.ts`, `web/src/ui/shortcuts-rows.ts` (NEW),
`web/src/ui/shortcuts.ts` (reads the rows from the new module, nothing
else), `web/src/styles/app.css` (the Tools block, the answer line, the
Keyboard page's layout), `web/src/main.ts` — ONLY the `initSettings(...)`
call (the `openShortcuts` dep goes). Tests: `tests/ui-settings-panel.test.ts`,
`tests/ui-settings-a7.test.ts` (pins that change), `tests/ui-shortcuts-table.test.ts`
(imports the new module), a new `tests/ui-settings-b6.test.ts`.

1. **Preferences → Tools block** (new, above `Defaults`): lead, one
   `checkRow` per `TOOL_CARDS` entry (mark + label as the key rows), checked
   = visible. Toggle → `setHiddenTools` → `api.updatePrefs(toolsPatch(...),
   DEAD_PREFS_KEYS)`; refusing the last one shows `Keep at least one tool
   visible.` in the row's caption slot for a moment (no dialog, no toast).
2. **Preferences → Defaults, live:** three rows (D2 drops the fourth), each
   `checkRow` with a caption, `disabled` gone, `aria-pressed` follows
   `getBehaviour()`; toggle → `setBehaviour` → `updatePrefs(behaviourPatch
   (...), DEAD_PREFS_KEYS)`; a failed write flips back. The placeholder note
   and `prefsPlaceholderNote()` are deleted; `DEFAULT_ROWS` becomes the
   row table with keys and captions.
3. **Keyboard page:** every row of `shortcuts-rows.ts`, notes included, in
   a layout that fits the page (the overlay's three columns do not); the
   `all shortcuts` button, `KEY_ROWS`, `KeyRow` go. The lead stays.
4. **Background service:** `Check for updates` → `Checking…` (disabled) →
   `api.checkForUpdates()` → the answer line (`sg-svcanswer`) with the
   sentence per reason (D4) and, for `a new version is available`, the
   `Update` button (`openRestartConfirm('settings')`); then `api.getRuntime()`
   + `applyRuntime()`. A rejected promise → `Could not check for updates.`
   Hidden when not installed (unchanged). The line is cleared on close.
5. **Tests:** the Tools rows mirror `TOOL_CARDS`; a toggle writes the patch
   (the api double records it) and the DOM follows; the last visible card
   refuses with the sentence and writes nothing; the three Defaults rows are
   enabled, write, and flip back on a failed write; the Keyboard page holds
   every row of `shortcuts-rows.ts` (count + the `what` texts); the overlay
   is unchanged (its existing pins pass); the check button's four sentences
   and the `Update` button; `Checking…` while out; the mock-count pin for
   Settings asserts zero mock rows.

## Phase 2b — the consumers (`terminal-ui`)

Files: `web/src/ui/launch.ts` (hide cards), `web/src/state.ts` (`loadUi`
gate, the `run` stamp), `web/src/ui/tabs.ts`, `web/src/ui/sessions.ts`,
`web/src/ui/panes.ts` (the doors), `web/src/ui/terminal.ts` (follow),
`web/src/main.ts` — ONLY the `st.loadUi(...)` call. Tests:
`tests/ui-launch-dialog.test.ts`, `tests/ui-state.test.ts`,
`tests/ui-tabs*.test.ts`, `tests/ui-sessions*.test.ts`, `tests/ui-terminal*.test.ts`
(whichever exist — add beside them, never a new runner), a new
`tests/ui-prefs-model.test.ts` for the pure module.

1. **Launch dialog:** the grid is built from `TOOL_CARDS` minus
   `getHiddenTools()`, re-evaluated on every open (a flip in Settings shows
   on the next open, no reload). Pre-selection (`setKind` from project
   defaults / last launch / `'claude'`) that lands on a hidden id falls back
   to the first visible card. `applyAvailability` untouched. Every pre-A4
   argv pin still holds (nothing hidden = byte-identical).
2. **Reopen (D3):** the v2 bag gains `run: string | null` (=
   `state.serverStartedAt` at save time). `loadUi({ reopen, run })`: when
   `!reopen && bag.run !== run` the views are discarded before validation
   (Home only); `leftPanel` / `filesWidth` are restored regardless. `main.ts`
   passes `getBehaviour().reopenTabs` and `st.state.serverStartedAt` (known:
   the runtime fetch precedes hydrate). Hostile `run` values (non-string)
   read as null = a different run.
3. **Confirm (⟲ above):** every door reads `getBehaviour().confirmEnd` at
   click time: `true` = today's arm; `false` = the act at once. `ArmedSet`
   and `armButton` are untouched — the door skips them. The B4 unsaved
   question still stands between the click and the act, in both modes.
4. **Follow output:** `onData` → `this.term.write(data, () => { if
   (getBehaviour().followOutput) this.term.scrollToBottom(); })`. Replay
   path unchanged.
5. **Tests:** `clampBehaviour` / `clampHiddenTools` over hostile bags
   (non-object, wrong types, unknown ids, all six hidden, duplicates); the
   grid without hidden cards and the fallback pre-selection; the bag's
   `run` round trip and the gate (same run keeps, other run drops, reopen on
   keeps); each door in both modes; the follow callback scrolls only when on.

## Phase 3 — the sticky port (`backend-pty`; after D5, after the phase 1 gate)

Files: `server/index.ts` (the port choice, ~:625-720), a small pure module
`server/last-port.ts` (NEW: read/write/gate), `tests/last-port.test.ts`
(NEW). Nothing in `web/`.

1. ⟲ `<dataDir>/last-port.json` (`{ "port": <n> }`, 0600, atomic write like
   the other data-dir files) is written right after `listening` with the
   port actually bound — by every run, a restart handoff's child included
   (same value). The scope doc's data-dir artifact list gains it at landing.
2. ⟲ At boot, when `AI_SM_PORT_HINT` is absent, the file's port becomes the
   hint through the SAME path the handoff hint takes (busy → auto-pick, the
   existing fallback). Precedence: env hint (a handoff) > the file > 0.
3. ⟲ Read gate: JSON object, `port` an integer 1024–65535, else ignored with
   one `debug` line (`last port file unreadable, auto-picking`) — never a
   crash, never a bind below 1024. A missing file is the normal first run.
4. ⟲ Log lines: `listening on the last port <n>` / `last port <n> busy,
   auto-picked <m>` — the existing hint messages keep their wording for the
   handoff case (they name the handoff).
5. ⟲ Not a security boundary: the file is the app's own, under the same
   0600-in-the-data-dir ceiling as `runtime.json`, and a port number is not
   a secret; a planted value is either bound (harmless, still 127.0.0.1 +
   token) or busy (auto-pick). Recorded in the module header.
6. Tests: the gate table (missing file, garbage, non-integer, 80, 70000,
   1024, 65535); write-then-read round trip in a temp data dir; the choice
   function (env hint wins over the file; the file wins over 0); a busy
   last port falls back (bind a `net` server on it first) — over the real
   boot script only where an existing test already spawns it (grep the port
   hint tests), else as unit tests of the module plus a source-shape pin
   that `index.ts` consults it.

## Amendments after the reviews (2026-09-22; they win over the items above)

- Phase 1: `checkNow()` shares an in-flight run (`runShared` in
  `server/update-release.ts`, the file list widened); the access log keeps
  `reason=` for ≥400 and gains `note=` for the one 2xx route
  (`responseNote`); the failure test models a failure.
- Phase 2a: the page's `Update` opens the confirm through a new source
  `'settings-update'` mapped straight to update mode (`'settings'` is
  hardcoded to restart mode in `ui/update.ts`); an `API keys` heading above
  the key rows; the live region is revealed before its text is set.
- Phase 2b: `armButton` gains `{ ask }` (one arm implementation, the door
  passes the predicate); `main.ts` awaits the runtime check before
  `loadUi`; an unknown run keeps the tabs and a known stamp is never
  overwritten with null; the restart / update reload re-stamps the bag with
  the child's `startedAt` (`st.setRunStamp`) before `location.reload()`, so
  D3's "restart keeps" holds; `checkForUpdates` sits below `startUpdate`.
- Known, spec-true: the hidden-card fallback may select an inert card for
  one `/api/tools` round trip; `applyAvailability` then moves on.
- Phase 3: `readLastPort` opens `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and judges
  the fd (`isFile`, size ≤ 1 KiB) before reading — a planted FIFO or
  `/dev/zero` link hung the boot (the B1 FIFO lesson, measured again); a
  symlink is refused (the app wrote the file itself). Item 1's "by every
  run" is amended: a run whose REMEMBERED port fell back does NOT overwrite
  the file (`…, keeping <n> for next time`) — a transient squatter must not
  move the origin for good; a handoff hint that fell back still writes.
  README, `theme.ts`, `restart.ts` and the launcher docs lose their
  "auto-picked every run" sentences.

## Gates

- Phase 0 (orchestrator): protocol, `api.checkForUpdates`, `prefs-model.ts`
  + wiring, `npm run typecheck`.
- Phases 1, 2a and 2b run in PARALLEL (disjoint files; `main.ts` split by
  call site as listed); phase 3 after the phase 1 gate (same files). Per phase: readers (scope always; security on phase
  1 only) → ONE fix round → test gate (phase 1 = full mutation probe on the
  route's gates; 2a / 2b ≤ ~10 mutants each).
- Final: full suite once by the orchestrator, `/verify-terminal` scoped to
  "follow output on: a streaming pane stays at the bottom while the user
  scrolled up; off: it does not move; ending a session with confirm off
  takes one click and the PTY is gone; two live panes beside the Settings
  dialog: zero resize / attach lines while toggling", janitor, the Windows
  checklist for the user (hide Codex → the dialog grid; Reopen ON → close the
  app, start it from the shortcut → the file tabs are back on the same port;
  Reopen off → the same → Home, and F5 / Restart service keep them; Confirm off → one click; Follow on with
  a long `ls -R`; Check for updates on the installed build).
- Landing: this Status line, the table row, the README index line, the scope
  doc's App-settings bullet (the "mock until B6" sentences, the Keys-section
  sentence, the new prefs keys and route), the vault log entry + decision
  note, commit + push, CI watched to green.
