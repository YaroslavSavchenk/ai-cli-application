---
type: decision
created: 2026-09-22
updated: 2026-09-22
tags: [nocturne, settings, preferences, update, keyboard]
---
# B6: Settings live — tools, defaults, the keyboard page, check for updates

**Status:** decided 2026-09-22 (user: "continue werken aan de app" — B6 was
the next row of the status table; four questions asked before the developer
started). Part B6 of `.claude/plans/PLAN-NOCTURNE.md`; spec
`.claude/plans/nocturne/PLAN-B6.md`.

## 1. Any card can be hidden, at least one stays (user)
Preferences gets a `Tools` block with one toggle per card of the New session
dialog (Claude Code, Codex, Gemini CLI, Grok, Terminal, Other). A hidden
card is absent from the dialog's grid; hiding the last visible one is refused
in place with `Keep at least one tool visible.` Running sessions are
untouched; the key rows stay for hidden tools (a key is about the tool, not
the card). Persisted as `prefs.tools.hidden` (card ids), clamped on read.
- Rejected: only the four AI tools hideable (Terminal and Other always
  shown).

## 2. The notifications row is dropped until C1 (user)
No notification mechanism in B6. The mock row `Notifications when a session
needs you` goes; the in-app `Needs you` pill and the pane badge stay
unconditional. The peek mascot's own toggle (C1 phase 4) takes the row's
place later.
- Rejected for now: the browser Notification API through the WebView2 host
  (a host permission grant + a Windows toast per waiting session; the AUMID
  question of [[native-webview2-host]] would return for the toast's icon).

## 3. `Reopen tabs on start` off applies only to a NEW app start (user)
A fresh backend run starts on Home; a reload within the same run (F5, the
reload after `Restart service` or an update) keeps the layout. Keyed on the
backend's start time, written into the localStorage bag as `run` at save
time and compared at load. What the switch decides on a new run is only
what the bag still holds — sessions never survive a run: the editor and
folder tabs, the empty views, their names, order and the active one. The
Files panel's open state and width are panel wishes, restored either way.
- Rejected: every page load starts on Home (the user would land on Home
  after every restart or update).

## 4. `Check for updates` checks now and answers on the page (user)
`POST /api/update/check` runs the backend's existing GitHub release check at
once (a check in flight is shared, never doubled) and answers the composed
status `GET /api/runtime` carries. The Background service page answers in
one line: `You have the newest version.` / `Version <tag> is available.`
with the same `Update` act as the toast / `A new version is installed.
Restart the service to use it.` / `Could not check for updates.` Hidden
when the app is not installed, as before. After the answer the page
re-fetches the runtime through the ONE existing path, so the pill and the
toast agree.
- Rejected: keep opening the GitHub releases page in the browser.

## 5. The backend keeps its port across app starts (user, after the 2b review)
The tab layout lives in localStorage, tied to the origin INCLUDING the port;
a fresh start auto-picked a new port ([[localstorage-origin-port-churn]]),
so the layout was gone whatever decision 3 said, and the only run-crossing
case that kept the bag (the same-port restart handoff,
[[backend-restart-same-port]]) was the one decision 3 keeps — the switch
would have been invisible. Decided: `<dataDir>/last-port.json`, tried first
on every start through the existing hint path, auto-pick only when taken
([[auto-port-discovery]] amended: auto-pick is now the fallback). ON then
restores file tabs and views after a fresh app start (new); OFF starts on
Home after a fresh start and keeps the layout on F5 and after `Restart
service`.
- Rejected: the switch governing restarts only (a fresh start always Home);
  dropping the row until the layout is stored server-side.

## Orchestrator defaults (recorded, each a cheap flip)
- Prefs keys `behaviour` (`reopenTabs` / `confirmEnd` / `followOutput`,
  factory true / true / false) and `tools` (`hidden`) — never `defaults`,
  a dead key the client prunes ([[pane-status-bar-data-source]] era
  cleanup). The server keeps the bag opaque; the client clamps.
- `Confirm before ending a session` = the existing armed two-step on every
  door that ends a session (tab `×`, drawer `×`, pane end button, the exited
  banner); off = one click. The B4 unsaved-text question is never switched
  off ([[b4-editor-live]] D1).
- `Follow output` on = every write ends at the bottom, even after scrolling
  up; off = xterm's own rule. Read on every write, so a flip reaches running
  sessions.
- The Keyboard page draws the whole shortcuts table from ONE data module
  (`ui/shortcuts-rows.ts`) shared with the overlay; the hand-copied excerpt
  and the `all shortcuts` link go.
- Copy: v3's row labels; Preferences lead `Your tools and how the app
  behaves.`; the Tools lead `Cards shown in the New session dialog.`
