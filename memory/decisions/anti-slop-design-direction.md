---
type: decision
created: 2026-07-18
updated: 2026-09-23
tags: [design, frontend]
---
# Anti-slop design direction

**Status:** decided (2026-07-18)

The user's explicit, emphatic requirement (2026-07-18): the frontend must NOT
look like generic AI-generated UI — "no standard simple ai gui", and the
design process has to actively filter that out. This is a hard product
requirement, not a preference: a functional UI that looks like an AI template
is a **failed deliverable**.

Implementation: `.claude/skills/frontend-designer/SKILL.md` carries the
enforcement — a hard reject list (purple gradients, glassmorphism,
default-Tailwind combo, SaaS dashboard shell, emoji-as-icons, reflex fonts
including Space Grotesk), a required brief-before-code + tokens-first
process, and a final "distinguishable next to 100 AI dashboards?" filter
pass. The `terminal-ui` agent has that skill preloaded so it cannot do
visual work without it.

Chosen identity: the aesthetic derives from the terminal itself — lineage of
tmux, vim statuslines, DAWs, mission control. Dense, precise, keyboard-first;
xterm color scheme and app palette designed as one token system; structural
(not glowy) focus states; thin information-bearing chrome.

Realized direction v1 (2026-07-18 MVP): **"phosphor instrument panel"** —
warm graphite, mono-only, radius 0, 1px lines, no shadows/gradients, green
focus + amber attention accents. Replaced 2026-07-19.

