---
type: knowledge
created: 2026-09-13
updated: 2026-09-13
tags: [process, frontend, css, testing, nocturne]
---
# Two developers on one stylesheet, and the seams that bite

Learned in [[2026-09-13-nocturne-a7]] (Settings modal and Add-a-project
dialog built in parallel by two `terminal-ui` agents, both editing
`web/src/styles/app.css`).

**What worked.** Assign each developer a REGION of the stylesheet by block
header (replace the old block in place), a disjoint set of TS files, and
tell each one which files the other owns. Non-overlapping `Edit` calls on one
file do not collide; both agents' builds and test runs coexisted. Line
numbers in their reports drift while the other half edits above them, so
briefs and findings should anchor on block headers and class names, not
line numbers.

**Seam 1: a shared rule deleted by one half because the other half "moved
off it".** Half (a) deleted the Legacy `.status-row/-box/-lb/-sample` family
after grepping that half (b) had no users left; true at that moment, but only
because half (b) had already landed. A whole-stylesheet, whole-`web/src`
class-parity test (`tests/ui/ui-a7-parity.test.ts`: every prefixed class set
in TS has a rule, every rule has a setter, deleted names have zero users)
is what makes such a deletion safe after the fact. Add that test in the
same part, not in the gate part.

**Seam 2: a dialog that opens FROM the restyled dialog.** The plan said
"restyle the Add-a-project dialog"; nobody owned the folder picker it opens,
so Browse opened a Legacy dialog over a Nocturne one. When a part restyles a
surface, list its child dialogs in the brief (picker, confirmations) or
assign them explicitly.

**Seam 3: a mock that hardcodes another surface's table.** The Preferences
mock hand-copied the tool cards' marks and labels; review caught the drift
risk. Mock rows that mirror a real table import it.

**fake-dom gotcha.** `tests/helpers/fake-dom.ts` `click()` dispatches to `disabled`
controls (the real DOM does not), so a "disabled until X" defence needs the
same invariant in the handler (`if (chosen === '') return;`) to be
assertable, and the fake's `focus()` on a disabled element is a no-op like
the real one, so initial focus must land on an enabled control.

**Copy pass stops at error lines.** Both halves restyled every visible string
except the inline validation errors, which kept the Legacy lowercase
fragment voice. Check `showErr(`/`form-err` strings explicitly in copy
reviews.
