# Plan: Nocturne redesign (design_handoff_session_manager, v3)

Status (2026-09-13): A1, A2, A3 landed and user-verified on Windows (plus a fix round: copy chord, add existing folder). A4 landed and user-checked in the Windows dev window ("ziet er goed uit"). A4b landed 2026-09-13 and user-verified on Windows ("alles werkt keurig"). A5 landed 2026-09-13 (user: "file systeem ziet er goed uit"; live data stays B2/B3 after A8 — user's call 2026-09-13). A6 landed 2026-09-13 and user-verified on Windows ("alles goed"). Decision 10 settled 2026-09-13; A7 landed 2026-09-13 and user-verified on Windows 2026-09-14 ("al good"; Settings five pages incl. Terminal colours mock, Add-a-project dialog, folder picker). A8 landed 2026-09-14 (alias layer deleted, every screen compared against v3, verify-terminal 1–9 PASS; Windows look of the boot card / shortcuts overlay / toast / restart confirmation / projects drawer owed to the user's dev window) — **Track A complete**. Next: Track B, B1 first (order kept per the user's 2026-09-13 call) — each part only on the user's "begin aan <id>".

Decision (user, 2026-09-10): full switch to the Nocturne UI. The current UI
("steam blend", v0.3.x) is from now on called **Legacy UI**. No side-by-side
mode, no Legacy/Nocturne toggle. Legacy is preserved only as git history:
tag `legacy-ui` on the last commit before A1 starts. Legacy styles, the theme
popover UI and `design-mocks/` are removed in A8/B8. Nocturne ships as v0.4.0.
Amended (user, 2026-09-10 evening): customising the terminal colours comes
BACK inside Nocturne, as a Settings page (A7 visual, B9 live), not as the
Legacy popover. The persistence/refresh machinery in `web/src/ui/theme.ts`
(prefs.json copy, live refresh of every open terminal) is therefore kept and
reused, not deleted in A8/B8.

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

### A4b. Terminal ground + font load (fix, before A5)
- Found while the user tested A4 (2026-09-10): xterm's viewport paints its default `#000` in the `.xterm` padding, so a black band (~17 px) frames the text on the Nocturne ground `#0b0d14`. The whole terminal area must be the ground.
- Nothing waits for JetBrains Mono before a terminal draws; the woff2 can arrive after the first draw, and that pane then keeps a fallback font (Cascadia Mono on Windows) until a reload. Load the font first, or clear the glyph atlas + refit once it lands.
- `/dev-flow` + `/verify-terminal` (terminal code).

### A5. Files panel + Commits list (visual)
- Left panel, resizable 200–520 px by dragging its right edge. Tabs Files / Commits, header with project name.
- Files: summary row, tree with folder icons and per-extension badges, per-file +/-, amber pulse on touched files and ancestor folders.
- Commits: list rows (message, hash, author, relative time, +/-).
- All data mocked/static in this part. Sessions panel (right, 300 px) restyled here too.

### A6. Commit view + Editor (visual)
- Full-screen commit view replacing the pane area: title, avatar, "committed <when>", branch, hash, "Open on GitHub", `N files changed +A -D` with five-block bar, collapsible unified diff per file with "Open file", "Back to sessions".
- Editor right of terminal at ~54 % width: tabs with amber unsaved dot, path, Save/Saved, line gutter, editable mono text. Mock content.

### A7. Settings + Add-a-project dialog (visual)
- Settings with left nav: Status bar (checklist), Preferences, Keyboard, **Terminal colours** (added 2026-09-10, user's ask; not in v3 — designed in the Nocturne idiom, see B9 and open decision 10), Background service (version, uptime, Check for updates, Restart). Existing update/restart flows reused visually.
- Add a project: tabs New folder / Clone a repository / From GitHub, restyled over the existing flow.

### A8. UI gate
- Side-by-side compare against the HTML for every screen; frontend-designer anti-generic check; full `/verify-terminal`; janitor pass removing dead styles from the old theme. Milestone commit + release notes draft.
- Before deleting the `LEGACY ALIAS LAYER` block: `--line`, `--tick`, `--font-sans`, `--font-mono` (used by the A3 pane block and the A4 `ns-` dialog block) must move above the marker.
- DONE 2026-09-14 (A8 landed): 0 alias references remain; the `LEGACY ALIAS LAYER` block and marker are deleted (tokens.css = 144 tokens in 8 sections), guarded by `tests/ui-a8-tokens.test.ts`. The paragraph below is the pre-A8 warning, kept as history.
- Size warning (scope review of A7, 2026-09-13): after A7 (incl. the folder-picker rewrite) about 406 non-exception alias references remain in `app.css` (shortcuts overlay, shared `launch-*` chrome (only `update.ts` still wears it), restart confirmation, Files panel, shared form bits, boot overlay, A5 panels, sessions rows, update notice, theme popover, base, topbar). A8 is a migration part, not a delete-the-block afternoon: each of those surfaces moves onto primitives first (or is removed with its feature), then the block goes. The dead-after-A7 `launch-*` rules, `.btn-go`, `.launch-scrim` and token `--ls-field` were already dropped in A7's hygiene pass; the seven `launch-*` names `update.ts` still sets are the block's only remaining users.

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

### B9. Terminal colours live (added 2026-09-10, user's ask)
- The user can customise the terminal colours, like other terminals allow (e.g. Windows Terminal colour schemes): at least the terminal ground and the text colours, with the Nocturne look as the default and a way back to it.
- Reuse the existing machinery in `web/src/ui/theme.ts`: CSS custom properties on `:root` feed `themeFromTokens()`, `refreshAllTerminalThemes()` repaints every open terminal live, the choice persists server-side in `prefs.json` (localStorage dies with every auto-picked port). Status colours (green/amber/red) stay semantic and are never themed.
- Exact shape is OPEN DECISION 10.

### A9 + B10. Drop files and folders into the file system (added 2026-09-15, user's ask)
- The user drags files or folders from Windows Explorer into the app and they land in the WSL file system, "like Explorer": drop onto a folder in the Files panel or onto a terminal pane (its session's working directory). It must always be obvious WHERE the drop will land before the mouse is released (drop-target highlight on the exact folder row / the pane, plus the destination named in words); copying via the clipboard (Ctrl+C in Explorer, Ctrl+V in the app) is the same operation through a second door.
- A9 (visual, terminal-ui): drag-over states for folder rows and panes, the destination line, the progress + result state (copied / skipped / failed per item), conflict handling copy (existing file: replace / keep both / skip) in the Nocturne idiom. Mock transport.
- B10 (functional, backend-pty + terminal-ui): browser drag-and-drop / paste (File API, directory entries), an upload endpoint on the localhost backend that writes under a destination path inside the user's home only, path normalisation and traversal checks, size and count limits, per-file result. Security review mandatory (file writes from a browser origin). Dragging OUT of the app to Explorer is out of scope unless the native host makes it cheap; check at B10.
- DECIDED 2026-09-15 (user): (a) drop targets = BOTH Files-panel folder rows and terminal panes (a pane = its session's working directory); (b) conflicts = ask per drop, Explorer-style (replace / keep both / skip, one dialog per drop, the choice covers every conflict in that drop); (c) the Files panel becomes a file browser first (decision 11) so drop targets are real folders; (d) NO dragging out of the app — but the user must be able to COPY a file or folder from the app's file system to the clipboard and paste it elsewhere (Explorer). A browser page cannot put a file on the OS clipboard; the native host can (`\\wsl.localhost\<distro>\...` paths as a file-drop list). Check at B10 how the copy reaches the host; the Edge fallback gets the path as text at most.
- Started only on the user's "begin aan A9" — user said 2026-09-15 "after the current fix, get to work", which is that go-ahead once the Files-panel fix lands.

### A10. Editor as panes in the tab strip (added 2026-09-15, user's ask; replaces the A6 editor COLUMN)
- User's complaint: opening a file gives a half-screen editor column with the pane grid's empty state ("start a new session") beside it. That goes. A file opens FULL in the pane area, as a pane inside a tab in the bottom tab strip — exactly like a session.
- DECIDED 2026-09-15 (user): (a) ONE TAB PER ROOT FOLDER, named after it (`Home`, or the project name); every file opened from that folder is a pane in that tab, 2 or 4 side by side with the same 1/2/4 layouts as sessions; (b) FREE MIXING: a pane is a terminal OR a file, so a file can sit beside a terminal in the same tab; (c) a FIXED `Home` tab in the strip (always there, used for files) — "really handy"; (d) DRAG: reorder tabs in the strip, swap panes within a tab (left/right/top/bottom), drag a file row from the Files panel onto a pane or a pane edge to open it there (split) — all three also apply to session tabs/panes where they make sense; moving an open file to another tab was NOT asked; (e) order: after the Commits-at-Home fix, A10 before A9.
- Visual (A10, mock text as A6): tab chip for a folder tab (name, file count or dirty mark), file panes with the A6 editor body (tab-less: the pane IS the file, its header = file name + dirty mark + close), drag affordances (grab handle on tab chips, drop zones on pane edges with the same accent as pane focus), the `Home` fixed tab. Commit view (A6) keeps covering the pane area.
- Model: `ViewState.sessions` becomes a list of SLOTS (`{kind:'session',id}` | `{kind:'file',path}`); focus, Esc, statusline counts, attention badges, `requestTerminalFocus` and the fit → ws resize seam must all learn "this slot is not a terminal". Files are not persisted server-side until B4 (mock).
- Functional (B4 extends): real file read/write behind the panes; drag of a file onto a terminal pane's edge splits with a real file.
- Open before starting: what a plain terminal session that was started from a file tab's folder is named; whether closing the last file pane closes the folder tab (except the fixed `Home`); keyboard equivalents for every drag (a control that only exists under a pointer is forbidden).

### A11. Commits tab only where a repository can be (added 2026-09-15, user's ask, small)
- With the Files panel headed `Home` (no session, no project) the Commits tab must not be viewable: no repository is known there. Tab disabled (with a title saying why) and the panel falls back to the Files tab when it was on Commits. A session without a project keeps the A5 mock until B3 decides repo detection. Done first, before A10.

### B8. Cleanup + memory
- Janitor; remove remaining Legacy UI code (`design-mocks/`, v2 handoff files — the theme popover UI and the old alias tokens were already removed in A8, 2026-09-14; the `theme.ts` machinery B9 reuses stays); update `PROJECT-SCOPE.md`, `web/DESIGN.md` (Nocturne replaces steam blend), memory vault; release v0.4.0.

---

## Open decisions (user decides; do not settle silently)
1. ~~Old theme popover~~ DECIDED: drop the popover; Legacy UI removed entirely (see above). Amended 2026-09-10 evening (user): colour customisation itself returns as a Nocturne Settings page — see A7, B9 and decision 10.
2. Data sources for Cost, Context, Account usage, Active skill, Lines changed in the status bar.
3. Source of "files the session is touching": Claude Code hooks, transcript watching, or something else.
4. Where API keys live locally and how they reach the child process.
5. Phosphor icons: inline SVG subset vs. package.
6. pwsh.exe / cmd.exe via interop: allowed under the hard constraints in `PROJECT-SCOPE.md`? Check at B5.
7. ~~A4 — command preview~~ DECIDED 2026-09-10 (user): left out; the 2026-07-25 "no commands or flags in the UI" rule stands.
8. ~~A4 — permission-card descriptions~~ DECIDED 2026-09-10 (user): cards show labels only, plus ONE small info button beside the "Permissions" label that opens a short plain explanation of all four modes. The only explanatory copy in the dialog.
9. ~~A4 — where the custom-command escape hatch lives (v3 has none)~~ DECIDED 2026-09-10 (user): a sixth tool card "Other" after Terminal, showing the existing command field.
10. ~~Terminal colours (B9), ask before A7~~ DECIDED 2026-09-13 (user, all four the orchestrator's advice): (a) presets + custom ground and text; (b) ground + text only, never the full ANSI palette; (c) terminal only, the app accent stays Nocturne, status colours never themed; (d) a Settings page only, no top-bar switch. Original question: (a) presets only, a free colour picker, or both; (b) which colours — ground + text only, or the full ANSI palette; (c) terminal only, or the app's accent colour too; (d) its place — a Settings page only, or also a quick switch in the top bar. Orchestrator's advice: a Settings page with a handful of presets (Nocturne first) plus custom ground and text colours; terminal only; status colours never themed.
11. ~~Files panel MEANING (ask before B2)~~ DECIDED 2026-09-15 (user, the orchestrator's advice): the Files panel becomes a real FILE BROWSER — root = the user's home directory, the project root when a session is focused; the v3 git-changes list survives as a second tab (`Changes`) beside `Files` and `Commits`. Same day: the panel opens without a session (header `Home`), and only one left panel at a time — the Projects drawer hides Files while open (Files returns when it closes). Both deviate from v3 on purpose. Original question: git-changes panel per project, a file browser rooted at home, or both (tabs).

## Suggested order
A1 → A2 → A3 → A4 → A4b → A5 → A6 → A7 → A8, then A11 → A10 → A9 (user's 2026-09-15 priorities) → B1 → B5 → B2 → B10 → B3 → B4 → B6 → B9 → B7 → B8.
B5 early because it unblocks real use of the new dialog; B2–B4 form one git/editor cluster.
