# v0.4.3 — Claude Code's version in view, Always ask that asks

- **Claude Code's version is checked.** Settings → Background service shows
  which Claude Code you have and the newest version this app was tested
  with. If yours is older than the app needs, or newer than it was tested
  with, a notice says so and offers Check for updates. Hide it, and it
  stays hidden until a different Claude Code version shows up.
- **A Claude session that stops right after it starts says why.** The pane
  shows Claude Code's own first line, e.g. an unknown option, instead of a
  bare exit code.
- **"Always ask" really asks.** A new Claude session started with Always ask
  now tells Claude Code so explicitly; before, Claude Code could start in a
  mode of its own choosing.
- **The keyboard comes back to your terminal** after any dialog closes, also
  when the dialog was opened with nothing focused.
- **A second backend can no longer lose its runtime file** to a stopping
  one, from the app or from `launch.ps1 -Stop`.
- **Planted files in the data folder can't hang the app.** A named pipe or
  a link where a settings file belongs is refused and kept aside instead of
  read.

Verified with Claude Code 2.1.287.
