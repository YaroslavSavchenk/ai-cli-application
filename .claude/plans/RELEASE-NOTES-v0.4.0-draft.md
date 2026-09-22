# v0.4.0 — Nocturne

A new look for the whole app, and everything behind it live: the Files
panel on the real file system, commits, an editor, every tool in the New
session dialog, Settings, terminal colours, and a session state you can
read at a glance. Built in two tracks (`.claude/plans/PLAN-NOCTURNE.md`):
Track A drew the screens, Track B wired each of them to real data.

## The whole UI is new

The app now wears the **Nocturne** design: a dark indigo-neutral
instrument panel, Inter for the chrome, JetBrains Mono for the terminal
and every data value, a blurple accent used only as outline and small
marks, 1 px edges instead of shadows, radii 4/8/14. The previous look
("steam blend") is gone; it survives only as the git tag `legacy-ui`.

- Top bar (48 px): Files / Projects / Sessions toggles, connection dot,
  GitHub account chip, Settings, New session.
- Pane cards with a 38 px header, the terminal on its own ground, a status
  bar under each terminal.
- Tab strip (32 px) with a count pill and "Needs you"; statusline (26 px)
  with sessions, panes, waiting, latency, uptime and Keyboard shortcuts.
- Sessions panel with Running now / Earlier (a folder per project), and
  the Projects drawer in the same row vocabulary.
- Shortcuts overlay, update toast, restart confirmation and the boot
  overlay redesigned in the same language.

## What works now

- **Files panel, on the real file system.** Browse the folder of the pane
  you are in (or Home), create a new file or folder, select several rows and
  delete them (asked once, permanent, never a project's own folder), drag or
  paste files and folders in from Windows (one question per drop when names
  clash), and copy files to the Windows clipboard to paste them in Explorer
  (in the app window). Files the session is editing pulse amber. The
  Changes tab shows what changed since the last commit.
- **Commits, live.** The real history of the repository, ten at a time; a
  commit opens full screen with every file's diff, and Open on GitHub when
  the repository lives there.
- **Editor, live.** Open files in editor panes beside your terminals, up to
  four per pane; edit and save them. Unsaved text is never dropped without a
  question, a clean file follows its changes on disk, and a save onto a file
  that changed meanwhile asks whether to overwrite or load from disk.
- **New session, for every tool.** Claude Code, Codex, Gemini CLI and Grok,
  a Terminal (Bash, Zsh, PowerShell, Command Prompt) or any other command.
  A tool that is not installed says so; Gemini CLI and Grok take an API key
  you can save in Settings.
- **Settings, live.** Status bar (what each session shows, and where),
  Preferences (API keys, which tools the New session dialog offers, reopen
  tabs on start, confirm before ending a session, follow output), Keyboard
  (the whole shortcuts table), Terminal colours, Background service (version,
  uptime, check for updates, restart).
- **Terminal colours.** Six presets plus your own ground and text colour,
  applied to every open terminal at once and remembered. The app around the
  terminal and the status colours never change with them.
- **The status bar under a Claude session shows Claude Code's own data**:
  model, mode, branch, cost, context, account usage (amber from 80%), time,
  lines changed — each only when there is a real value.
- **Background agents.** Switch on the table under a Claude session to see
  the agents it runs in the background — what each is doing, for how long,
  and its tokens. At most four running agents are listed; the rest are
  counted (`+N working`, `+N finished`). Off by default, because Claude Code
  already shows its own list inside the terminal.
- **Working vs. Waiting for you.** A Claude session now says whether Claude
  is working (green, pulsing) or has finished its turn and is waiting for
  you (amber, still); "Needs your answer" (amber, pulsing) still means it
  asked you something. Only that last one counts in the statusline and the
  Sessions badge.
- **End session button in the pane header.** Top right on every session
  pane: it ends the session like the tab's × does, and asks once first
  unless you switched that off in Settings.

## Copy

Plain sentences everywhere; no decorative separators; counts are
pluralised; no commands, flags or configuration names in the UI.

## Removed

- The steam-blend look, its theme popover and the top-bar Theme button
  (colour customisation is now the Terminal colours Settings page).
- The top-bar `?` button (the statusline's Keyboard shortcuts button, the
  `?` key and Ctrl+Alt+/ open the overlay; Settings → Keyboard shows the
  same table).
- The Legacy stylesheet role tokens and the alias layer that carried them
  through the migration.

## Under the hood

- One token file (`web/src/styles/tokens.css`, 143 tokens in 8 sections)
  transcribes the handoff primitives verbatim; the xterm.js palette is
  built from it at runtime, so the terminal and the chrome are one system.
- Guard tests pin the whole thing: every `var()` is declared, every token
  is read (the handoff's unused ramp steps are the one named exception),
  retired names cannot come back, every class a module assigns has a rule
  outside `@media`, no colour literal in the stylesheet.
- Ending a session now stops everything it started: the whole process
  group gets the hang-up, then a terminate, then a kill.
- Suite: 1165 tests before Nocturne, 1745 after Track A, more than 3400 at
  this release.

## Known limits (honest)

- While Claude Code shows a permission prompt, the session reads Working
  until the prompt rings the bell — the prompt leaves no trace in the
  transcript.
- The status bar's Mode is the mode the session was started with; a change
  inside the session is not shown.
- Copy to the Windows clipboard works in the app window only; there is no
  drag out of the app, and the row menu's Paste points to the keyboard
  (Ctrl+V), where pasting files works.
- Delete is permanent; nothing goes to a recycle bin.
- Unsaved editor text lives only in the app window. Closing or reloading
  the window asks first; the background service stopping on its own after
  the last window closed cannot ask.
- Notifications when a session needs you are not there yet.
