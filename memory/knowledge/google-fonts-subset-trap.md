---
type: knowledge
created: 2026-09-10
updated: 2026-09-10
tags: [fonts, frontend, gotcha]
---
# Google Fonts serves per-script subsets with near-identical URLs — latin-ext has NO ASCII

2026-09-10 incident (A1 of [[nocturne-full-switch]]): the Inter woff2 shipped
for the UI was Google's **latin-ext** subset (733 glyphs, 85 KB) instead of
**latin** (230 glyphs, 48 KB). latin-ext carries only the extended range —
not a single ASCII letter — so every chrome string silently fell back to
`system-ui` while `document.fonts` happily reported "Inter loaded". Cause: a
`grep -B3 "/* latin */"` on Google's CSS caught the `src:` line of the block
ABOVE (latin-ext); the URLs differ by a few characters
(`…SjIa25L7SUc.woff2` vs `…SjIa1ZL7.woff2`).

Lessons:
- "Font loaded" ≠ "font renders". Prove it per glyph: fontTools
  `getBestCmap()` contains `A–Z`, or a canvas `measureText` in the face vs
  `system-ui` differs.
- Pin shipped font assets by byte size + sha256 in a test
  (`tests/nocturne-tokens.test.ts`, A1 (d3)) — a wrong subset is otherwise
  invisible to every gate.
- Google's `unicode-range` for latin omits `←→✓⚙▸`; those fall back to the
  system font, same as with Barlow before.
- xterm.js `css.toColor` accepts hex/rgb()/rgba() only; `oklch()` and
  `color-mix()` must be pre-converted to hex for the `--xt-*` tokens.
