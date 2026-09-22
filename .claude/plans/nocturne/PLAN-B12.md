# B12 — Icons everywhere: a real icon per file type, the real tool logos in one style

Status: LANDED 2026-09-22 (`7b37302`; user-verified on Windows 2026-09-22: "overal staan nu juiste icontjes, goed gedaan"; one fix round of 8 — scope 1 MUST + 1 SHOULD + NITs, the tab-signature colour bug from the test review; 10/10 mutants; verify-terminal T1–T4; log `memory/log/2026-09/nocturne/2026-09-22-nocturne-b12.md`); earlier: STARTED 2026-09-22 (user: "voeg overal icontjes toe … per filetype … ook aan ai tools"; decisions asked before the developer, below).

Part B12 of `.claude/plans/PLAN-NOCTURNE.md`. Conventions: `.claude/plans/README.md`.

## What the user gets

1. **Files panel and editor file tabs**: every file carries a small real icon
   for its type instead of a text chip (`TS`, `SH`, `{ }`) or the neutral `·`.
   Languages show their own logo (Python snake, TypeScript, JavaScript, Bash,
   Rust, Go, Markdown, HTML, CSS, YAML, Docker, Git …); everything else a
   category glyph (text page for `.txt`, key for `id_ed25519` / `.pub` /
   `.pem`, gear for `.bashrc` / `.profile` / `.gitconfig`-style config, lock,
   image, archive, PDF, database, spreadsheet, audio, video, history, …).
   The `·` is left only for a file nothing is known about, and even that is a
   plain file glyph now. Folders keep their filled folder glyph unchanged.
2. **Every place a tool is shown**: Claude Code, Codex, Gemini CLI and Grok
   show their REAL brand logo, all four in ONE style (same tile, same glyph
   size, same single-colour silhouette treatment), in place of `CC` / `CX` /
   `GM` / `GK`. Terminal gets a terminal glyph, Other a command glyph,
   shells (WSL / PowerShell / Command Prompt) a terminal glyph.
   Places: New session dialog tool cards, Settings → API keys and → Tools,
   the session tabs in the tab strip, the pane header, the Sessions drawer /
   history rows, the Background agents table.

## Decided (user, 2026-09-22) — do not re-ask

(a) File icons: real icons per type (VS Code-like), not wider text badges,
    and not icon + extension label. Also names without an extension
    (Dockerfile, Makefile, LICENSE, README) and dotfiles.
(b) AI tools: the real brand logos, "maar ze moeten in hetzelfde stijl zijn" —
    one uniform treatment across all four, not four differently coloured
    brand artworks side by side.
(c) Places: all four offered — Files tree + editor tabs; New session +
    Settings; session tabs + pane header; history + agents table.
(d) Source: inline SVG subset transcribed into the code, NO icon package
    (settles open decision 5 of the master plan). Licence texts committed.

## Design (orchestrator, within the decisions)

