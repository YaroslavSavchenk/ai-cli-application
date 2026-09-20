---
type: log
created: 2026-07-25
updated: 2026-07-25
tags: [copy, design, github, security, dev-flow, milestone]
---
# 2026-07-25 (pt.2) — plain-language UI + owner-qualified clone paths

Continued from [[2026-07-25-pty-tail-rescue]]. The queued item was the **design
reconciliation delta**; recon collapsed it to almost nothing, and a new user
constraint arrived mid-session and became the bulk of the work.

## What the delta pass actually found

The refreshed prototype (`design/session-manager-prototype.html`, user-refreshed
2026-07-24) versus the built UI: **two real deltas**, both cosmetic — the
settings modal should adopt the gradient dialog header + accent-blue `Done`,
and the topbar Settings should be an icon-only gear placed first. Everything
else was either already identical or a deviation with a recorded reason (fake
clone-progress %, `usage %`, the grace countdown, the outdated GitHub captions).
Worth remembering as a pattern: **the reconciliation was ~1 % of the effort the
phrase "design reconciliation" implies**, because the two features built since
the refresh (status bar, Phase 2 GitHub) *were* the delta.

## The user constraint that took over: no commands in the UI

Mid-session, the user asked for no commands/flags/code anywhere in the GUI.
Decisions taken (see [[no-code-in-ui-copy]]): modes read **Always ask /
Auto-approve edits / Read-only planning / Never ask · dangerous**, the argv
preview became a **readable summary**, and — after I surfaced that the chosen
mode names were Dutch while the shell is English — the user chose **English
plain words** over a full Dutch UI or a mixed one.

Two forks the agents surfaced, both taken back to the user rather than guessed:
the clone tab's `$ git clone` preview (→ same summary treatment), and the
new-project `standard` option, which a developer refused to relabel because
`permFromDefaultMode('standard')` returns null — it behaves identically to *no*
default, so "Always ask" would have been a fresh lie. The user dropped the
option instead.

Also settled: [[owner-qualified-clone-paths]] (option b), closing the last open
decision in the scope doc.

## The gate earned its keep, three times

- **The scope reviewer** caught that `launchSummary()` re-read the three form
  controls instead of consuming `currentSpawn()`'s argv. Same rendered output,
  but divergence went from structurally impossible to merely conventional —
  and four documents (two code comments, DESIGN.md, my own decision note) were
  asserting the strong claim over the weak construction. Now derived from argv
  again. Its honest nuance: the summary can no longer *contradict* the POST
  body, but a brand-new unmodelled flag would be *omitted* — lossy by design,
  which is what "sentence instead of shell line" buys.
- **The security auditor** proved a directory-deletion primitive introduced by
  the clone-path change, and then found the **same shape pre-existing** on two
  untouched routes. Full write-up: [[path-normalization-delete-primitive]].
- **The test engineer** found the first normalization test was *vacuous for 4
  of 6 consumers* because an earlier guard shadowed them, and that the promise
  "a stored `standard` keeps working" leaned on nothing (the server could have
  started rejecting it with the suite still green). Both closed.

## Numbers

Suite **396 → 462**, two fix cycles, typechecks and vite build clean
throughout. Reviewers: scope CLEAN, security CLEAN (re-verified by re-running
its own PoCs against the fixed tree, not the fixer's transcript), tests green
across 3 consecutive runs with no flake.

## Lessons

**Ask the consistency question the moment a choice implies one.** The user
picked Dutch mode-names from a preview; the app is English. Surfacing the
mixed-language consequence *before* building took one question and reversed the
answer. A rename pass is exactly the kind of work where late consistency
questions are expensive.

**An agent's refusal can be the most valuable thing it reports.** The developer
that declined to relabel `standard` — citing behavior, not taste — turned a
copy task into a user decision that removed a meaningless option.

**Mutation testing keeps finding shadowed guards.** Second phase running where
"the test passes without the fix" was only discoverable by reverting each guard
individually. It is now the house style; keep paying for it.

## Still open

- **`/verify-terminal` live pass** (Windows/WebView2, not drivable from WSL) —
  unchanged from yesterday, now also covering the gear button, the settings
  header, and the two new summary blocks. The copy pass touched pane-header
  tags and the status-bar mode item, so a live look is worth it even though
  the mechanical resize chain was untouched.
- **GitHub OAuth App registration + `AI_SM_GITHUB_CLIENT_ID`** — still
  blocked on the user; nothing GitHub has had a live round-trip.
- Notes not acted on, recorded honestly: register-mode still stores the path
  verbatim (cosmetic/telemetry only, proven no fs consequence), and the
  lexical-`resolve()` symlink semantics in
  [[path-normalization-delete-primitive]].

Related: [[no-code-in-ui-copy]], [[owner-qualified-clone-paths]],
[[path-normalization-delete-primitive]], [[handoff-design-primary]],
[[2026-07-24-github-hardening]], [[agent-team-and-dev-flow]]
