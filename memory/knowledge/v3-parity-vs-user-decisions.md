---
type: knowledge
created: 2026-09-14
updated: 2026-09-14
tags: [process, design, review, nocturne]
---
# A handoff-parity finding is not above a recorded user decision

Learned in [[2026-09-14-nocturne-a8]] (the UI gate's side-by-side compare
against the v3 handoff).

**What happened.** The compare reviewer reported the New session dialog
as "the only dialog in the family missing its v3 sub-line" and cited the
v3 markup's `Runs on the server and keeps going when you switch tabs.`
The orchestrator folded it into the fix list, the fixer applied it with the
app's own noun ("background service"), and the suite stayed green — the
literal ban in `tests/ui-copy-rule.test.ts` covered only the v3 wording.
The scope reviewer's re-review caught it: `.claude/PROJECT-SCOPE.md` records
"Header `New session`, no subtitle" (user's call 2026-09-06, "far too many
unnecessary things") and the A4 decision that the permissions popover is
the ONLY explanatory copy in the dialog. Reverted in the next cycle.

**Rules.**
- Before a v3-parity finding goes to the fixer, grep the scope doc and the
  decision notes for the surface; a deviation the user chose is DELIBERATE
  and the compare brief must list it as such up front (the A4/A7 logs did,
  the orchestrator did not paste them into the compare brief).
- The scope reviewer always re-reviews after a fix cycle even when "only
  visual" findings were applied — that is where this was caught.
- A ban-by-literal test guards one wording; when a sentence is banned for
  its MEANING, add the paraphrase too and say why in the comment.
- The compare reviewer can also be wrong on arithmetic: its `--toast-bottom`
  formula counted the statusline border twice; the fixer measured under
  `box-sizing: border-box` and was right. Fixers may correct a finding with
  evidence; the orchestrator sends the correction back to the reviewer.

**Also from this gate.** No plan part owned the Projects drawer (A5's log
only said "inherits, coherent, not redesigned"), so it reached the gate on
Legacy literals, single-glyph `+` buttons and an unstyled `proj-list`
wrapper. A screen nobody owns is found at the gate, or never — list every
screen in the part plan, even the ones "already fine".
