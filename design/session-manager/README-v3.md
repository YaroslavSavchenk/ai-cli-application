# Redesign v3 (Nocturne)

`session-manager-v3.html` is the current design reference. It supersedes
`session-manager-prototype.html` (v2, "steam blend") for visual style. Open it in
a browser (the `_ds/` folder next to it must stay in place) to see every screen
and interaction live. Everything in it is mocked; the real app wires real data.

## Visual system
Tokens come from `_ds/nocturne-*/styles.css` (`--color-*`, `--space-*`,
`--radius-*`, `--shadow-*`). Inter for UI, JetBrains Mono for terminal, code and
all data values. Accent `--color-accent` (blurple) is used as outline and small
marks only, never as a fill. Radii 4/8/14 px. Elevation is a 1 px edge
(`--shadow-sm`) plus ambient dark, no heavy shadows. Semantic colours:
running/added `oklch(0.72 0.14 150)`, attention/working-on `oklch(0.85 0.12 80)`,
danger/removed `oklch(0.7 0.16 25)`.

## Copy rules
Plain sentences, no decorative separators (`·`, `|`, `⎿`, `▸` in text). Pluralise
counts ("1 pane", "2 panes"). States are words: "Working", "Needs your answer",
"Finished", "Needs you".

## Layout (top to bottom)
1. Top bar 48 px: logo + "Session Manager", Files / Projects / Sessions toggles,
   spacer, Connected dot, GitHub account chip, Settings gear (Phosphor), New
   session (outlined accent).
2. Middle row: optional Files panel (left, resizable 200–520 px by dragging its
   right edge), pane area, optional Sessions panel (right, 300 px).
3. Tab strip: one tab per screen (group of 1–4 sessions). Count pill when >1,
   "Needs you" when a member awaits input. Drag tab onto tab or pane to merge.
4. Statusline 26 px: "N sessions, N panes, N waiting for you, Latency, Up,
   Keyboard shortcuts".

## Pane
Card on `--color-neutral-900`, header 38 px (dot, name, project, state pill,
"Own tab" when in a split), terminal body on `oklch(0.16 0.015 275)`, then the
configurable status bar (label + mono value pairs, wraps), then a "Background
agents" table (name, task, time, tokens).

## Files panel (auto-opens when a session runs)
Tabs: Files, Commits. Header shows project name.
- Files: summary row `+N -N since last commit in X files`; tree with Phosphor
  folder icons and per-extension file badges (TS, TSX, JS, PY, MD, { }, PS,
  CSS, <>, SH, YML, RS, GO). Per file `+add -del`. Files the session is editing
  and their ancestor folders pulse amber (`pulse 1.2s`). Click a file to open
  it in the editor.
- Commits: list (message, hash, author, time, +/-). Click → full-screen commit
  view (replaces the pane area): title, author avatar, "committed <when>",
  branch, hash, "Open on GitHub", `N files changed +A -D` with a 5-block
  green/red bar, then one collapsible diff block per file (header with path,
  +/- and "Open file"; unified diff with line numbers and +/- colouring).
  "Back to sessions" returns.

## Editor (right of the terminal, 54 % width)
Tabs per open file (amber dot when unsaved), path, Save/Saved button, line
gutter + editable mono text area. Diff tabs from commits are read-only.

## New session dialog
Tool grid 2 per row (Claude Code, Codex, Gemini CLI, Grok, Terminal; hidden
ones come from Settings → Preferences). Name (optional) + Project. For AI tools:
Model, Effort, Permissions cards (Always ask, Auto edits, Read only, No prompts
in red), Start from (fresh / continue / resume a listed earlier session), and
an "needs an API key" notice with "Add key" when missing. For Terminal: Shell
cards Bash, Zsh, PowerShell (pwsh.exe via WSL interop), Command Prompt.
Command preview at the bottom.

## Add a project dialog
Tabs: New folder, Clone a repository, From GitHub (device-flow connect, repo
list with search, Clone with progress, Open, New repository).

## Settings
Left nav: Status bar (checklist, persisted), Preferences (tool visibility and
API keys, defaults: reopen tabs, confirm close, notifications, follow output),
Keyboard, Background service (version, uptime, Check for updates, Restart).

## App icon
`app-icon.svg`: dark rounded tile with a blurple chevron and a light cursor
block. Render to `.ico` with the existing launcher/make-icon script.
