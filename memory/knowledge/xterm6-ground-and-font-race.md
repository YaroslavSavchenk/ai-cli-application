---
type: knowledge
created: 2026-09-13
updated: 2026-09-13
tags: [frontend, terminal, xterm, fonts, gotcha]
---
# xterm 6: the viewport paints #000 over your padding; fonts must be loaded BEFORE the first draw

Found in [[2026-09-13-nocturne-a4b]]; sits beside [[frontend-terminal-quirks]]
and [[google-fonts-subset-trap]].

- **`.xterm-viewport` is an empty div, absolute inset 0, `#000` from
  `xterm.css`.** In 6.0.0 the runtime sets the theme background only on
  `.xterm-scrollable-element` (content box); the viewport div still covers
  `.xterm`'s PADDING box with `#000`. Any padding on `.xterm` shows as a black
  frame. Repaint it in your own stylesheet with the same token as the ground.
  A test scans the INSTALLED `node_modules/@xterm/xterm/css/xterm.css` for
  every `background(-color): #000` selector, so an xterm bump that adds a new
  black surface fails a test instead of a screenshot. `.composition-view` (IME
  pre-edit popup) is `#000`/`#FFF` on purpose — leave it.
- **Diagnose with pixels, not selectors**: screenshot, sample 4 px inside each
  `.term-host` edge, per layout and after a resize; `getComputedStyle` of
  every ancestor of the canvas tells which node carries the colour.
- **Nothing waits for a web font before xterm measures the cell.** With
  `font-display: swap` the first `TerminalView` measures the fallback
  (Cascadia Mono on Windows): wrong glyphs AND wrong cell width, so the
  cols/rows sent to the PTY are wrong (`217x52` vs `217x46`) until a reload.
  Fix in two halves: `document.fonts.load()` for the weights the terminal
  draws (400 + `fontWeightBold` = 700), bounded (1.5 s), skipped when
  `check()` is already true; plus a `loadingdone` watcher that repairs views
  built without the face.
- **xterm's OptionsService drops a write of an EQUAL value** (`rawOptions[k]
  !== value`), so re-setting the same `fontFamily` fires no option-change →
  no `CharSizeService.measure()` → the cell keeps the fallback width. Re-spell
  the stack with one trailing space (identical to the CSS parser, different
  to `!==`), then `clearTextureAtlas()`, then the ONE existing fit path.
- **A throwing `FontFaceSet.check()` must not read as "loaded"**: it silently
  skipped the wait, latched the watcher off, and logged nothing. Give it its
  own outcome (`'unparseable'`), log it, keep the watcher armed.
- **A boot gate that can wait must be a boot-panel row**, or the panel removes
  itself and the user sees a blank window for the length of the wait. Catch
  the gate's promise at its source: an `await` outside every `try` in
  `boot()` ends on a bare unhandledrejection with no shell built.
- Boot-panel labels need `white-space: nowrap` — a failed row's message shares
  the row and squeezes a two-word label onto two lines.
