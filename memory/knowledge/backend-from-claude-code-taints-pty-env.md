---
type: knowledge
created: 2026-09-17
updated: 2026-09-17
tags: [sessions, env, claude-code, dev-workflow, resume]
---
# A backend started from inside a Claude Code session made every app session a "child"

Seen 2026-09-17 in the user's dev window, right after B1 landed: a claude
session launched by the app opened with

    ⚠ Transcript saving is off — inherited CLAUDE_CODE_CHILD_SESSION marker

**Cause.** The orchestrator starts the dev backend (and every scratch
backend for a verify gate) from its own Claude Code terminal. Claude Code
hands every child process a set of markers — `CLAUDECODE=1`,
`CLAUDE_CODE_CHILD_SESSION=1`, `CLAUDE_CODE_SESSION_ID`,
`CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_EXECPATH`,
`CLAUDE_CODE_MESSAGING_SOCKET` / `_TOKEN`, `CLAUDE_CODE_SESSION_ATTENDED`,
`CLAUDE_PID`, `CLAUDE_EFFORT` — and `ptyEnv()` in `server/sessions.ts`
spread `process.env` into every PTY. A claude inside such a PTY believed it
was nested: transcript saving off, so nothing said in it could ever be
resumed ([[session-history-resume]] prunes conversations whose transcript
is provably absent). The installed app, started by the Windows launcher,
never had this; only backends started from a Claude Code terminal did —
which includes every CDP verify gate that ran a real claude session.

**Fix.** `PARENT_CLAUDE_ENV` in `server/sessions.ts`: those markers are
deleted in `ptyEnv()`, named one by one. NOT `CLAUDE_CODE_*` as a prefix:
that prefix also carries the user's own configuration
(`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, …), which must
reach the session. Pinned in `tests/restart.test.ts` ("a PTY session never
inherits the handoff variables"): the markers are banned, a
`CLAUDE_CODE_USE_BEDROCK` survives.

**Rule.** Whenever the app spawns something on the user's behalf, ask which
parts of `process.env` describe the BACKEND'S parent rather than the user's
machine, and strip those ([[pty-requirements]] for the rest of the env
contract). New Claude Code versions may add markers; the warning text above
is the symptom to grep for.
