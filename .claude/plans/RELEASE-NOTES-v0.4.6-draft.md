# v0.4.6 — When WSL goes down, the app says why and brings your sessions back

- **The app tells you why it stopped.** When WSL runs out of memory or shuts
  down while the app is open, the next start shows what happened — for
  example "WSL ran out of memory at 12:53 — python (2.7 GB) was stopped, and
  WSL shut down." — read from WSL's own system log.
- **One Restart button.** When the background service stops answering for
  10 seconds, a panel "The app stopped responding" appears with `Restart`:
  it starts WSL and the service again and opens a fresh window. The same
  button appears when Restart service ends with "did not come back".
- **Your sessions come back where they were.** After `Restart`, every session
  that was running is resumed automatically, in its old tab and pane. When
  you start the app from the desktop shortcut instead, it offers
  `Resume N sessions` (or `Dismiss`) rather than resuming by itself.
- **Memory pressure hits your sessions first, not the app.** When WSL runs
  short of memory, Linux now stops a process inside a session before the
  app's own background service or its session holder.
- **Steadier and quicker.** A malformed message can no longer stop the
  background service; terminal output, rendering and the log
  writer do less work per byte; dependencies are current.

The `Restart` button needs the new window, so it works from the first time
you start the app from the desktop shortcut after this update. Sessions stay
open through this update (since v0.4.5).

Verified with Claude Code 2.1.325.
