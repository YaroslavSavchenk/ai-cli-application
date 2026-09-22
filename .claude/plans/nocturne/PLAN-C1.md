# C1 — Peek mascot: a small Claude peeks around the edge of the screen when a session is done or asks you something

Status: LANDED 2026-09-22 (the landing commit; suite 3452 → 3537; paused halfway while a second session landed B12 in the same checkout; phase 2+4 and phase 3 each: scope + security (clean ×2), one fix round; 78 mutants / 6 equivalent; verify-terminal M1–M6 PASS with a real claude session; the overlay window itself is the user's Windows check; log `memory/log/2026-09/nocturne/2026-09-22-nocturne-c1.md`); earlier: STARTED 2026-09-22 (user: "Begin aan C1 nu en daarna gaan wij hem releasen"; open decisions 12–16 of `.claude/plans/PLAN-NOCTURNE.md` asked and answered before the developers started, below; phase 1 — the standalone page — landed 2026-09-15, `memory/log/2026-09/ui/2026-09-15-peek-mascot-phase1.md`).

Part C1 of `.claude/plans/PLAN-NOCTURNE.md`. Conventions: `.claude/plans/README.md`.

## What the user gets

When a Claude session finishes its turn or asks something, and the user has
not looked at that session yet, a small pixel-art Claude (the user's own
design, `design/peek-mascot/README.md`, 1:1 — phase 1 built it as
`web/mascot.html`) peeks around the RIGHT edge of the monitor the app window
is on — outside the app window, over other programs, borderless fullscreen
games and video. One mascot per such session, at most 3. Clicking one makes
it laugh or wave, then brings the app to the front on that session — which
counts as looking, so it leaves. A switch in Settings → Preferences turns it
off (on by default).

## Decided (user, 2026-09-22) — do not re-ask

- **Decision 14, count:** a session counts once Claude ENDS ITS TURN (the B11
  readout goes working → waiting) OR rings the bell (BEL, `attention`), and
  stops counting once the user LOOKS at it — the same "look" that acks a BEL
  today (that pane focused with the app window in front, or the `seen` ack).
  At most 3 mascots.
- **Decision 12, monitor:** the monitor the APP WINDOW is on (the main
  form's screen, also when minimised — its last screen).
- **Decision 13, click:** the design's reaction (laugh or wave), then the app
  comes to the front on that session.
- **Toggle:** Settings → Preferences, default ON.
- **Decision 15:** the exclusive-fullscreen limit is accepted (recorded as a
  known limit; borderless / optimised fullscreen and video work).
- **Decision 16, reduced motion:** the same art at the same place, no
  movement — no slide-in, bob, blink, shove, strain, laugh or wave motion
  (a click still swaps the face / arm for the reaction's duration).

## The signal (phase 2, server + main page)

- **`SessionInfo.turnUnseen?: boolean`** — set by the server when a session's
  `turn` goes `'working'` → `'waiting'` (NOT on a first readout of
  `'waiting'`: a fresh session at its first prompt, or the backend's first
  read of an old transcript, is not news). Cleared by the `seen` ack (WS
  `{type:'seen'}` and `POST /api/sessions/:id/seen` — both already clear
  `attention`), by the turn going back to `'working'`, and at exit. Never
  set for a session without a turn readout.
- **`SessionInfo.pendingSince?: string`** (ISO) — when the session last
  became pending (`attention || turnUnseen` false → true); absent while
  neither is set. Orders the mascots (oldest = slot 0).
- **The main page acks it like a BEL:** wherever the client clears
  `attention` because the user looks at the pane (`clearAttentionIfPending`
  and its callers in `web/src/ui/panes.ts`: focus with the window in front,
  window regaining focus on a focused pane, attach), it also clears
  `turnUnseen`. A turn that ends in the pane the user is looking at is
  acked at once and never shows a mascot.
- **Attention semantics stay BEL-only** (B11): the statusline, the Sessions
  badge, the tab's `Needs you` pill never count `turnUnseen`. Only the
  mascot does.

## The page (phase 2, `web/mascot.html` + `web/src/mascot/*`)

- Served with the auth-token placeholder replaced like `index.html`
  (`server/api.ts` serves `/mascot.html` today WITHOUT a token — that
  changes; the page now reads `/api/sessions` and `/api/prefs`). Same
  no-store, same frame-protection headers.
- Polls `GET /api/sessions` every 2 s (like the app). Pending = running,
  `attention || turnUnseen`, ordered by `pendingSince`; count = min(3, n).
  A RISE in count is applied only after it held for 1.5 s (a turn that ends
  in the pane the user is looking at is acked within that window, so no
  flash); a fall applies at once.
- Reads `prefs.mascot?.enabled` (absent = ON) each poll; off → count 0.
- Reports to the host (`window.chrome.webview.postMessage`, a STRING, JSON):
  `{"type":"mascot-count","count":N}` on every change, and — after a click's
  reaction has played (1300/1400 ms) — `{"type":"mascot-open","session":"<id>"}`
  for that slot's session. No host (plain browser) → nothing is posted; the
  page still works for `?demo`.
- The `?demo` strip stays URL-gated; the host never adds a query string.
- Reduced motion (decision 16): `@media (prefers-reduced-motion: reduce)`
  removes every animation in `mascot.css`; entrance = appear in place.

## The toggle (phase 4)

`UiPrefs.mascot?: { enabled: boolean }` in `prefs.json` (server-side like
every durable preference; the server's prefs handling accepts the key — check
whether it whitelists). Settings → Preferences row: "Peek mascot — show when
a session is done or asks you something" (copy may be tightened by the
designer; no code words). Absent = on.

## The window (phase 3, Windows host `launcher/host/AiSessionManagerHost.cs`)

- A second borderless form in the SAME host process: `TopMost`,
  `WS_EX_TOOLWINDOW` (no taskbar button, not in Alt-Tab), `WS_EX_NOACTIVATE`
  (a click never steals focus from a game — the click still reaches the
  page), `ShowWithoutActivation`. Transparent WebView2
  (`DefaultBackgroundColor = Transparent`) on `/mascot.html` (no query),
  its own controller in the same environment/profile.
- 220 × 340 px at the RIGHT edge of the working area of the main form's
  screen (`Screen.FromHandle(mainForm.Handle)`), vertically centred;
  re-placed on every show and when the main form moves to another screen.
  DPI-aware like the main form.
- **Hidden while count is 0** or the toggle is off (the page reports 0) — a
  hidden overlay eats no clicks. While shown, clicks on its TRANSPARENT
  parts must pass through to the window below: the page reports the mascots'
  client rects with the count (`"rects":[[x,y,w,h],…]`, CSS px) and the host
  sets a window region (`SetWindowRgn`, scaled by DPI) to their union. The
  developer may pick another mechanism with the same result.
- **Messages:** the overlay's `WebMessageReceived` gets the SAME origin lock
  as the main window (exact launch origin, string messages only, unknown
  types logged and dropped). `mascot-open` with a session id of the UUID
  shape → restore + activate the main form (`SetForegroundWindow` is allowed:
  the host process just received the user's click) and post
  `{"type":"focus-session","session":"<id>"}` to the MAIN WebView2.
- **The main page** handles `focus-session` (from the host only — the
  existing host-message channel and its origin checks): switch to the tab
  holding that session and focus its pane (which then acks it). A session no
  longer present → nothing.
- Navigation lock, permission denials, new-window handling, dev tools off —
  as the main window. The overlay closes with the host.
- Browser dev mode (no host): no overlay; `?demo` is the preview.

## Known limits (recorded)

- A game in true exclusive fullscreen cannot be drawn over by any window
  (decision 15).
- Claude Code's permission prompt writes nothing to the transcript — it
  shows a mascot only through its BEL (B11's limit).

## Files

Phase 2 — backend (`backend-pty`): `shared/protocol.ts` (`turnUnseen`,
`pendingSince`, `UiPrefs.mascot`), `server/sessions.ts` (set on the
working → waiting transition in `setReport`, clear in the seen paths, on
working, at exit; `pendingSince`), `server/ws.ts` / `server/api.ts` (seen
clears both; `/mascot.html` gets the token placeholder), prefs if
whitelisted. Tests beside the existing seen / setReport / serveStatic tests.

Phase 2 + 4 — frontend (`terminal-ui`): `web/src/ui/panes.ts` (ack
`turnUnseen` with `attention`), `web/src/mascot/{main,model,view}.ts` +
`mascot.css` (poll, pending list, 1.5 s rise debounce, prefs, host
messages with rects, reduced motion), `web/mascot.html` (token placeholder),
`web/src/ui/settings.ts` (the Preferences row), the main page's
`focus-session` handler (where host messages are received today). Tests.

Phase 3 — host (`wsl-launcher`): `launcher/host/AiSessionManagerHost.cs`
(the overlay form, region, messages, `focus-session` post), built with
`launcher/build-host.ps1` from WSL through `powershell.exe`.

## Phases (order 2 → 4 → 3, as the plan says)

1. Phase 2 + 4 in parallel: `backend-pty` and `terminal-ui` on the frozen
   names above. Reviews: `scope-reviewer`, `security-auditor` (a second
   page now carries the token; the seen paths), `test-engineer`. One fix
   round, one test gate.
2. Phase 3: `wsl-launcher`. Reviews: `scope-reviewer`, `security-auditor`
   (a new host window, a new message type that activates the main window).
   The orchestrator builds the host.
3. Final gate: `janitor`; `/verify-terminal` scoped (the ack path: a turn
   ending in the focused pane shows no mascot, one in a background tab does;
   V1 unchanged); the page on a scratch backend in a browser (count from real
   sessions, prefs off → 0, reduced motion). The overlay itself is a Windows
   check.
4. Windows check owed to the user: a Claude session in a background tab (or
   the app behind another program) finishes → a mascot at the right edge of
   the app's monitor within ~4 s; click → laugh or wave, app comes forward on
   that session, mascot leaves; three sessions → three mascots + strain;
   Settings → Preferences off → none; clicks next to a mascot reach the
   window below.

## Gates

- `npm run typecheck`, `npm run build`, `npm test` green (baseline 3452).
- No new dependency, no env var, no new top-level folder.
- `attention` semantics unchanged; no mascot for a session the user is
  looking at.

## Amendments after the reviews (2026-09-22; they win over the items above)

- **Never hidden — an empty region instead** (host developer, accepted by
  scope): `Form.Hide()` makes the WebView2 hidden, and after 5 min Chromium's
  intensive throttling runs the page's 2 s poll once a minute. The overlay
  is shown once without activation and its window region is empty while the
  count is 0 — it draws nothing and takes no clicks.
- **No DPI awareness in v1** (same as the main window): scale 1; on a >100 %
  monitor Windows bitmap-scales the overlay, the art may look soft, and the
  region's alignment there is a Windows check.
- **Transparency via `TransparencyKey`** over the WebView2 child — the
  biggest unknown; a Windows check.
- **No owner window**, so the overlay stays up while the app is minimised
  (decision 12).
- **Fix round:** a crashed / unresponsive mascot page is reloaded (capped);
  display-setting changes re-place the overlay; a stored `mascot` of the
  wrong shape is dropped by the client before a prefs save, so a hand-edited
  `prefs.json` cannot block every other preference.
- **Windows-check contingencies (not settled here):** if `mascot-open`
  cannot bring the app to the front (WebView2's input windows belong to
  another process, so Windows may refuse the foreground change), the user
  chooses between the host forcing it and the page signalling at click
  time; if the region misaligns at 125/150 %, the page reports its viewport
  size.
- **Decision 14 changed on the Windows check** (user, 2026-09-22: "hij mag
  niet zomaar verdwijnen. Alleen als de sessie weer aan het werk gaat of
  wanneer ik een sessie afsluit. zelfs met open app moet dit gebeuren"): a
  finished Claude turn shows a mascot even with the app open and in front,
  and it stays until that session WORKS again or ends — looking at the pane
  or clicking the mascot no longer sends it away (the click still brings the
  app to that session). The flag is renamed `turnUnseen` → `turnEnded`
  (set on working → waiting, cleared only by working and at exit, never by
  `seen`). A BEL (`attention`) keeps the look-ack.

