---
type: decision
created: 2026-09-22
updated: 2026-09-22
tags: [nocturne, icons, design, licensing]
---
# Icons everywhere: a real icon per file type, the real tool logos in one style (part B12)

**Status:** decided 2026-09-22 (user, asked before the developer started);
implemented the same day. Spec `.claude/plans/nocturne/PLAN-B12.md`.

User's ask: "voeg overal icontjes toe … per filetype, voeg ook het .py .txt
of dergelijke toe … ook aan ai tools" (screenshots: the Files tree full of
`·` chips, the Settings tool list with `CC`/`CX`/`GM`/`GK`).

- **File icons:** real icons per type, VS Code-like — not wider text badges,
  not icon + extension label. Languages wear their logo (Simple Icons, CC0),
  everything else a Phosphor category glyph; coloured by `--badge-<kind>-fg`,
  no chip background. Classifier order: exact name → backup suffix stripped
  (`.old .bak .orig ~`, repeated) → extension → secret-sounding name → plain.
- **Tool logos:** "echte merklogo's maar ze moeten in hetzelfde stijl zijn" —
  one set (LobeHub mono: claude, codex, gemini, grok), single colour in the
  tile's foreground, same size. Codex wears LobeHub's own `codex` mark, not
  OpenAI's (orchestrator, on the scope review).
- **Places:** all offered — Files tree + editor tabs, New session + Settings,
  session tabs + pane header, Sessions/history rows + the agents table header
  (once, not per row).
- **Source:** inline SVG path data, no icon package (settles Nocturne open
  decision 5); every path cites package@version + icon name; licence texts
  (and trademark notes) in `web/src/assets/icons/`.
- **Orchestrator's call on review:** a tab rooted on a folder ("Home", a
  project) wears the folder glyph, not its active file's icon — a Docker
  logo beside "Home" read as "Home is Docker".

Rejected: an npm icon package (material-icon-theme / simple-icons); brand
colours on tool logos; home-drawn stylised tool symbols.