- **Sources, all permissive, transcribed as path data** (no runtime fetch, no
  npm dependency, no innerHTML — `createElementNS` like `web/src/ui/icons.ts`):
  - Category glyphs: Phosphor (MIT, already the app's icon family, licence at
    `web/src/assets/icons/LICENSE-Phosphor.txt`) — e.g. `file`, `file-text`,
    `key`, `gear-six`, `lock-simple`, `image`, `file-zip`, `file-pdf`,
    `database`, `table`, `music-note`, `film-strip`, `clock-counter-clockwise`,
    `terminal`, `terminal-window`, `certificate`, `book-open`, `command`.
    Fetch from `https://cdn.jsdelivr.net/npm/@phosphor-icons/core@<pinned version>/assets/regular/<name>.svg`.
  - Language/tool logos for files: Simple Icons (CC0) —
    `https://cdn.jsdelivr.net/npm/simple-icons@<pinned>/icons/<slug>.svg`.
  - AI tool logos: `@lobehub/icons-static-svg` (MIT) mono variants
    `claude`, `codex`, `gemini`, `grok` — one set (Codex: its own mark, not OpenAI's, on the scope review), so they share a drawing
    style. Licence text committed beside Phosphor's.
  - Every transcribed path cites package + version + icon name in a comment.
- **One style for tools**: the existing tile (`ns-mark`, `sg-mark` — size,
  radius, `is-agent` tint for Claude unchanged) holds the logo as a
  single-colour silhouette in the tile's own foreground colour. No brand
  colours on tool logos.
- **Files are coloured by type**: a file icon takes its type's foreground
  from the existing `--badge-<kind>-fg` tokens in `web/src/styles/tokens.css`;
  new kinds get new tokens in the same oklch lightness/chroma band. No chip
  background any more — the glyph IS the icon (16 px in rows, as the folder).
- **Classification** (pure, in `web/src/ui/files-model.ts`, unit-tested):
  exact name first (`Dockerfile`, `Makefile`, `LICENSE*`, `README*`,
  `.gitignore`/`.gitconfig`/`.gitattributes`/`.gitmodules`, `.bashrc`,
  `.zshrc`, `.profile`, `.bash_profile`, `.bash_logout`, `.bash_history`,
  `.zsh_history`, `.viminfo`, `.npmrc`, `.editorconfig`, `.env*`,
  `known_hosts`, `authorized_keys`, `id_rsa`/`id_ed25519`/`id_ecdsa`,
  `package-lock.json`, …); then a backup suffix (`.old`, `.bak`, `.orig`,
  `~`) is stripped and the rest classified again (`known_hosts.old` →
  known_hosts); then the extension, case-insensitive (a broad table: code,
  config `.conf .cfg .ini .toml .env`, text `.txt .log`, data `.csv .tsv .xml
  .sql .db .sqlite`, images, archives, pdf, office, audio, video, keys
  `.pem .key .pub .crt`, `.lock`); then a name heuristic for secrets
  (`password`, `secret`, `token`, `api_key`, `apikey` in the name → lock);
  else the plain file glyph.
- The chip's tooltip / accessible text: icons stay decorative (`aria-hidden`);
  the name beside them is the content (unchanged rule).
- Session → tool: derive from what the session already carries (kind /
  command basename, as the history and drawer already label it); unknown
  custom command → Other glyph. A tab holding several panes shows the icon of
  its FIRST slot; an editor tab labelled with a file shows that file's icon,
  a tab rooted on a FOLDER ("Home", a project folder) shows the folder glyph
  (orchestrator, on the scope review: a Docker logo beside "Home" read as
  "Home is Docker"); a diff tab shows the git mark. The
  status dot on tabs stays where it is — the icon is added, not swapped for it.
- The Background agents table: its rows are Claude's subagents — the tool
  logo goes once in the table's header, not on every row.

## Files (expected; line numbers drift)

- `web/src/ui/icons.ts` (or a new `web/src/ui/icons-files.ts` +
  `icons-tools.ts` if icons.ts grows past readability) — path data + builders.
- `web/src/ui/files-model.ts` — `badgeFor` → a classifier returning an icon
  id + colour kind (keep the export name stable if tests/imports rely on it,
  or update every caller).
- `web/src/ui/files.ts` (~1096, ~2986), `web/src/ui/editor-pane.ts` /
  `web/src/ui/tabs.ts` (editor file tabs, session tabs),
  `web/src/ui/launch-args.ts` (`TOOL_CARDS.mark` → an icon id),
  `web/src/ui/launch.ts` (~326), `web/src/ui/settings.ts` (~381, ~498, ~550),
  `web/src/ui/panes.ts` (pane header), `web/src/ui/history.ts` /
  `web/src/ui/sessions.ts` (drawer rows), `web/src/ui/pane-agents.ts`.
- `web/src/styles/*.css`, `web/src/styles/tokens.css`.
- `web/src/assets/icons/LICENSE-*.txt` (Simple Icons CC0 note, LobeHub MIT).
- Tests: `tests/` unit tests for the classifier (every rule above, the
  user's own screenshot names: `anthropic_api_key`, `pi_askpass.sh`,
  `pi_password`, `id_ed25519`, `id_ed25519.pub`, `known_hosts`,
  `known_hosts.old`, `.bash_history`, `.bash_logout`, `.bashrc`,
  `.claude.json`, `.gitconfig`, `.motd_shown`, `.profile`,
  `.sudo_as_admin_successful`, `.viminfo`, `.zshrc`), and a test that every
  icon id the classifier or `TOOL_CARDS` can return has path data.

## Not in this part

- No server change, no new endpoint, no dependency.
- Folder icons unchanged; no per-folder special icons (`.git`, `node_modules`).

## Gates

- `/frontend-designer` applies (terminal-ui has it preloaded).
- Test gate: UI surface → capped mutation probe (≤ 10 mutants) on the
  classifier.
- Browser check (rule 8): Files panel on the home dir (the user's screenshot),
  New session dialog, Settings → Preferences; at most three screenshots.
- `/verify-terminal`: the pane header and tab strip change → T1–T4 once at
  the end.
- Windows check by the user.
