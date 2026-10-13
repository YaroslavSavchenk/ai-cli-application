# v0.4.1 — Project preferences, the full model pool, a smarter mascot

A follow-up to Nocturne: project preferences that finally do what they
say, every Claude model by its real version, a mascot that waits until
Claude is really done, and a faster app.

## Project preferences work, and you can change them

- The New session dialog now follows the project you pick: its model,
  permission mode and effort are filled in, also when you switch project
  inside the dialog. Before, the preferences of whichever project was
  selected when the dialog opened stuck. Anything you changed by hand
  stays as you set it.
- Every project row in the Projects drawer has an **Edit** button: name,
  model, permission mode (all four) and effort. "No preference" clears one.
  Renaming never moves the folder.
- The Add a project dialog offers the same three choices.
- Project preferences apply to Claude Code only. A "No prompts"
  preference no longer switches Codex or Gemini CLI to No prompts.

## Every Claude model, by version

- The Model list shows Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 4.5 on
  top, and every older model Claude Code knows under **Older models**
  (Opus 5, Sonnet 5, Fable 5, Opus 4.8 to 4.1, Sonnet 4.6 and 4.5).
- A model is pinned: Opus 5.5 always starts Opus 5.5. Preferences saved
  before this release (Opus, Fable …) read as the newest of that family.

## The mascot

- It stays transparent: the black box that could appear after a display
  change is gone.
- It stays on top of fullscreen windows, and no longer steals clicks
  meant for the app underneath.
- It waits until Claude is really done: while subagents or a workflow
  Claude started in the background still run, the session reads
  **Working** and no mascot comes.
- It comes when Claude asks you something — a question, a plan to
  approve or a permission prompt — and the pane reads **Waiting for you**.

## Faster

- Switching back to a tab is instant: its terminals stay alive in the
  background (up to 12), instead of replaying everything.
- Splitting, closing and moving panes keeps the terminals that stay.
- A reload sends a few kilobytes instead of a megabyte; the log stays
  quiet while nothing happens.
