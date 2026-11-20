# D8 — The mascot steps back while the app is the window you are in

Status: LANDED 2026-11-20 on branch `d8-mascot-steps-back` (awaiting the host rebuild + the user's DEV check on Windows); earlier: DECIDED 2026-11-20 (the user's ask the same day — "maak ook zo dat wanneer de app open is mascotte niet zichtbaar is, dat hij verwijnt, kleine effect"; decision 24 of `.claude/plans/PLAN-NOCTURNE.md` asked the same day).

Part D8 of `.claude/plans/PLAN-NOCTURNE.md` (Track D, fixes and asks after the v0.4.0 release). Conventions: `.claude/plans/README.md`.

## What the user gets

- While the **app window is the active (foreground) window**, no peek mascot shows. A mascot that is out when the app becomes active **slides back behind the screen edge** it peeks from, in about 250 ms with a short fade at the end — the peek in reverse.
- When another program becomes active and a session is still pending, the mascots **peek out again** (the normal entrance).
- Everything else about when a mascot exists stays as C1/C2 decided: one per pending session, max 3, kept until that session works again or ends. D8 only decides whether an existing mascot is *visible*. A session that becomes pending while the app is active shows nothing until the user leaves the app.
- A click on a mascot still plays its reaction and then brings the app to the front on that session; the app becoming active then sends every mascot back (the reaction is not cut short: the retreat starts when the reaction has ended).
- Reduced motion (decision 16): no slide — the mascots go and come without motion.

## Found 2026-11-20 (line numbers drift)

- The host already watches foreground changes: `SetWinEventHook(EVENT_SYSTEM_FOREGROUND)` → `Foreground_Changed(hook, eventType, hwnd, …)` (`launcher/host/AiSessionManagerHost-overlay-window.cs` ~:329). Today it only re-raises the overlay (`RaiseOverlay`, plus a 500 ms late raise) and returns early when `_overlayRects == null`.
- The main window is `_form` (`launcher/host/AiSessionManagerHost.cs` ~:147, built in `BuildForm` ~:254). The overlay is `_overlay` (`MascotOverlayForm`, shown without activation — it never becomes the foreground window itself).
- Page → host: `OverlayWebView_WebMessageReceived` (`…-overlay-window.cs` ~:114) parses STRING messages `mascot-count` / `mascot-open` with fixed regexes; anything else is logged and ignored. Host → page: nothing today (the main view gets clipboard replies via `PostWebMessageAsString`, `…-clipboard.cs` ~:297).
- The page: `web/src/mascot/main.ts` (entry; `?demo` mode with a control strip), `feed.ts` (2 s poll + `HostReporter`, which posts `mascot-count` with the rects), `model.ts` (pure count/reaction model), `view.ts` (DOM; entrance animation, `.pm-pos` bottom/right transition .7s, `prefers-reduced-motion` drops every animation/transition), `mascot.css`.
- The overlay's input region is the union of the reported rects (`ApplyOverlayRegion`); count 0 / no rects = empty region (fully click-through).

## Decided (user, 2026-11-20) — do not re-ask

1. "Open" = the app window is the ACTIVE (foreground) window. Another program in front of a visible app window counts as not active (decision 24).
2. The effect: slide back behind the screen edge, ~250 ms, short fade; reverse on return (decision 24).
3. This replaces decision 14's "shown even with the app in front" for visibility only; the counting rules of C1/C2 stay.

## Defaults (orchestrator, within the decisions — not asked)

- **The host tells, the page animates.** The host owns the truth (it sees the foreground); the page owns the motion (CSS) and keeps reporting rects as today.
- **Active** = the foreground hwnd is `_form.Handle`, or a window whose root owner (`GetAncestor(hwnd, GA_ROOTOWNER)`) is `_form.Handle` (a dialog/menu of the app). The overlay never counts (it never activates).
- **Initial state**: the host posts the current state once the overlay page has loaded (its `NavigationCompleted`, success) and on every foreground change where the state CHANGES (no duplicate posts). Until the page hears anything it assumes NOT active (today's behaviour).
- **Rects while hidden**: when the retreat has finished the page reports `mascot-count` with its real count and EMPTY rects (`"rects":[]`) — so the region is empty and nothing invisible blocks clicks; on return it reports the rects again BEFORE the entrance starts, so the region is there when the mascot slides in. The host already treats "a count without a usable rect" as nothing to show.
- **Retreat motion**: `transform: translateX(<off the right edge>)`, 250 ms ease-in, opacity to 0 over the last 100 ms. The return reuses the existing entrance. As built: the animation runs on the shared `.pm-stage` (no render writes to it, so the slide never fights the inline entrance animations), not on each mascot's outer element; while it runs the page reports the whole stage as rects.
- **A reaction in progress** (the click laugh/wave) finishes first; the retreat starts after it.
- **`?demo`**: the control strip gains an "App active" toggle that drives the same code path.

## Frozen contract

Host → page, a STRING via `CoreWebView2.PostWebMessageAsString` on the overlay view:

```
{"type":"app-active","active":true}
{"type":"app-active","active":false}
```

Exactly these two strings (no spaces). The page accepts only a string whose JSON parse is an object with `type === "app-active"` and a boolean `active`; anything else is ignored. Page → host is unchanged (`mascot-count` with `"rects":[]` already parses; the host regex must keep accepting an empty list — test it).

## Files (expected; the developer confirms)

- Host (wsl-launcher): `launcher/host/AiSessionManagerHost-overlay-window.cs` (foreground → active state, post on change), possibly `…-overlay.cs` (NavigationCompleted hook). Source-scan tests under `tests/release/` (`host-*.test.ts`, helpers in `tests/helpers/host-sources.ts`).
- Page (terminal-ui): `web/src/mascot/{main,feed,model,view}.ts`, `mascot.css`; tests under `tests/ui/` (existing mascot tests: `grep -l mascot tests/ui`).
- Docs: `.claude/PROJECT-SCOPE.md` § Peek mascot, `memory/decisions/c1-peek-mascot.md`.

## Phases

1. Host and page in parallel against the frozen contract (disjoint files).
2. Review (scope, security — the host parses/creates webview messages, tests), one fix round, test-gate.
3. Host rebuild on Windows + DEV check by the user (only a real Windows session can show it).

## Out of scope

- Hiding when the app window is merely visible but another program is active (rejected, decision 24).
- Any change to which sessions count, the click behaviour, the max of 3, or the mascot toggle in Settings.
