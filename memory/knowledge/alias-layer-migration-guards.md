---
type: knowledge
created: 2026-09-14
updated: 2026-09-14
tags: [css, tokens, testing, nocturne, process]
---
# Deleting a token alias layer: survivors first, regions in parallel, guards last

Learned in [[2026-09-14-nocturne-a8]] (the `LEGACY ALIAS LAYER` in
`web/src/styles/tokens.css` — 84 Legacy role-token names re-pointed at
Nocturne values since A1 — migrated off and deleted; 558 `var()` references
at the start).

**Three phases, not one.** (0) Move every token that SURVIVES the deletion
above the marker first, as its own mechanical change with a resolved-value
diff of zero (structure sizes, fonts, motion, z, the xterm palette, data
tables such as the badge chips, plus anything TS reads at runtime — grep
`cssVar(`/`getPropertyValue(`/`setProperty(` for `--` names: `--fs-term` was
read by `terminal.ts` and sat below the marker; deleting the block blind
would have set the terminal font size to `NaN`). (1) Two developers on
disjoint stylesheet regions and disjoint TS files, the token file owned by
ONE of them; the other spells literal px or `calc()` of surviving tokens and
lists wishes. (2) One developer deletes the block and writes the guard.

**What the guard must pin** (`tests/ui-a8-tokens.test.ts`): (a) the marker
text exists nowhere; (b) every `var(--x)` in CSS and every CSSOM-wrapped
`'--x'` string in TS is declared; (c) every declared token has a reader,
with an allow-list that asserts each entry is still declared AND still
unread (the handoff ramp steps transcribed verbatim); (d) every retired
name — taken from `git show HEAD:tokens.css`, not from memory — is declared
nowhere and read nowhere; (e) non-vacuity floors. Strip comments in EVERY
file the scanners read, and walk only `.ts/.css/.html` (a woff2 read as
UTF-8 is a "reader" of anything).

**The proof of "no visual change" is a resolved-value diff per selector**:
expand every `var()` recursively against each version's own tokens.css,
compare per selector per property, and every changed declaration must
belong to a named deliberate group (the redesigned surfaces, the scrim
colour). Both the developer and the scope reviewer ran it independently
and matched.

**Class-parity scanners lie in two ways** (mutant testing found both):
a scanner over the WHOLE stylesheet counts a `@media` refinement
(`.sc-cap { padding-left: 0 }`) as "styled", so deleting the base rule
survives — require a rule OUTSIDE every `@media` block
(`tests/ui-a8-block-rules.test.ts`); and a regex that only reads
single-quoted `el('div', 'name')` misses template-literal class names, so
scan the backtick form too, with a brace-counting interpolation strip
(otherwise `${n > 0 ? 'x' : 'y'}` shreds into `0`, `>`, `?` "classes").

**A class can be a contract, not a style.** `.modal-scrim` looked like a
Legacy name to rename; it is the selector `ui/keys.ts` uses to know a
dialog owns the keyboard, worn by six dialogs beside their own prefix. Grep
TS for a class before renaming it in a brief.

**Structural tokens keep their names.** Renaming `--line` (118 uses) or
`--font-mono` (43) to fit a naming scheme is churn without value; the
Legacy *colour roles* and *scales* (`--text-*`, `--edge-*`, `--s-*`,
`--fs-*`, `--r-*`) are what die, replaced by primitives, `--space-*`,
`--radius-*` and literal px font sizes (the idiom the A2–A7 blocks set).
