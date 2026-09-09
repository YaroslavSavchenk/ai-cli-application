---
type: knowledge
created: 2026-09-09
updated: 2026-09-09
tags: [installer, inno-setup, windows, gotcha]
---
# Inno Setup: a `[Code]` line that starts with `#13#10` is read as a preprocessor directive

Measured 2026-09-09 on the windows runner (Inno Setup 6.7.1, run
34353061285 — the first ISCC compile of `installer/ai-session-manager.iss`):

```
Error on line 497 in ...\installer\ai-session-manager.iss: Unknown preprocessor directive.
Compile aborted.
```

Line 497 was a continuation line of a Pascal string expression that began
with the char literal `#13#10#13#10 +`. ISPP (the preprocessor) runs over
the whole file before Pascal sees it and treats ANY line whose first
non-blank character is `#` as a directive — `#13` is not `#define`, so it
aborts. Pascal itself would have been fine.

Rule: a `#nn` char literal never opens a line; put it at the END of the
previous line (`… + '.' + #13#10#13#10 +`). Pinned by
`tests/installer-script.test.ts` ("no line in the .iss starts with a Pascal
char literal"), which lists every `[Code]` line that would be read as a
directive. See [[2026-09-09-installer-phase-c-d]].
