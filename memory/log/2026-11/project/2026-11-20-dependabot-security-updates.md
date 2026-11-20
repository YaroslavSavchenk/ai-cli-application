---
type: log
created: 2026-11-20
updated: 2026-11-20
tags: [project, dependencies, security, dependabot]
---
# 2026-11-20 — Dependabot security updates (v0.4.4)

**Asked (user):** "er zijn nieuwe versies van de apps die ai session manager
gebruikt … ik kreeg melding van github bot" — test on dev first, then
production, and check the installed app picks the update up.

## What was open

Six Dependabot alerts: vite ≤ 8.1.5 (2 high, 3 medium, 1 low — fs.allow
bypass, cross-origin middleware, launch-editor on Windows; fixed in 8.1.6)
and source-map-js < 1.2.2 (high, event-loop DoS; reached through
vite → postcss). PRs #2 (source-map-js 1.2.2) and #3 (vite 8.1.6).

## Done (branch `deps-dependabot-2026-11`)

`npm install vite@^8.3.8 ws@^8.23.0` — one bump instead of the two
Dependabot PRs: vite 8.3.8 carries postcss 8.5.33 → source-map-js 1.2.4.
`npm audit`: 0 vulnerabilities. Build green, suite 4249/4249.
verify-terminal on the dev backend driven over HTTP + WS (scratch driver):
checks 1–5, 7, 8, 9 PASS (claude 2.1.311 TUI); 6 is UI-only (user's DEV look).

## Lesson

"Apps die we gebruiken" + "github bot" = Dependabot alerts on our npm
dependencies, not the AI CLIs installed in WSL. Look at
`gh api repos/{owner}/{repo}/dependabot/alerts` first.
