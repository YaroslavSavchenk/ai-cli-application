# B8 — Cleanup, memory, and a button to end a session from its pane; release v0.4.0

Status: LANDED 2026-09-22 (the code and the cleanup; suite 3436 → 3452; two parallel developers + janitor, scope review 0 blockers / 5 doc nits fixed by the orchestrator, 21 mutants / 0 live, verify-terminal E1–E6 PASS incl. a real claude session; the release v0.4.0 is PREPARED and waits for the user's word; log `memory/log/2026-09/nocturne/2026-09-22-nocturne-b8.md`); earlier: STARTED 2026-09-22 (user: "je mag beginnen aan B8 … En ik wil dat jij ook een knop toevoegen bij een sessie of terminal rechts boven of links boven om een sessie te sluiten. Doe dit samen in B8"; two decisions asked before the developers started, below).

Part B8 of `.claude/plans/PLAN-NOCTURNE.md`. Conventions: `.claude/plans/README.md`.

## What the user gets

1. **An End session button in every session pane's header**, top right
   (after the state pill and `Own tab`), on every session pane — also when
   the tab holds only that one pane. It ends the session exactly like the
   tab's × and the Sessions drawer's × do today (`killSession`), and
   follows the Settings switch `Confirm before ending a session` (B6,
   `getBehaviour().confirmEnd`): on → the first click arms (`Sure?`), the
   second ends; off → one click ends. Editor panes are untouched (they have
   their own close).
2. The last Legacy UI remnants gone, the design doc describing the app that
   exists (Nocturne), the scope doc and the vault current.
3. **v0.4.0 prepared** — release notes final, `npm run release -- v0.4.0
   --dry-run` green — and published ONLY after the user has seen it.

## Decided (user, 2026-09-22) — do not re-ask

- The pane button **ends the session** (not "close the pane, keep it
  running"; not a menu with both). Top right, after `Own tab`; follows the
  confirm setting.
- The release: **prepared, shown to the user, published only on their
  word.** No tag is pushed before that.

## Orchestrator defaults (recorded 2026-09-22, not asked; each a cheap flip ⟲)

- **The button's look:** a quiet icon button — Phosphor `X` (inline SVG,
  the existing inline subset; open decision 5 stays open), the header's neutral ink, danger ink on hover
  and while armed; `aria-label` + `title` = `End session`; armed state
  shows the word `Sure?` like every other `armButton` (one vocabulary). It
  is NOT part of the header's drag source (a mousedown on it never starts a
  drag). ⟲ a text button `End`.
- **The A3 comment that forbade it** ("Ending a session is NOT here …") is
  replaced with the user's decision and date — the reason it gave (one-click
  destructive control) is answered by the confirm setting.
- **The exited banner's `End session` stays** — on an exited pane the header
  button does the same thing; two doors to one action is fine (the tab × is
  a third).
- **`.dot.is-attn` pulse honours `prefers-reduced-motion`** (found in B11,
  pre-existing) — same opt-out as `.dot.is-work`.
- **Keyboard:** no new chord (ending has none today; the tab × and the
  drawer are keyboard-reachable). ⟲ add one.

## The cleanup (janitor + doc developer)

- **Legacy files:** the v2 handoff files in `design/session-manager/`
  (`README.md`, `session-manager-prototype.html`, `CLAUDE_CODE_PROMPT.md`;
  superseded by `README-v3.md` / `session-manager-v3.html` /
  `CLAUDE_CODE_PROMPT_v3.md` since 2026-09-10, consulted only for
  interaction details v3 lacked) are deleted, every reference updated (the
  plan-citation test must stay green; `memory/log/` keeps its paths —
  history). `design/archive/handoff-v1/` stays (archive by design,
  `memory/decisions/repo-layout.md`). Any `:Zone.Identifier` files that are
  TRACKED are removed; ignored ones are left.
- **Legacy code:** anything in `web/src/` or `server/` still serving the
  Legacy UI only (steam-blend names, dead role tokens, comments that describe
  the Legacy look as current). `web/src/ui/theme.ts` machinery stays (B9
  reuses it). Behaviour-preserving only.
