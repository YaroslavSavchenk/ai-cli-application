---
type: decision
created: 2026-07-25
updated: 2026-07-25
tags: [design, frontend, copy, honesty]
---
# No commands, flags, or code in the UI

**Status:** decided (2026-07-25, user's call)

The GUI had been leaking CLI syntax into its chrome ever since the handoff was
transcribed: permission modes rendered as their literal CLI values
(`acceptEdits`, `plan`, `bypassPermissions`), the resume select read `continue
last conversation (--continue)`, the launch dialog's honesty surface was a
literal shell line (`$ claude --model opus --permission-mode acceptEdits
--continue`), the sessions drawer said `relaunch resumes claude with
--continue`, the git toggle's sample was `git init`, the startup-command
placeholder was `/caveman`, and the GitHub setup card named
`AI_SM_GITHUB_CLIENT_ID`.

**User's decision:** the GUI speaks plain human language. CLI syntax belongs in
the terminal, not in the chrome around it. Modes become **Always ask /
Auto-approve edits / Read-only planning / Never ask · dangerous** (narrow chips:
`always ask` / `auto edits` / `read-only` / `no prompts`), resume becomes
**Continue last conversation**, and the argv preview becomes a readable
summary — agent · model, a sentence describing what the mode and resume choice
actually do, and the target folder.

The display change is display-only by construction: emitted argv, the `Perm`
values, `shared/protocol.ts` and every persisted value are untouched. What runs
did not change; what the user reads did.

## Decisions inside the decision (all direct user answers, 2026-07-25)

- **UI language stays ENGLISH** with plain words — chosen over a full Dutch UI
  and over a mixed Dutch/English shell (the mode names were first picked in
  Dutch; when the mixed-language consequence was surfaced, the user chose
  English throughout).
- **The argv preview goes away** rather than being kept or hidden behind a
  "show command" disclosure. The honest statement of what will run survives as
  a sentence, not a shell line.
- **The custom-command field is exempt** — its content IS a command the user
  types; label, hint and placeholder stay as they are.
- **In scope too:** the `git init` sample, the `/caveman` placeholder, the
  drawer's `--continue` copy, and `AI_SM_GITHUB_CLIENT_ID` in the GitHub setup
  card (the variable name belongs in the README, where acting on it belongs).
- **The clone tab's `$ git clone <url> <dest>` preview** gets the same treatment
  as the launch preview — a readable summary (`copies <url> into folder:
  <dest>`). The pasted URL stays visible: it is the user's own input, not code.
- **The new-project "Default permission mode" select drops its `standard`
  option** (2026-07-25, after the developer surfaced an honesty conflict:
  `standard` behaves identically to *no* default — `permFromDefaultMode`
  returns null for it, so both defer to the global default). Only `no default`
  and `never ask · dangerous` remain visible — both lowercase, that select's
  own casing, unlike the launch dialog's sentence-case card titles; a
  `standard` already stored in `projects.json` keeps being accepted (pinned by
  a test after the gate found the promise leaned on nothing). Rejected:
  relabelling it "Always ask", which would promise enforcement the value does
  not deliver.
- **Out of scope:** statusline items (`ws <n> ms`, `pty ok`, `up HH:MM:SS`) —
  dense operator jargon, not commands; model ids (`opus`, `sonnet`, `haiku`,
  `fable`) are product names; terminal content is the terminal's.

## Rejected alternatives

- **Keep the argv preview** as the transparency claim ("exactly what spawns"):
  rejected — a readable summary can be equally honest without putting a shell
  line in a GUI.
- **Preview behind a collapsible "show command"**: rejected; the user wanted it
  gone, not folded.
- **Dutch or mixed-language labels**: rejected once the consistency cost of a
  two-language shell was explicit.

## Notes

- Docs, code, commit messages, tests and agent briefs are unaffected — this is
  a UI copy rule, and the README is where config-variable names now live.
- The honesty rule this repo already runs on ("real value or omit, never fake")
  is unchanged by it: a summary sentence still has to describe what actually
  runs, and `currentSpawn()` remains the single source feeding both the summary
  and the POST body, so the two still cannot diverge.

Related: [[handoff-design-primary]], [[anti-slop-design-direction]],
[[launch-dialog-custom-escape-hatch]], [[github-integration]]
