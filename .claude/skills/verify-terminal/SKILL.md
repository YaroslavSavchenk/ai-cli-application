---
name: verify-terminal
description: End-to-end verification that terminal sessions behave like real terminals. Use after changing the PTY layer, WebSocket protocol, or xterm.js frontend, and before declaring any terminal-related feature done.
---

# Verifying terminal correctness

Read `.claude/PROJECT-SCOPE.md` for context. The hosted CLIs are full TUIs;
"the text appears" is not a pass. A session passes only if it is
indistinguishable from a native terminal. Run every check below against a
live session (backend running, session open in the UI). Report each check as
pass/fail — never skip and assume.

The backend auto-picks its port — read it from the runtime discovery file
(`~/.ai-session-manager/runtime.json`) or the backend's startup output;
never assume a fixed one.

## Checks

1. **Echo & colors** — in the session run:
   `printf '\e[31mred \e[32mgreen \e[1mbold\e[0m normal\n'`
   Colors and bold render; reset works.
2. **Raw keys reach the app** — run `vim`, press `i`, type, `Esc`, `:q!`.
   Then run a long `sleep 100` and press Ctrl+C: the *sleep* dies, not the
   backend or the WebSocket. Arrow keys recall shell history.
3. **Alt screen** — open `vim` or `htop`, then quit. The previous scrollback
   is restored intact (alt-screen enter/exit works).
4. **Resize propagation** — with `htop` running, resize the pane (drag
   divider or switch layout). htop reflows to the new size with no torn
   rows. Then `echo $COLUMNS` must match the pane width. Repeat after
   moving the session to a different-sized pane slot.
5. **Disconnect survival** — start `for i in $(seq 300); do echo $i; sleep 1; done`,
   close the browser tab entirely, wait ~10s, reopen. The session is still
   counting and recent scrollback is shown (state lives server-side).
6. **Hidden-pane survival** — switch to another tab for ~30s while a command
   runs; switch back: output is complete, no frozen or duplicated frames.
7. **Attention signal** — run `sleep 2; printf '\a'`, switch tabs before it
   fires. The tab/pane shows the attention badge.
8. **Stress render** — run `find / 2>/dev/null | head -5000` and rapidly
   switch layouts during output. No garbage characters, no crash, scrollback
   stays bounded.
9. **The real thing** — launch an actual `claude` session from a project
   entry, confirm the TUI draws correctly, responds to keys, and its
   permission prompt (standard mode) is usable.

## On failure

Fix and re-run the FULL list, not just the failed check — resize and
alt-screen bugs love to regress each other. In your report, state which
checks ran, on which layout(s), and paste failing output verbatim.
