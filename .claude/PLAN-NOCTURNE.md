# Plan: Nocturne redesign (design_handoff_session_manager, v3)

Status (2026-09-10): A1, A2, A3 landed and user-verified on Windows (plus a fix round: copy chord, add existing folder). A4 landed (decisions 7, 8, 9 settled by the user); Windows look owed. Next: A5, only on "begin aan A5".

Decision (user, 2026-09-10): full switch to the Nocturne UI. The current UI
("steam blend", v0.3.x) is from now on called **Legacy UI**. No side-by-side
mode, no toggle, no theme variants. Legacy is preserved only as git history:
tag `legacy-ui` on the last commit before A1 starts. Legacy styles, the theme
popover and `design-mocks/` are removed in A8/B8. Nocturne ships as v0.4.0.

No methods chosen, no code investigated beyond a file listing. Each part below is sized to fit one
rate-limited session and is started only when the user says "begin aan <id>".

Source of truth for look and behaviour:
- `design_handoff_session_manager/README-v3.md` (spec)
- `design_handoff_session_manager/session-manager-v3.html` + `_ds/nocturne-*/styles.css` (reference, mocked data)
- `design_handoff_session_manager/CLAUDE_CODE_PROMPT_v3.md` (the author's 6-phase order; this plan splits it finer)
- `design_handoff_session_manager/app-icon.svg` (new icon)
- v2 files (`README.md`, `session-manager-prototype.html`, `CLAUDE_CODE_PROMPT.md`) are superseded for visuals; only consulted for interaction details missing from v3.

Fixed rules for every part:
- Recreate in the real stack in `web/` (vanilla TS + xterm.js, existing `ui/*` modules). HTML is reference, never copied.
- Keep all existing wiring alive (PTY over WS, presence, GitHub auth, git, updater). UI parts change only look, layout and copy.
- Runs through `/dev-flow`; UI parts also through `/frontend-designer`; anything touching panes/terminal ends with `/verify-terminal`.
- Must build, typecheck, tests green; commit + push after each part; screenshot to user after each part.
- Copy rules apply everywhere from A2 on: no decorative separators in text, plural forms, state words ("Working", "Needs your answer", "Finished", "Needs you").
- No new dependency without asking, except a terminal renderer (already have xterm.js). Phosphor icons: inline SVG unless user approves a package.

---

## Track A — UI first (visual fidelity, mocked/static where no data exists yet)

### A1. Tokens, fonts, icon
- Replace current theme tokens with Nocturne tokens from `styles.css` (`--color-*`, `--space-*`, `--radius-*`, `--shadow-*`). Inter for UI, JetBrains Mono for terminal/code/data. Radii 4/8/14.
- Semantic colours: running/added, attention/working-on, danger/removed as in README-v3.
- Render `app-icon.svg` to multi-size `.ico` (16/32/48/256) via `launcher/make-icon.mjs` (extend if PNG-only). Replace `app.ico`; launcher, taskbar shortcut, Edge app window pick it up (icon cache clear if needed).
- Before touching code: `git tag legacy-ui` on HEAD and push the tag.
- Deliverable: app runs with new palette/fonts, old chrome still in place but recoloured; new icon visible in Windows.

### A2. Shell chrome
- Top bar 48 px: logo + "Session Manager", Files / Projects / Sessions toggles, spacer, Connected dot, GitHub account chip, Settings gear, New session (outlined accent).
- Tab strip: one tab per screen, count pill when >1, "Needs you" pill, close; drag-to-merge visuals.
- Statusline 26 px: "N sessions, N panes, N waiting for you, Latency, Up, Keyboard shortcuts".
- Apply copy rules across the whole UI.

### A3. Pane chrome
- Card on neutral-900, header 38 px (dot, name, project, state pill, "Own tab" in a split), terminal body colour per spec, xterm theme mapped to Nocturne.
- Below terminal: configurable status bar area (label + mono value pairs, wraps) rendered with the values that already exist today; "Background agents" table as empty/static state.
- Grid layouts 1–4 restyled. `/verify-terminal` mandatory here.

### A4. New session dialog (visual)
- Tool grid two per row (Claude Code, Codex, Gemini CLI, Grok, Terminal). Name (optional) + Project on one row.
- AI tools: Model, Effort, Permission cards (Always ask, Auto edits, Read only, No prompts in red), Start from (fresh / continue / resume list), API-key notice with "Add key".
- Terminal: shell cards Bash, Zsh, PowerShell, Command Prompt. Command preview at bottom.
- Existing Claude Code launch keeps working behind the new visuals. Non-Claude tools and shells are visible but inert (disabled with clear hint) until B5.

### A5. Files panel + Commits list (visual)
- Left panel, resizable 200–520 px by dragging its right edge. Tabs Files / Commits, header with project name.
- Files: summary row, tree with folder icons and per-extension badges, per-file +/-, amber pulse on touched files and ancestor folders.
- Commits: list rows (message, hash, author, relative time, +/-).
- All data mocked/static in this part. Sessions panel (right, 300 px) restyled here too.

### A6. Commit view + Editor (visual)
- Full-screen commit view replacing the pane area: title, avatar, "committed <when>", branch, hash, "Open on GitHub", `N files changed +A -D` with five-block bar, collapsible unified diff per file with "Open file", "Back to sessions".
- Editor right of terminal at ~54 % width: tabs with amber unsaved dot, path, Save/Saved, line gutter, editable mono text. Mock content.

### A7. Settings + Add-a-project dialog (visual)
- Settings with left nav: Status bar (checklist), Preferences, Keyboard, Background service (version, uptime, Check for updates, Restart). Existing update/restart flows reused visually.
- Add a project: tabs New folder / Clone a repository / From GitHub, restyled over the existing flow.

### A8. UI gate
- Side-by-side compare against the HTML for every screen; frontend-designer anti-generic check; full `/verify-terminal`; janitor pass removing dead styles from the old theme. Milestone commit + release notes draft.
- Before deleting the `LEGACY ALIAS LAYER` block: `--line`, `--tick`, `--font-sans`, `--font-mono` (used by the A3 pane block and the A4 `ns-` dialog block) must move above the marker.

---

## Track B — functionality behind the new UI

### B1. Configurable status bar
- Checklist persisted locally; rendered under each terminal. Items: Model, Permission mode, Git branch, Cost, Context, Account usage, Active skill, Session time, Lines changed.
- Data sources for Cost / Context / Account usage / Active skill are an OPEN DECISION (see below).

### B2. Files panel live
- `git diff --numstat` per project via backend; tree built from it; auto-open when a session is running.
- Files the session touches (Claude Code tool events) drive the amber pulse. Event source is an OPEN DECISION.

### B3. Commits live
- `git log` list and `git show` per commit via backend; "Open on GitHub" from the remote; "Open file" hands off to editor.

### B4. Editor live
- Read file, edit, Save writes to disk via backend; diff tabs read-only. Path handling goes through security-auditor.

### B5. New session dialog live
- Command builders for Codex, Gemini CLI, Grok; Effort and Permission mapping per tool; Start from fresh / continue / resume; API keys stored locally with "Add key"; Terminal shells (bash, zsh, pwsh.exe via WSL interop, cmd.exe).
- Exact CLI flags per tool are an OPEN DECISION (verify against each tool's docs at start of B5).

### B6. Settings live
- Preferences: tool visibility, API keys, defaults (reopen tabs, confirm before ending a session, notifications, follow output). Keyboard page from existing shortcuts. Background service page wired to existing version/uptime/update/restart.

### B7. Background agents table live
- Data source is an OPEN DECISION; if none exists, table shows an honest empty state and this part is dropped.

### B8. Cleanup + memory
- Janitor; remove remaining Legacy UI code (theme picker, old tokens, `design-mocks/`, v2 handoff files); update `PROJECT-SCOPE.md`, `web/DESIGN.md` (Nocturne replaces steam blend), memory vault; release v0.4.0.

---

## Open decisions (user decides; do not settle silently)
1. ~~Old theme popover~~ DECIDED: drop; Legacy UI removed entirely (see above).
2. Data sources for Cost, Context, Account usage, Active skill, Lines changed in the status bar.
3. Source of "files the session is touching": Claude Code hooks, transcript watching, or something else.
4. Where API keys live locally and how they reach the child process.
5. Phosphor icons: inline SVG subset vs. package.
6. pwsh.exe / cmd.exe via interop: allowed under the hard constraints in `PROJECT-SCOPE.md`? Check at B5.
7. ~~A4 — command preview~~ DECIDED 2026-09-10 (user): left out; the 2026-07-25 "no commands or flags in the UI" rule stands.
8. ~~A4 — permission-card descriptions~~ DECIDED 2026-09-10 (user): cards show labels only, plus ONE small info button beside the "Permissions" label that opens a short plain explanation of all four modes. The only explanatory copy in the dialog.
9. ~~A4 — where the custom-command escape hatch lives (v3 has none)~~ DECIDED 2026-09-10 (user): a sixth tool card "Other" after Terminal, showing the existing command field.

## Suggested order
A1 → A2 → A3 → A4 → A5 → A6 → A7 → A8, then B1 → B5 → B2 → B3 → B4 → B6 → B7 → B8.
B5 early because it unblocks real use of the new dialog; B2–B4 form one git/editor cluster.
