# Plan: Nocturne redesign (design/session-manager, v3)

Status: see the table below (updated 2026-09-22, late). Conventions: `.claude/plans/README.md`.
Each part starts only on the user's word ("begin aan <id>"); rows are in the order of work.

| Part | What | State | Spec | Landed |
| --- | --- | --- | --- | --- |
| A1 | Tokens, fonts, icon | verified | — | 2026-09-10 |
| A2 | Shell chrome (top bar, tab strip, statusline) | verified | — | 2026-09-10 |
| A3 | Pane chrome | verified | — | 2026-09-10 |
| A4 | New session dialog (visual) | verified | — | 2026-09-10 |
| A4b | Terminal ground + font load | verified | — | 2026-09-13 |
| A5 | Files panel + Commits list (visual) | verified | — | 2026-09-13 |
| A6 | Commit view + editor (visual) | verified | — | 2026-09-13 |
| A7 | Settings + Add-a-project dialog (visual) | verified | — | 2026-09-13 |
| A8 | UI gate — Track A complete | landed | — | 2026-09-14 |
| A11 | Commits tab only where a repository can be | verified | — | 2026-09-15 |
| A10 | Editor as panes in the tab strip | landed | `.claude/plans/nocturne/PLAN-A10.md` | 2026-09-15 |
| A9 | Drop files and folders (visual half) | landed | `.claude/plans/nocturne/PLAN-A9.md` | 2026-09-15 |
| A10b | Editor pane with file tabs | landed | `.claude/plans/nocturne/PLAN-A10b.md` | 2026-09-15 |
| A9b | Select a folder, paste into it, row context menu | verified | `.claude/plans/nocturne/PLAN-A9b.md` | 2026-09-16 |
| B2 + A9c | Files panel live, New file / New folder | verified | `.claude/plans/nocturne/PLAN-B2.md` | 2026-09-16 |
| B1 | Configurable pane status bar | verified | `.claude/plans/nocturne/PLAN-B1.md` | 2026-09-17 |
| B5 | New session dialog live for every tool | verified | `.claude/plans/nocturne/PLAN-B5.md` | 2026-09-20 |
| B10 | Real file copy into WSL, Copy to the Windows clipboard | verified | `.claude/plans/nocturne/PLAN-B10.md` | 2026-09-20 |
| B10a | Select several files and folders, delete them | verified | `.claude/plans/nocturne/PLAN-B10a.md` | 2026-09-20 |
| B3 | Commits live | verified | `.claude/plans/nocturne/PLAN-B3.md` | 2026-09-21 |
| B4 | Editor live (read, edit, save to disk) | verified | `.claude/plans/nocturne/PLAN-B4.md` | 2026-09-22 |
| B6 | Settings live | verified | `.claude/plans/nocturne/PLAN-B6.md` | 2026-09-22 |
| B9 | Terminal colours live | verified | `.claude/plans/nocturne/PLAN-B9.md` | 2026-09-22 |
| B7 | Background agents table live (data source decided 2026-09-22: Claude Code's transcripts) | verified | `.claude/plans/nocturne/PLAN-B7.md` | 2026-09-22 |
| B11 | Session state: Working vs. Waiting for you; agents-table switch (default off) + the many-agents rule (DECIDED 2026-09-22, see the part) | todo | — |  |
| B8 | Cleanup + memory, release v0.4.0 | todo | — |  |
| C1 | Peek mascot (phase 1 of 4 landed 2026-09-15) | started | — |  |

Decision (user, 2026-09-10): full switch to the Nocturne UI. The current UI
("steam blend", v0.3.x) is from now on called **Legacy UI**. No side-by-side
mode, no Legacy/Nocturne toggle. Legacy is preserved only as git history:
tag `legacy-ui` on the last commit before A1 starts. Legacy styles, the theme
popover UI and `design-mocks/` are removed in A8/B8 (`design-mocks/` went early, 2026-09-21, in restructure batch 3). Nocturne ships as v0.4.0.
Amended (user, 2026-09-10 evening): customising the terminal colours comes
BACK inside Nocturne, as a Settings page (A7 visual, B9 live), not as the
Legacy popover. The persistence/refresh machinery in `web/src/ui/theme.ts`
(prefs.json copy, live refresh of every open terminal) is therefore kept and
reused, not deleted in A8/B8.

No methods chosen, no code investigated beyond a file listing. Each part below is sized to fit one
rate-limited session and is started only when the user says "begin aan <id>".

Source of truth for look and behaviour:
- `design/session-manager/README-v3.md` (spec)
- `design/session-manager/session-manager-v3.html` + `_ds/nocturne-*/styles.css` (reference, mocked data)
- `design/session-manager/CLAUDE_CODE_PROMPT_v3.md` (the author's 6-phase order; this plan splits it finer)
- `design/session-manager/app-icon.svg` (new icon)
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
- Data sources for Cost / Context / Account usage / Active skill: decision 2 (below), DECIDED 2026-09-16.
- STARTED 2026-09-17 (user: "continue met het ontwikkelen van een nieuwe versie"; next in the plan order). Spec `.claude/plans/nocturne/PLAN-B1.md`. Built: `server/statusline.mjs` writes a per-session snapshot (`<dataDir>/statusline-snapshots/<appSessionId>.json`, path handed over as a fourth argument, write-on-change) → `server/telemetry.ts` watches the directory and sanitises the file as untrusted → `SessionInfo.telemetry` → the existing `info` frame → `ui/pane-status-model.ts` renders Model, Mode, Branch, Cost, Context, Usage, Time, Changed behind the SAME toggles as Settings → Status bar. Orchestrator defaults (not confirmed one by one): two switches (`enabled` = Claude's line inside the terminal, `paneBar` = the bar under it; DECIDED 2026-09-17 by the user after the Windows check: the bar ON, Claude's line OFF by default), `Session time` a checklist row for the pane bar only, `Usage` amber at ≥ 80 %, Active skill dropped without a placeholder, an exited session keeps its last values. LANDED 2026-09-17 (`9143d32`, `75afd31` PTY env strip, `d5f5954` default flip); user-verified on Windows the same day ("alles werkt").

### B2. Files panel live
- LANDED 2026-09-16 together with A9c (see the A9c entry and `.claude/plans/nocturne/PLAN-B2.md`): a real file browser (decision 11) + a `Changes` tab from `git diff --numstat` + `git status --porcelain`; the boundary = home + registered project paths.
- Files the session touches (Claude Code tool events) drive the amber pulse. Event source is STILL open decision 3 — nothing sets it; the CSS hook stays.

### B3. Commits live
- `git log` list and `git show` per commit via backend; "Open on GitHub" from the remote; "Open file" hands off to editor.

### B4. Editor live
- Read file, edit, Save writes to disk via backend; diff tabs read-only. Path handling goes through security-auditor.

### B5. New session dialog live
- Command builders for Codex, Gemini CLI, Grok; Effort and Permission mapping per tool; Start from fresh / continue / resume; API keys stored locally with "Add key"; Terminal shells (bash, zsh, pwsh.exe via WSL interop, cmd.exe).
- Exact CLI flags per tool are an OPEN DECISION (verify against each tool's docs at start of B5).
- STARTED 2026-09-18 (user: "continue"). Spec `.claude/plans/nocturne/PLAN-B5.md` — decisions 4 and 6 settled there (user, orchestrator's advice): keys server-side in `keys.json` injected into the tool's child env (Codex signs in inside the terminal); Command Prompt via interop with a server-injected `/k pushd <windows path>`; no `pwsh.exe`; absent tools = inert `Not installed` cards from a PATH probe (`GET /api/tools`); Start from = Claude per-id, the others last-only. Flags verified 2026-09-18 against the installed `codex` 0.116 / `gemini` 0.60 and Grok Build's docs (table in the spec). LANDED 2026-09-20 (18 Sept: both phases, scope + security review, fix round, 159-mutant gate, suite 2480→2577; limit-killed at verify. 20 Sept: verify-terminal V1–V7 PASS; DEFECT: Gemini CLI 0.60 ignores SIGHUP/SIGTERM and outlived DELETE with the stored key in its env → kill ladder SIGHUP → SIGTERM → SIGKILL on the process GROUP, shutdown = SIGHUP + group SIGKILL, security-auditor's two should-fix applied, 29-mutant gate; suite 2594; `2b6ce72`). User-verified on Windows 2026-09-20: Codex and Gemini CLI sessions work ("codex en gemini werken"); Command Prompt prompt, Not-installed cards and the key fields not reported yet. Follow-ups: Grok `-s <uuid>`, Gemini `--session-id`; shutdown grace between SIGHUP and SIGKILL = user's call.

### B6. Settings live
- Preferences: tool visibility, API keys, defaults (reopen tabs, confirm before ending a session, notifications, follow output). Keyboard page from existing shortcuts. Background service page wired to existing version/uptime/update/restart.

### B7. Background agents table live
- Data source was an open decision. DECIDED 2026-09-22 (user, the orchestrator's advice): Claude Code's own transcripts — `~/.claude/projects/<slug>/<session-id>/subagents/agent-<hex>.meta.json` + `.jsonl`, found through the `transcript_path` the status-line payload already carries (added to the B1 snapshot). Rejected: SubagentStart/Stop hooks (no tokens, more moving parts), dropping the part. STARTED and LANDED 2026-09-22; spec `.claude/plans/nocturne/PLAN-B7.md`. Windows check owed.
- Constraint from B9 (2026-09-22): the table sits inside the terminal card, on the THEMED ground. Its ink (`.pane-agents-hd`, `.pane-agent-*`) and the two hairlines under the terminal (`.pane-status`, `.pane-agents`, `--color-neutral-900`) are still app neutrals — invisible while the table is empty, unreadable on a light custom ground once it is not. B7 gives them the theme's steps like the status bar's (`--xt-bright-black` / `--xt-fg`).

### B11. Session state: Working vs. Waiting for you (NOTED 2026-09-22, user's ask on the B7 check — NO PLAN YET)
- User (2026-09-22, B7 Windows check): the pane's dot + pill say "Working" the whole time a Claude session is alive, also when Claude has finished its turn and is waiting for input ("als sessie klaar is of wacht op de input"). Today the readout knows three states only: alive (green, Working), BEL (amber, Needs your answer), exited (neutral, Finished) — a PTY does not say whether the program is generating or idle.
- Candidate source, cheap since B7: the session's OWN transcript (`<transcript_path>` from the B1 snapshot, the same boundary as `server/agents.ts`): the last `user`/`assistant` line is an assistant `end_turn` → idle (waiting for you); a later `user` line → working. Same incremental tail as the subagent transcripts, one more file per claude session. The same tail also yields "files the session is touching" (open decision 3: `Edit`/`Write` tool calls with a `file_path`) — decide together or apart.
- Open for the user: the words and colours (v3 vocabulary: "Working", "Needs your answer", "Finished", "Needs you" — a fourth state needs a word and a dot: e.g. green pulsing while working, green still + "Waiting for you" when idle; or amber for idle since that is when the user is needed), whether the tab strip's count pill follows it, and the order (before or after B8).
- ALSO noted the same day: with B7 live the agents stand TWICE on screen — Claude Code's own inline task list under its prompt and the app's table under the status bar (the B1 duplicate all over again). Whether Claude Code can hide its own list is being checked; if not, the app's table gets a switch in Settings → Status bar (like `paneBar`) or the duplicate is accepted — user's call.

- DECIDED 2026-09-22 (user, on the B7 check, session closed right after — spec still to be written on "begin aan B11"):
  (a) **The agents table gets a switch** in Settings → Status bar (like `paneBar`), **default OFF** — Claude Code's own inline task list cannot be hidden on its own (`disableAgentView` kills background agents entirely; docs checked 2026-09-22), so the duplicate is the user's choice per install.
  (b) **State words and colours**: Working = green PULSING; Waiting for you (Claude ended its turn, waits for input) = amber STILL; Needs your answer (BEL) = amber pulsing, unchanged; Finished = grey. The statusline's "N waiting for you" counts waiting sessions too. Source = the session's own transcript (last user/assistant line an assistant `end_turn` → waiting; a later user line → working), the B7 tail on one more file.
  (c) **Order**: now, BEFORE B8 (ships in v0.4.0).
  (d) **Many agents at once** — the user's words: "max 4 die running zijn, als er meer dan 4 zijn +1 of hoeveel agents aan het werk zijn. Of +1 actief en +10 finished. En als je 3 actief heb, dan toon je 1 laatste finished daarbij en de rest +aantal agents finished." Reading to confirm at the start of B11: at most 4 running rows (oldest first); more running → one count line `+N working`; finished agents never listed beyond ONE (the last finished) when there is room under the running rows, the rest as a count `+N finished`; so the table is at most 4 running + 1 finished + one or two count lines. The B7 server cap (8 rows / 3 finished) is replaced by this rule; counts travel on the wire (`running`, `finished` totals) so nothing is silently hidden.

### B9. Terminal colours live (added 2026-09-10, user's ask)
- The user can customise the terminal colours, like other terminals allow (e.g. Windows Terminal colour schemes): at least the terminal ground and the text colours, with the Nocturne look as the default and a way back to it.
- Reuse the existing machinery in `web/src/ui/theme.ts`: CSS custom properties on `:root` feed `themeFromTokens()`, `refreshAllTerminalThemes()` repaints every open terminal live, the choice persists server-side in `prefs.json` (localStorage dies with every auto-picked port). Status colours (green/amber/red) stay semantic and are never themed.
- Exact shape = decision 10, DECIDED 2026-09-13. STARTED and LANDED 2026-09-22 (user: "continue met bouwen van de app"; next row in the table). Spec `.claude/plans/nocturne/PLAN-B9.md`: the pair `prefs.theme = { ground, text }` (the Legacy `{bg, fg, scan}` index shape still read, never written), Nocturne = the absence of an override, terminal-only surfaces split at the CSS seam (editor / diff / file chip on `--color-term`), the server write debounced + serialised with `adopt` on the dialog's re-read; one fix round (a reopen race, `updatePrefs` wiping the bag on a failed GET — pre-existing), 18 mutants, verify-terminal on the reused B6 CDP harness. Windows check owed.

### A9 + B10. Drop files and folders into the file system (added 2026-09-15, user's ask)
- The user drags files or folders from Windows Explorer into the app and they land in the WSL file system, "like Explorer": drop onto a folder in the Files panel or onto a terminal pane (its session's working directory). It must always be obvious WHERE the drop will land before the mouse is released (drop-target highlight on the exact folder row / the pane, plus the destination named in words); copying via the clipboard (Ctrl+C in Explorer, Ctrl+V in the app) is the same operation through a second door.
- A9 (visual, terminal-ui): drag-over states for folder rows and panes, the destination line, the progress + result state (copied / skipped / failed per item), conflict handling copy (existing file: replace / keep both / skip) in the Nocturne idiom. Mock transport.
- B10 (functional, backend-pty + terminal-ui): browser drag-and-drop / paste (File API, directory entries), an upload endpoint on the localhost backend that writes under a destination path inside the user's home only, path normalisation and traversal checks, size and count limits, per-file result. Security review mandatory (file writes from a browser origin). Dragging OUT of the app to Explorer is out of scope unless the native host makes it cheap; check at B10.
- DECIDED 2026-09-15 (user): (a) drop targets = BOTH Files-panel folder rows and terminal panes (a pane = its session's working directory); (b) conflicts = ask per drop, Explorer-style (replace / keep both / skip, one dialog per drop, the choice covers every conflict in that drop); (c) the Files panel becomes a file browser first (decision 11) so drop targets are real folders; (d) NO dragging out of the app — but the user must be able to COPY a file or folder from the app's file system to the clipboard and paste it elsewhere (Explorer). A browser page cannot put a file on the OS clipboard; the native host can (`\\wsl.localhost\<distro>\...` paths as a file-drop list). Check at B10 how the copy reaches the host; the Edge fallback gets the path as text at most.
- DECIDED 2026-09-15 (user, orchestrator's advice): a terminal pane of a session WITHOUT a project is not a target (flash `This session has no project folder yet.`); TEXT drags from other programs onto a terminal are cancelled. Full spec `.claude/plans/nocturne/PLAN-A9.md`. Started 2026-09-15 right after A10 landed (user: "A10 af, ga door met A9"). B10 STARTED 2026-09-20 (user: "ga door met b10"; next after B5). Spec `.claude/plans/nocturne/PLAN-B10.md`; decided (user, orchestrator's advice): both halves with the host phase LAST (row menu `Paste` stays inert — a page only sees files inside a real paste event); folder conflicts with one choice per drop: Replace = merge, Keep both = `web (2)`, Skip = whole folder; 2000 files / 1 GiB per drop refused up front (one oversized file = that row fails, as A9). Transport: per-file raw `PUT /api/fs/upload` under the `resolveUnderAllowed` boundary, temp `.part` + rename/link; clipboard path mapped by the backend (`GET /api/fs/winpath`), host only shape-checks + `SetFileDropList`. LANDED 2026-09-20 (`5779d23`, suite 2600→2765): four phases, scope + security on each, three fix rounds (per-mkdir realpath + data-dir re-check; `Hide` + quiet client log = user's calls; host logs the exception CLASS, targets .NET 4.7.2), gates 75 + 42 mutants, verify-terminal 11/11. User-verified on Windows 2026-09-20 ("alles werkt, wat betreft B10a en B10"; host built by the orchestrator, `Copy` → Explorer paste and Explorer drags included).

### B10a. Select several files and folders, and delete them (added 2026-09-20, user's ask right after B10)
- User: "maak het ook zo, dat ik meerdere mappen, files kan selecteren en deze ook verwijderen. Want er is nog geen verwijderknop." DECIDED 2026-09-20 (user): delete is PERMANENT with one confirmation per action (`Delete 3 items from src? This cannot be undone.`), no trash. Orchestrator defaults: Explorer selection semantics (ctrl/shift-click, ctrl+a, shift+arrows — the tree gets arrow keys for the first time), `Delete` in the row menu + the Delete key, anchors (home, project roots, and any folder containing one) never deletable, one batch `POST /api/fs/delete` (≤ 100, index-keyed results, boundary on the PARENT so a symlink is unlinked never followed, async `rm`). STARTED and LANDED 2026-09-20 (`0293848`, suite 2765→2908: scope + security on the backend — the parent of a project root was deletable, `rmSync` froze every PTY — one fix round each side, gates 12 + 41 + 39, no real defect); spec `.claude/plans/nocturne/PLAN-B10a.md`; decisions `memory/decisions/b10a-multi-select-and-delete.md`. User-verified on Windows 2026-09-20 ("alles werkt, wat betreft B10a en B10").

### A10. Editor as panes in the tab strip (added 2026-09-15, user's ask; replaces the A6 editor COLUMN)
- User's complaint: opening a file gives a half-screen editor column with the pane grid's empty state ("start a new session") beside it. That goes. A file opens FULL in the pane area, as a pane inside a tab in the bottom tab strip — exactly like a session.
- DECIDED 2026-09-15 (user): (a) ONE TAB PER ROOT FOLDER, named after it (`Home`, or the project name); every file opened from that folder is a pane in that tab, 2 or 4 side by side with the same 1/2/4 layouts as sessions; (b) FREE MIXING: a pane is a terminal OR a file, so a file can sit beside a terminal in the same tab; (c) a FIXED `Home` tab in the strip (always there, used for files) — "really handy"; (d) DRAG: reorder tabs in the strip, swap panes within a tab (left/right/top/bottom), drag a file row from the Files panel onto a pane or a pane edge to open it there (split) — all three also apply to session tabs/panes where they make sense; moving an open file to another tab was NOT asked; (e) order: after the Commits-at-Home fix, A10 before A9.
- Visual (A10, mock text as A6): tab chip for a folder tab (name, file count or dirty mark), file panes with the A6 editor body (tab-less: the pane IS the file, its header = file name + dirty mark + close), drag affordances (grab handle on tab chips, drop zones on pane edges with the same accent as pane focus), the `Home` fixed tab. Commit view (A6) keeps covering the pane area.
- Model: `ViewState.sessions` becomes a list of SLOTS (`{kind:'session',id}` | `{kind:'file',path}`); focus, Esc, statusline counts, attention badges, `requestTerminalFocus` and the fit → ws resize seam must all learn "this slot is not a terminal". Files are not persisted server-side until B4 (mock).
- Functional (B4 extends): real file read/write behind the panes; drag of a file onto a terminal pane's edge splits with a real file.
- DECIDED 2026-09-15 (user, orchestrator's advice): last file pane closed → a project folder tab closes unless it still holds a terminal, `Home` never; a file dropped on the CENTRE of a terminal pane is rejected (edges split); `Home` is always first in the strip and not draggable; the A6 `Changes in <hash>` diff stays as a third pane kind. Orchestrator defaults: new sessions keep their own tab; file from a project-less session → `Home`; chords = existing swap/reorder/switch + ctrl+alt+enter (open in split) + ctrl+alt+w (close file pane). Full spec: `.claude/plans/nocturne/PLAN-A10.md`. Started 2026-09-15 ("begin aan A10").

### A9b. Copy and paste files via the clipboard + context menu (NOTED 2026-09-15, user's ask after the A9 check — NO PLAN YET)
- User (2026-09-15, A9 check): dragging works; copying does not yet. Wanted: Ctrl+C on files in Explorer → in the app SELECT a folder (a visible selection overlay/state on the folder row must appear) → Ctrl+Shift+V or plain Ctrl+V pastes the files into that folder. Alternatively a RIGHT-CLICK context menu on a folder/file with the usual entries (copy, paste, and the like). Record only; design when the user says "begin aan A9b". Touches: the A9 paste rule (today paste acts on the focused folder row / panel root; plain Ctrl+V must stay the PTY's inside a terminal), a folder-selection state in the Files panel, a Nocturne context menu (new primitive), and B10 for the real copy.
- STARTED 2026-09-16 (user chose A9b over B1 on "start met de volgende stap"). DECIDED 2026-09-16 (user, all three the orchestrator's advice): (a) SELECTION: one click on a folder row selects it AND toggles it open/closed as today; the selection stays visible after the focus leaves the panel (into a terminal), until another row is chosen or Esc is pressed inside the panel; the copy strip names the selected folder; (b) PASTE: when the clipboard carries FILES and a folder is selected, Ctrl+V / Ctrl+Shift+V copies into that folder from ANYWHERE, a focused terminal included (files carry no text, so the terminal loses nothing); a TEXT paste in a terminal is untouched; with no selection the destination stays the A9 rule (panel root, else the active tab's root); (c) CONTEXT MENU (new Nocturne primitive): folder row = Open / Close, Copy, Paste, Copy files here…; file row = Open, Open beside, Copy. `Copy` and `Paste` are visible but disabled with a plain explanation until B10 (a browser page cannot read files from the OS clipboard outside a paste event, and cannot put files on it; the Windows host does both in B10). No file operations (new folder, rename, delete) — not asked. Full spec `.claude/plans/nocturne/PLAN-A9b.md`. LANDED 2026-09-16 (`951ff90`, `665b28d`, `8873ec6`, `ca9e624`; suite 2093→2231); user-verified on Windows 2026-09-16 ("alles werkt").

### A9c. New file / New folder from the row menu (NOTED 2026-09-16, user's ask after the A9b check — NO PLAN YET)
- User (2026-09-16, A9b check "alles werkt"): the row context menu must also offer creating a NEW FILE and a NEW FOLDER. Touches: two menu entries (`New file`, `New folder`) on folder rows (and the panel root), an inline name row in the tree (Explorer-style: a new row in edit mode, Enter creates, Esc cancels, name rules), and — for the real thing — a backend endpoint that creates an empty file / a directory under the user's home with the same path checks B10 needs (security review). The tree is still `ui/files-mock.ts` until B2, so a mock create can only pretend. DECIDED 2026-09-16 (user, the orchestrator's advice): REAL, NOW — B2 is pulled forward (the Files panel reads the user's real folders and files through the backend, the git-changes list becomes the `Changes` tab per decision 11), then A9c creates files and folders for real (endpoint with path checks under the user's home, security review). No visual-only step. Started 2026-09-16; spec `.claude/plans/nocturne/PLAN-B2.md` (covers B2 + A9c). LANDED 2026-09-16 (`14fb911`, `5cfee81`, `c8416e3`, `15bff78`; suite 2231→2418); user-verified on Windows 2026-09-17 ("alles werkt").

### A10b. Editor pane with file tabs (added 2026-09-15, user's correction on the A10 Windows check)
- User: files must NOT each become their own pane; after the first file is open, the next ones show as TABS inside that editor pane (as the A6 editor column had), and a split appears only when such a file tab is dragged to the pane's left/right edge. Confirmed model 2026-09-15: ONE editor pane per group with an inner file-tab strip (file tabs + read-only diff tabs, dirty dot, ×); clicking a Files row adds a tab to the FOCUSED editor pane of the root's folder tab (creates the editor pane when there is none, raises the tab when already open); drag a file tab to a pane edge → a second editor pane (split), onto another editor pane → the tab moves there; terminal panes stay mixable beside editor panes (1/2/4 as now). `Home` tab and the other A10 decisions stand. Keyboard twins: ctrl+alt+enter (Files row → open in a split) stays; add tab cycling in the pane and a "move tab to the next pane" chord (design decides; every drag keeps a twin).
- Model: `PaneSlot` `file`/`diff` → `{kind:'editor', tabs: EditorTab[], active: number}`; `state.edits` keyed by path unchanged; persistence still session slots only before B4.
- Landed 2026-09-15 (parked once on `wip/a10b` for a usage limit, resumed the same night; squash-merged to main). Windows check owed.

### A11. Commits tab only where a repository can be (added 2026-09-15, user's ask, small)
- With the Files panel headed `Home` (no session, no project) the Commits tab must not be viewable: no repository is known there. Tab disabled (with a title saying why) and the panel falls back to the Files tab when it was on Commits. A session without a project keeps the A5 mock until B3 decides repo detection. Done first, before A10.

### B8. Cleanup + memory
- Janitor; remove remaining Legacy UI code (v2 handoff files; `design-mocks/` was already removed 2026-09-21 in restructure batch 3 — the theme popover UI and the old alias tokens were already removed in A8, 2026-09-14; the `theme.ts` machinery B9 reuses stays); update `PROJECT-SCOPE.md`, `web/DESIGN.md` (Nocturne replaces steam blend), memory vault; release v0.4.0.

## Track C — after the redesign (the LAST step; runs after B8)

### C1. Peek mascot (added 2026-09-15, user's ask; last step of the redesign)
- Source of truth: `design/peek-mascot/README.md` (the user's own high-fidelity design; recreate 1:1, keyframes and SVG verbatim) + `Claude Peek Mascot.dc.html` (prototype). A small pixel-art Claude that peeks around the RIGHT edge of the MONITOR — one mascot per pending input, max 3, stacked with distinct poses; click = laugh or wave; count 3 = strain. It replaces a notification, not a badge.
- User's requirements (2026-09-15): (1) appears at the middle-right of the screen when a session is finished and waits for input; (2) lives OUTSIDE the app window, at the monitor edge, also over fullscreen games / videos; (3) a Settings toggle to turn it off.
- **Phase 1 — DONE 2026-09-15 (branch `mascot`):** standalone page `web/mascot.html` (second Vite entry) + `web/src/mascot/{model,view,main}.ts` + `mascot.css`, driven only by a count (`window.aiSmMascot.setCount(n)`), transparent page background, `?demo&count=N` for a dev preview with +/- controls. Not wired to sessions. Served statically at `/mascot.html` with no server change.
- **Phase 2 — the signal.** count = number of sessions whose `attention` is set (the existing BEL detection in `server/sessions.ts`; attention is acked when the user focuses that pane with the window in front, so the count is exactly "answers you have not seen yet"), clamped to 3. The overlay page needs the auth token like `index.html` (placeholder replacement in `serveStatic` for `/mascot.html` too) and polls `GET /api/sessions` every 2 s like the app; a push channel (backend events WS) stays backlog. Mascot click stays the design's reaction; whether it ALSO brings the app to the front is decision 13.
- **Phase 3 — the overlay window (Windows host, `launcher/host/AiSessionManagerHost.cs`).** A second borderless WinForms window in the SAME host process: `TopMost`, `WS_EX_TOOLWINDOW` (no taskbar button), `WS_EX_NOACTIVATE` (never steals focus from a game), transparent WebView2 (`DefaultBackgroundColor = Transparent`) showing `/mascot.html`, 220×340 px at the right edge of the chosen monitor, vertically centred. Hidden (not just empty) while count is 0 or the toggle is off, so an empty overlay never eats clicks; the page reports `{count}` to the host through `chrome.webview.postMessage` and the host shows/hides. Origin lock and permission denials as the main window. Browser dev mode (no host) gets no overlay — the `?demo` page is the preview there. The host navigates to `/mascot.html` with NO query string, ever (the `?demo` strip ships in the bundle, URL-gated). KNOWN LIMIT: a game in true exclusive fullscreen cannot be drawn over by any topmost window; borderless fullscreen, Windows 11 "fullscreen optimizations" (the default) and fullscreen video work (decision 15).
- **Phase 4 — the toggle.** `UiPrefs.mascot?: { enabled: boolean }` in `prefs.json` (server-side, like every durable preference); a Preferences-page row "Peek mascot — show when a session needs your answer" (B6 makes that page live). The overlay page reads the pref in its poll and reports count 0 while off.
- Order inside C1: 2 → 4 → 3 (the Windows window last; it needs a `build-host.ps1` build and a user check on Windows). Runs through `/dev-flow`; phase 3 through `wsl-launcher`; `security-auditor` on phases 2 and 3 (token in a second served page, a new host window).

---

## Open decisions (user decides; do not settle silently)
1. ~~Old theme popover~~ DECIDED: drop the popover; Legacy UI removed entirely (see above). Amended 2026-09-10 evening (user): colour customisation itself returns as a Nocturne Settings page — see A7, B9 and decision 10.
2. ~~Data sources for Cost, Context, Account usage, Active skill, Lines changed in the status bar~~ DECIDED 2026-09-16 (user, the orchestrator's advice): the payload Claude Code already hands `server/statusline.mjs` on every turn (model, cost, context %, account usage %, lines changed, git branch). The script writes a per-session snapshot into the app data dir (like its branch cache: 0600, wiped at boot), the backend carries it in the session info, and the pane status bar renders the same checklist as Settings → Status bar. Active skill has NO source in that payload and is dropped honestly. Known consequence: the same values then stand twice on screen (Claude's own line inside the terminal and the pane bar under it) unless the user switches Claude's line off in the checklist. Rejected: Claude Code hooks (more moving parts; reconsider for decision 3), keeping only Claude's own line (B1 would then be nothing).
3. Source of "files the session is touching": Claude Code hooks, transcript watching, or something else.
4. ~~Where API keys live locally and how they reach the child process.~~ DECIDED 2026-09-18 (user, the orchestrator's advice): server-side `keys.json` (0600, like the GitHub token), one optional key per tool that reads an env var directly (Claude `ANTHROPIC_API_KEY`, Gemini `GEMINI_API_KEY`, Grok `XAI_API_KEY`), injected into that tool's child environment at spawn only; the page learns saved / not saved; Codex gets no field (a key alone does not sign it in — it signs in inside the terminal). Rejected: no storage; env-only detection.
5. Phosphor icons: inline SVG subset vs. package.
6. ~~pwsh.exe / cmd.exe via interop: allowed under the hard constraints in `PROJECT-SCOPE.md`? Check at B5.~~ DECIDED 2026-09-18 (user, the orchestrator's advice): Command Prompt = `cmd.exe` through interop like PowerShell, with a server-injected `/k pushd <windows path of the cwd>` so it starts in the project folder (cmd refuses a UNC working directory; measured); the path is allow-listed before injection. No `pwsh.exe` card (not installed; PowerShell stays `powershell.exe`, 2026-09-10). Rejected: plain cmd.exe landing in C:\Windows; dropping the card.
7. ~~A4 — command preview~~ DECIDED 2026-09-10 (user): left out; the 2026-07-25 "no commands or flags in the UI" rule stands.
8. ~~A4 — permission-card descriptions~~ DECIDED 2026-09-10 (user): cards show labels only, plus ONE small info button beside the "Permissions" label that opens a short plain explanation of all four modes. The only explanatory copy in the dialog.
9. ~~A4 — where the custom-command escape hatch lives (v3 has none)~~ DECIDED 2026-09-10 (user): a sixth tool card "Other" after Terminal, showing the existing command field.
10. ~~Terminal colours (B9), ask before A7~~ DECIDED 2026-09-13 (user, all four the orchestrator's advice): (a) presets + custom ground and text; (b) ground + text only, never the full ANSI palette; (c) terminal only, the app accent stays Nocturne, status colours never themed; (d) a Settings page only, no top-bar switch. Original question: (a) presets only, a free colour picker, or both; (b) which colours — ground + text only, or the full ANSI palette; (c) terminal only, or the app's accent colour too; (d) its place — a Settings page only, or also a quick switch in the top bar. Orchestrator's advice: a Settings page with a handful of presets (Nocturne first) plus custom ground and text colours; terminal only; status colours never themed.
11. ~~Files panel MEANING (ask before B2)~~ DECIDED 2026-09-15 (user, the orchestrator's advice): the Files panel becomes a real FILE BROWSER — root = the user's home directory, the project root when a session is focused; the v3 git-changes list survives as a second tab (`Changes`) beside `Files` and `Commits`. Same day: the panel opens without a session (header `Home`), and only one left panel at a time — the Projects drawer hides Files while open (Files returns when it closes). Both deviate from v3 on purpose. Original question: git-changes panel per project, a file browser rooted at home, or both (tabs).
12. C1 — which monitor holds the mascot when there are several: the primary, the one the app window is on, or the one with the mouse pointer.
13. C1 — a click on a mascot: the design's reaction only (laugh / wave), or also bring the app to the front on that session.
14. C1 — count semantics: one mascot per session waiting for an answer you have not looked at yet (= today's attention badges), max 3 — or only the session you last worked in.
15. C1 — accept the exclusive-fullscreen limit (no overlay can draw over a true exclusive-fullscreen game; borderless / optimised fullscreen and video are fine), or is a different mechanism wanted for that case.
16. C1 — reduced motion: the handoff describes no behaviour for the OS "reduce motion" setting, yet the overlay's idle bob/blink run forever at the monitor edge; the app's own CSS honours the setting everywhere. Add it (still the same art, no motion), defer to C1, or decline.

## Suggested order
A1 → A2 → A3 → A4 → A4b → A5 → A6 → A7 → A8, then A11 → A10 → A9 → A10b → A9b (user's 2026-09-15/16 priorities) → B2 + A9c (pulled forward 2026-09-16, user's ask) → B1 → B5 → B10 → B10a (user's ask 2026-09-20) → B3 → B4 → B6 → B9 → B7 → B8 → C1 (last, phase 1 already landed 2026-09-15).
B5 early because it unblocks real use of the new dialog; B2–B4 form one git/editor cluster.

---

## Status history

The running status paragraph this plan carried until 2026-09-20, kept verbatim; from then on the
table at the top is the status and the vault's work log is the history.

(2026-09-20) B10a landed (multi-select + permanent delete; spec `.claude/plans/nocturne/PLAN-B10a.md`), B10 landed (real file copy into WSL + Copy to the Windows clipboard; spec `.claude/plans/nocturne/PLAN-B10.md`; Windows check owed) and B5 landed (dialog live for every tool; spec `.claude/plans/nocturne/PLAN-B5.md`; verify-terminal V1–V7 PASS; a kill-escalation ladder added after Gemini CLI survived DELETE; Windows check owed to the user). Earlier: B1 landed and user-verified on Windows ("alles werkt"; pane status bar on the statusline snapshot, default = the bar on and Claude's line off; spec `.claude/plans/nocturne/PLAN-B1.md`); next B5 on the user's word; B2 + A9c landed and user-verified (real Files panel, Changes tab, New file/folder); A9b landed and user-verified 2026-09-16. Earlier: A10 landed (editor as panes in the tab strip, verify-terminal 9/9, suite 1867; Windows check owed), A11 landed and user-verified, Files-panel rules (no session needed, one left panel) landed and user-verified; A9 started. Earlier:  A1, A2, A3 landed and user-verified on Windows (plus a fix round: copy chord, add existing folder). A4 landed and user-checked in the Windows dev window ("ziet er goed uit"). A4b landed 2026-09-13 and user-verified on Windows ("alles werkt keurig"). A5 landed 2026-09-13 (user: "file systeem ziet er goed uit"; live data stays B2/B3 after A8 — user's call 2026-09-13). A6 landed 2026-09-13 and user-verified on Windows ("alles goed"). Decision 10 settled 2026-09-13; A7 landed 2026-09-13 and user-verified on Windows 2026-09-14 ("al good"; Settings five pages incl. Terminal colours mock, Add-a-project dialog, folder picker). A8 landed 2026-09-14 (alias layer deleted, every screen compared against v3, verify-terminal 1–9 PASS; Windows look of the boot card / shortcuts overlay / toast / restart confirmation / projects drawer owed to the user's dev window) — **Track A complete**. Next: Track B, B1 first (order kept per the user's 2026-09-13 call) — each part only on the user's "begin aan <id>". Out of that order on the user's direct 2026-09-15 ask: C1 phase 1 (the peek mascot as a standalone page, branch `mascot`) — C1 itself still starts only on "begin aan C1", after B8.