- **`web/DESIGN.md`** rewritten for Nocturne: its top note says everything
  below still describes the Legacy UI — that ends. Keep the sections that are
  still binding (UI copy rule — no commands, flags, or code; the state words;
  the copy rules), rewrite the rest from what the app IS: tokens
  (`web/src/styles/tokens.css`, the 8 sections), type (Inter / JetBrains
  Mono), radii 4/8/14, 1 px edges, the accent's use, the state vocabulary
  incl. B11 (Working pulsing green / Waiting for you amber still / Needs your
  answer amber pulsing / Finished grey), the pane anatomy (header with the
  new End session button, terminal, status bar, agents table behind its
  switch), the tab strip, statusline, dialogs, Settings pages, terminal
  colours (B9: terminal-only, status colours never themed). Source of truth
  stays `design/session-manager/README-v3.md` + the v3 html/css. Shorter is
  better than exhaustive; no invented rules.
- **`.claude/PROJECT-SCOPE.md`:** stale Legacy statements, and the pane
  header bullet (the End session button). **`README.md`** (repo): the
  feature list if it describes the Legacy look.
- **Release notes** `.claude/plans/RELEASE-NOTES-v0.4.0-draft.md`: finalised
  — every `*mock until …*` marker resolved (all B-parts are live), Track B
  summarised in the user's terms (Files panel live, Commits live, Editor
  live, New session for every tool, file copy/drag/delete, Settings live,
  terminal colours, status bar on Claude's data, Background agents,
  Working/Waiting for you, End session button), removed-things list current;
  the title loses `(DRAFT …)`. The file keeps its path (no move outside
  `/restructure-repo`).

## Files (phase 1, `terminal-ui`)

`web/src/ui/panes.ts` (`buildSessionPane`: the button, the comment; drag
source excludes it), `web/src/ui/icons.ts` or wherever the inline Phosphor
subset lives (the `X` glyph if not there yet), `web/src/styles/app.css`
(button look, `.dot.is-attn` reduced motion). Tests: the button exists on a
session pane (one-pane tab and split), not on an editor pane; a click with
`confirmEnd` off calls the kill path once; with it on the first click arms
and the second ends; mousedown on it starts no drag; the reduced-motion rule
for `is-attn`.

## Phases

1. In parallel: `terminal-ui` (the button + reduced motion) and
   `generalist-dev` (DESIGN.md, PROJECT-SCOPE, README, release notes — docs
   only, no code). Own scratch subfolders.
2. `janitor` (Legacy files + Legacy code + stray files) after both, so it
   sweeps the final tree.
3. Reviews: `scope-reviewer` (all), `test-engineer` (the button; ~10 mutants,
   UI surface). No security review: no endpoint, no spawn, no path — the
   button calls the existing `killSession`. One fix round.
4. Final gate: `/verify-terminal` scoped to the pane header (the button ends a
   bash and a claude session; confirm on/off; a drag from the header still
   swaps panes; V1 unchanged); full suite; `npm run release -- v0.4.0
   --dry-run` after the landing push's CI is green.
5. Show the user: the release notes and the dry-run output; tag + publish
   only on their word (`npm run release -- v0.4.0`, then watch `release.yml`
   to its end).

## Gates

- `npm run typecheck`, `npm run build`, `npm test` green (baseline 3436).
- No new dependency, no env var, no new top-level folder.
- No behaviour change outside the button and the reduced-motion rule.

## Amendments after the reviews (2026-09-22; they win over the items above)

- **`armButton` restores child nodes, not text** (developer, accepted by
  scope): the icon button came back empty after `Sure?`; `aria-label` is
  dropped while armed so the visible word is the name. The two text call
  sites (exited banner, GitHub Disconnect) behave as before.
- **`armDrag`'s ignore check matches any `Element`** (developer, accepted):
  a press on the SVG glyph inside a button is not an `HTMLElement` and
  started a pane drag.
- Doc corrections from the scope review: the release notes' unsaved-text
  limit, DESIGN.md's `sure?` / armed-confirm wording, a stale test comment.

