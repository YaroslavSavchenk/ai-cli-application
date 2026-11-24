# What it does, and how

## How it works

A web app for running and managing multiple AI CLI sessions (Claude Code
first; the launched agent is a configurable command + args, so other CLIs
work too) side by side. A Node.js backend inside WSL2 spawns each session in
a real pseudo-terminal (node-pty), streams I/O over WebSocket, and serves a
vanilla-TypeScript frontend (xterm.js) with projects, launch presets, and
multi-pane tab layouts. Sessions are server-side objects: hiding a pane,
switching tabs, or reloading the page never ends them, and reattaching
replays the scrollback (its last 5 200 lines — what the terminal keeps).
The backend's lifetime is bound to UI presence (decided and implemented 2026-07-19; see
`memory/decisions/lifecycle-bound-backend.md`): closing the last app window
starts a ~30 s grace timer, after which the backend ends all sessions and
exits — nothing keeps running in the background. A crash-safe session
history keeps the sessions the app launched, across runs (up to 200 entries,
the oldest ended one dropping first), and can resume any of them (a Claude session resumes ITS OWN conversation: the
backend pins each launch with `--session-id <uuid>` and resumes with
`--resume <id>`).

## What it does

- **Sessions side by side.** Claude Code, Codex, Gemini CLI, Grok, a plain
  shell (Bash, Zsh, PowerShell, Command Prompt) or any command you type, each
  in a real terminal. Up to four panes per tab; drag a tab onto another to
  split, drag a pane header back to the tab strip to give it its own tab.
- **Says what each session is doing**, in words: Working, Waiting for you,
  Needs your answer, Finished. For Claude Code this comes from its own
  transcript, so the app knows when Claude is done with its turn.
- **A status bar under each Claude session** with what Claude Code itself
  reports — model, mode, branch, cost, context, usage, time, lines changed —
  and, if you switch it on, a table of the background agents it runs.
- **End a session from its pane** with the button top right, or from its tab
  or the Sessions panel; each asks once first unless you turn that off.
- **Files panel** on the real file system: browse, create files and folders,
  select several and delete them, drag or paste files in from Windows, copy
  files to the Windows clipboard; see what changed since the last commit and
  browse the commits with their diffs.
- **Editor panes** next to the terminals: open up to four files per pane,
  edit and save them; a file that changed on disk is never silently
  overwritten.
- **Projects** with a default model and permission mode, created from a new
  folder, a clone, or your GitHub repositories.
- **Settings** for the status bar, API keys, which tools the New session
  dialog offers, a few behaviours, the whole keyboard table, and the
  terminal's colours.

Also:

- **Sessions survive a restart or an update** of the app, and come back by
  resume after WSL itself stopped: [restart-and-recovery.md](restart-and-recovery.md).
- **In-app updates** for an installed copy: [install.md § Updating](install.md#updating).