Realized direction v2 (2026-07-19, SHIPPED): **"steam blend"** implemented —
Steam charcoal-blue surface ramp (#0b0e13 terminals → #28323e raised),
light blue (#66c0f4/#1a9fff) as the ONLY interactive accent, green/amber/
gray status semantics kept, bundled Barlow (OFL) for chrome + mono for all
data, radius ~3px, elevation only on the drag ghost. Full brief +
slop-filter pass in `web/DESIGN.md`; tokens in `web/src/styles/tokens.css`;
reference mockups in `design-mocks/` (removed 2026-09-21; the git tag
`legacy-ui` keeps them). Shipped together with the
sessions-as-tabs / drag-to-split interaction model.

**UPDATE 2026-07-19 — aesthetic under revision by user feedback**: after
first real use the user asked for a full GUI redesign — "it needs to feel
like a proper application or look like a good website." The ANTI-SLOP RULE
STANDS unchanged (that's the decision this note records); the *phosphor
skin* is what's being replaced. Phosphor's hard bans on radius/shadow were
skin commitments, not project law — a polished app direction may use
restrained radius/elevation if it stays distinctive. Direction chosen 2026-07-19 from rendered mockups (user: "mix of both",
blend defined by orchestrator): **"steam blend"** — Steam charcoal-blue
surface family with light-blue as the only interactive accent; from the
faithful mock: warmth, softer layering, green primary New-session button,
human status labels; from the terminal mock: mono-for-data typography,
dense rows, flat chrome (radius ~3px, elevation only on the drag ghost),
amber inverse attention badges; status semantics unchanged (green running /
amber attention / gray exited). Reference mockups committed under
`design-mocks/` (removed 2026-09-21, see above). Also requested the same day: a new interaction model —
sessions as tabs, drag a tab onto another to form split views
([[frontend-terminal-quirks]] plumbing still applies).

Related: [[agent-team-and-dev-flow]], [[pty-requirements]]

## From the scope doc (moved 2026-09-23)

Verbatim wording of the `.claude/PROJECT-SCOPE.md` bullet before part O1 condensed it; the scope doc holds the current rule.

### Features (decided) — Tabs and layouts

- **Tabs and layouts**: interaction model redesigned (decided 2026-07-19,
  user request; recorded in
  `memory/decisions/anti-slop-design-direction.md`): **sessions are tabs**,
  and dragging one tab onto another forms a split view. **Implemented
  2026-07-19**: every session lives in exactly one view (= tab); since
  Nocturne A10 (2026-09-15, user decisions) a view holds 0–4 SLOTS, each a
  session or (since A10b, the user's correction the same day) an EDITOR
  pane holding file and read-only diff TABS, mixed freely; a fixed `Home` tab
  (root = the user's home) is always first in the strip, never draggable,
  never closable, and may stand empty; a file opened from the Files panel
  becomes a TAB of the focused editor pane in the tab of its root folder
  (`Home` or the project's tab, created on demand; a new editor pane only
  when the tab has none; a file already open anywhere in that tab is
  raised, never duplicated; a project tab closes with its last pane unless
  it still holds a terminal). Drag a tab onto a tab/pane to merge into a
  split, drag a pane header to the strip to extract (sessions only), drag
  along the strip to reorder, drag a Files row onto a pane edge to open it
  in a split, onto the centre of an editor pane to add it there as a tab
  (the centre of a terminal pane refuses: "A terminal pane cannot hold
  files. Drop on an edge to split."), onto a folder tab's chip to append,
  drag a file TAB onto a pane edge to open it in a new editor pane beside
  (a pane whose last tab leaves frees its own pane) or onto another editor
  pane to move it there (reordering within a strip and dragging a tab to
  the bottom strip are not built), onto the
  empty pane area of an empty tab to open or merge there; files from
  Windows Explorer onto a folder row, the panel, a pane or an empty tab
  (A9; a TEXT drag from another program onto a terminal is cancelled so
  nothing reaches the PTY unbracketed — user decision 2026-09-15) — every drag
  has a keyboard/button equivalent (see the shortcuts overlay;
  Ctrl+Alt+Enter on a focused Files row opens it beside the focused pane,
  Ctrl+Alt+W closes the ACTIVE TAB of the focused editor pane — the last
  tab closes the pane — and does nothing on a terminal, Ctrl+Alt+PageUp /
  PageDown switch the file tab of the focused editor pane, Ctrl+Alt+M
  moves the active tab to the next editor pane of the tab or into a new
  split beside it; the count pill on a tab chip counts PANES, four files in
  one strip are one pane). The arrangement is client-local, persisted as localStorage
  schema v2 with migration from v1 (since Nocturne A5, 2026-09-13, the
  same v2 bag also carries the Files panel's wish and width; since A10 each
  view carries `root` and `slots`; since B4 (2026-09-22, user decision)
  EDITOR slots persist too — file tabs as `{kind:'file', path}`, diff tabs
  as `{kind:'diff', root, hash, path}`, at most 4 tabs per strip: the writer
  caps and the reader drops the tail, and 4 is the LIVE cap too since the B4
  amendment (2026-09-22, the user's Windows check "ik kan oneindig veel tabs
  open hebben, limiteer dat met 4" — `MAX_TABS = 4`, opening a fifth file
  evicts the tab in position 4, a MOVE into a full pane is refused), every
  entry gated on read
  (absolute path of at most 4096 characters, no NUL, 40-hex hash, absolute diff
  root, unknown kinds dropped) — unsaved TEXT is never written to the
  bag; `sessions: string[]` is still
  read as legacy, and the reader ignores unknown keys, so no bump; a
  pre-A10 build reading a post-A10 bag drops every view, a pre-B4 build
  drops a non-Home view whose only panes are editor panes). Since Nocturne
  B6 (2026-09-22, decision 3) the bag also carries `run`, the backend's
  `startedAt` at save time: with `Reopen tabs on start` OFF the views come
  back only for the run that wrote them (an F5, and the reload after
  `Restart service` or an update, which re-stamps the bag with the child's
  `startedAt` before reloading); a fresh app start opens on Home. ON
  (factory) restores them on every load — which, since the port is sticky
  (Architecture § Port), now includes a fresh app start. An unknown run
  (the runtime check failed) keeps the tabs, and a known stamp is never
  overwritten with null. Either way,
  sessions exist independently of tabs/panes/splits.
