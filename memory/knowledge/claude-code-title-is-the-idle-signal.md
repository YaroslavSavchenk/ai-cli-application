---
type: knowledge
created: 2026-09-27
updated: 2026-09-27
tags: [claude-code, transcript, terminal-title, osc, session-state, mascot]
---
# Claude Code: an open question is not in the transcript; the terminal title is

**What went wrong:** C2 read `AskUserQuestion` / `ExitPlanMode` from the
session transcript. It passed every test and still failed live (user on
the DEV check: "Hij zegt dat die actief is, terwijl hij wacht op input").

**Why:** Claude Code 2.1.283 appends the question's `tool_use` line only
AFTER the answer. A monitor on a live transcript saw the line (stamped
09:33:06) land at 10:23:39, together with its `tool_result`. The FILE ORDER
looks sequential, but the WRITE TIMING is not. Measuring "what is in the
file after the fact" proved nothing about "what is in the file while it
happens".

**What works:** the OSC 0 title Claude Code sets. Measured in real PTYs
(node-pty harness, env stripped of `CLAUDECODE` / `CLAUDE_CODE_*`, trust
dialog = Down + Enter):

- `✳ <title>` = idle. This covers an open question, a permission prompt
  ("Do you want to proceed?"), a plan approval ("Ready to code?") and a
  turn end (also when a background shell is left running).
- A spinner (`◐`/`◑`, repainted about every second) = working: the model
  streaming AND a foreground tool running (a 20 s `sleep`).

So "the transcript says the turn runs" plus "idle title for ≥ 3 s" = Claude
waits for the user. The 3 s absorbs the transcript write lag at a turn's
end. Count them from the later of the idle stamp and the turn's start, or
an old idle stamp flips a fresh turn.

**How to apply:** before relying on any Claude Code file as a live signal,
MONITOR it while the event happens (a background loop sampling the file),
don't read it afterwards. The title is untrusted program output: derive a
boolean, never keep the text.

Other gotchas found on the way:

- "Always ask" in the launch dialog passes no `--permission-mode`, and
  2.1.283 then opened in auto mode (BACKLOG).
- `rm` / `touch` never prompted in auto mode.

Related: [[c2-mascot-waits-for-background-work]],
[[b11-session-turn-readout]].
