Read `design_handoff_session_manager/README-v3.md` first. Then open
`design_handoff_session_manager/session-manager-v3.html` in a browser (keep the
`_ds/` folder next to it) and read `_ds/nocturne-*/styles.css`. This is the new
design for the front-end in `web/`. The HTML is a reference to recreate in our
real stack, not code to copy. Keep all real backend wiring (PTY over WebSocket,
presence, GitHub auth, git). Everything in the HTML is mocked data.

Also in that folder: `app-icon.svg`, the new application icon. Render it to a
multi-size `.ico` (16, 32, 48, 256) with the existing `launcher/make-icon.mjs`
script (extend it if it only takes PNG), replace the current `app.ico`, and make
sure the Windows launcher, the taskbar shortcut and the Edge app window all pick
up the new icon (clear the icon cache if needed). Do this in phase 1.

Migrate in phases. Each phase must build, pass typecheck and tests, and be
committed before the next one. Show me a screenshot after each phase.

1. Tokens, icon and shell
   Replace the current theme with the Nocturne tokens from `styles.css` (Inter
   for UI, JetBrains Mono for terminal and data). Rewrite top bar, tab strip,
   statusline and pane chrome to match the reference. Apply the copy rules from
   the README everywhere: no decorative separators (`·` `|` `⎿` `▸` in text),
   plural forms ("1 pane" / "2 panes"), state words ("Working", "Needs your
   answer", "Finished", "Needs you"). Ship the new icon.

2. New session dialog
   Tool grid two per row (Claude Code, Codex, Gemini CLI, Grok, Terminal).
   Name (optional) and Project on one row. For AI tools: Model, Effort,
   Permission cards (Always ask, Auto edits, Read only, No prompts in red),
   "Start from" with fresh / continue / resume of listed earlier sessions, and
   an API-key notice with "Add key" when a key is missing. For Terminal: shell
   cards Bash, Zsh, PowerShell (pwsh.exe via WSL interop), Command Prompt.
   Command preview at the bottom.

3. Files panel
   Left panel, resizable 200–520 px by dragging its edge, auto-opens when a
   session is running. Tabs Files and Commits. Files: summary row
   `+N -N since last commit in X files` from `git diff --numstat`, tree with
   Phosphor folder icons and per-extension file badges, `+/-` per file, and the
   files the session is currently touching (from Claude Code tool events) pulse
   amber together with their parent folders. Clicking a file opens the editor.

4. Commits
   List from `git log` (message, short hash, author, relative time, +/-).
   Clicking opens a full-screen commit view like GitHub, replacing the pane
   area: title, author, "committed <when>", branch, hash, "Open on GitHub",
   `N files changed +A -D` with a five-block green/red bar, then a collapsible
   unified diff per file from `git show`, each with an "Open file" button.
   "Back to sessions" returns.

5. Editor
   Opens right of the terminal at about 54 % width. Tabs per file with an amber
   dot when unsaved, path, Save / Saved button, line gutter, editable mono text.
   Save writes to disk. Diff tabs opened from commits are read-only.

6. Settings
   Left nav: Status bar (checklist of Model, Permission mode, Git branch, Cost,
   Context, Account usage, Active skill, Session time, Lines changed; persisted
   locally and rendered under each terminal as label + value pairs that wrap),
   Preferences (which tools are shown, API keys stored locally, defaults:
   reopen tabs, confirm before ending a session, notifications, follow output),
   Keyboard, Background service (version, uptime, Check for updates, Restart).

Match the reference visually as closely as possible; when unsure, open the HTML
next to the app and compare. Ask before adding any dependency other than a
terminal renderer. Reuse existing components and state patterns in `web/`.
