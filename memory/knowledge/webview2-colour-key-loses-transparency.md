---
type: knowledge
created: 2026-09-26
updated: 2026-09-26
tags: [windows, webview2, overlay, transparency, directcomposition, mascot]
---
# A colour-keyed WebView2 overlay loses its transparency after one resize

**Symptom (user, 2026-09-26):** "mascotte krijgt af en toe zwarte
achtergrond". The C1 peek mascot sometimes showed a black box around it,
and the box stayed until the app restarted.

**Setup that fails:** a WinForms form with `TransparencyKey` (so layered
with `LWA_COLORKEY`) around a WinForms `WebView2` control with
`DefaultBackgroundColor = Transparent`. Chromium's child window
(`Chrome_WidgetWin_1`) is `WS_EX_NOREDIRECTIONBITMAP`, which means it draws
with DirectComposition. The page's transparent pixels only look transparent
because what lies under them in the form's redirection surface happens to
be the key colour.

**Proof (probe on the user's machine, 2026-09-26):** a pure-green topmost
backdrop under a probe overlay built the same way, with a page showing one
orange square. After each trigger a `BitBlt` of the screen (with
`CAPTUREBLT`) was classified pixel by pixel:

- first show: green around the square (transparent);
- after ONE resize of the form (+1 px, then back): opaque (white in the
  capture), for good;
- move, hide/show, controller visible toggle, region empty→full and reload
  never brought it back.

The host resizes and moves the overlay in `PlaceOverlay()` on every
`DisplaySettingsChanged` / work-area / DPI change. A game switching
resolution, a monitor waking or a taskbar change are all enough.

**What works:** WebView2 VISUAL HOSTING. That is a
`CoreWebView2CompositionController` on a form with
`WS_EX_NOREDIRECTIONBITMAP` (not layered, no key colour, painting nothing),
plus a DirectComposition device, a target for the form (`topmost: true`)
and a root visual set as `RootVisualTarget`. The same probe stayed green
through every trigger. The host then forwards mouse input itself
(`SendMouseInput`) and applies `CursorChanged`. The window region still
clips drawing and clicks.

**Related gotchas found on the way:**

- WinForms ACTIVATES a form whose `TopMost` property is set when it is
  shown, even with `ShowWithoutActivation`. Set `WS_EX_TOPMOST` in
  `CreateParams` instead.
- Under visual hosting the page can first lay out at the WebView's
  pre-bounds size (seen 1281×1392) and get its real size about 60 ms later.
  So a page that reports geometry must report again on `resize`.
- With `ShouldDetectMonitorScaleChanges` left on, a DPI-unaware host gets
  the monitor scale as its rasterization scale. Pin it to the host's own
  scale (1.0 here).
- **Visual hosting brings its own trap:** msedgewebview2 creates a
  TOP-LEVEL `Chrome_WidgetWin_1` at the controller's bounds. It is layered
  with alpha 0, NOACTIVATE, not topmost and WITHOUT `WS_EX_TRANSPARENT`, so
  it swallows clicks for every window below it in that rect (open bug
  WebView2Feedback #5668). The host ORs `WS_EX_TRANSPARENT` into exactly
  that window: the browser pid, the class, LAYERED+NOACTIVATE and the
  bounds must all match. It is found by a `probe.ps1`-style z-order dump,
  not by looking at the screen.
- The probe technique itself (a known-colour backdrop, then a screen
  `BitBlt`, then pixel classes) is reusable for any "is this window really
  transparent" question. Without `CAPTUREBLT`,
  `Graphics.CopyFromScreen(…, SourceCopy | CaptureBlt)` throws
  `InvalidEnumArgumentException`; use `BitBlt` via P/Invoke.

Fix landed on branch `mascot-detection` (PLAN-C1 § Fix after release).
Related: [[c1-peek-mascot]], [[native-webview2-host]].
