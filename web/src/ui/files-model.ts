/**
 * Files panel model (Nocturne part A5) — every decision the panel makes about
 * SHAPE, with no DOM and no state import, so `node --test` can drive it.
 *
 * What lives here: the flat-path-list → tree build, the row flattening a
 * rendered tree needs (depth, indent, caret, which rows pulse), the
 * since-last-commit summary, the file-type icon classifier, and the plural
 * copy the two tabs print. What does NOT live here: anything that reads or
 * writes app state (the open-folder set is passed in), and the data itself
 * (the Changes tab's real `git diff --numstat` since part B2, through
 * `ui/fs-model.ts`'s `changesToFiles`; the Commits tab's real `git log` since
 * part B3, through `ui/commit-store.ts`).
 *
 * THE INPUT SHAPE WAS THE FUTURE ONE, AND IT HELD. `FileChange[]` is a flat
 * list of paths with `add`/`del`/`editing` — exactly what a numstat walk
 * produces — and the tree is derived, so B2 replaced the mock data without
 * changing one line here. Input ORDER is preserved (no sorting): git already
 * returns a stable order, and the panel renders exactly that order.
 *
 * The icon colours are `oklch()`. That is safe on purpose: they are CSS-only
 * marks in the chrome and never reach xterm's theme parser (tokens.css header,
 * and the google-fonts/oklch lesson) — they live in tokens.css as one
 * `--badge-<kind>-fg` per family and the classifier only names the family.
 */

/** One changed (or merely listed) file, as B2's `git diff --numstat` walk hands it over. */
export interface FileChange {
  /** Repo-relative path with `/` separators, e.g. `web/src/main.ts`. */
  path: string;
  /** Added lines since the last commit; absent = no diff. */
  add?: number;
  /** Removed lines since the last commit; absent = no diff. */
  del?: number;
  /**
   * The session is editing this file right now. Pulses amber. NOTHING SETS IT
   * since B2: which files a session is touching is plan open decision 3, the
   * user's to settle, so the pulse stays dark rather than guessing
   * (`ui/fs-model.ts` `changesToFiles` leaves it unset).
   */
  editing?: boolean;
}

/** A folder or file in the derived tree. */
export interface TreeNode {
  /** Full path from the root (the folder key the open-set uses). */
  path: string;
  /** Last segment — the only thing ever rendered. */
  name: string;
  dir: boolean;
  children: TreeNode[];
  add: number;
  del: number;
  editing: boolean;
}

/** One rendered row: a folder or a file, already flattened for the open state. */
export interface TreeRow {
  path: string;
  name: string;
  depth: number;
  /** Left padding in px — `8 + depth * 14`. */
  indent: number;
  dir: boolean;
  /** Folders only: is this folder open. */
  open: boolean;
  /** Disclosure glyph for a folder, '' for a file. Geometry, not text. */
  caret: '' | '▾' | '▸';
  hasDiff: boolean;
  add: number;
  del: number;
  /** This file is being edited (files only). */
  editing: boolean;
  /** This row pulses amber: an edited file, or a folder holding one. */
  busy: boolean;
}

/** The summary row's three numbers. */
export interface DiffSummary {
  add: number;
  del: number;
  /** How many files carry a diff. */
  files: number;
}

/**
 * The disclosure glyph of anything that folds: a tree folder (this module) and
 * a commit view's file block (ui/commit-view.ts). ONE definition, because it is
 * GEOMETRY, not text — it always lives in an `aria-hidden` span beside a
 * control that states its own `aria-expanded`, and the copy rules' allowlist
 * should never need a second entry for the same mark.
 */
export function caretGlyph(open: boolean): '▾' | '▸' {
  return open ? '▾' : '▸';
}

const ROW_INDENT_BASE = 8;
const ROW_INDENT_STEP = 14;

/**
 * How far in a row at `depth` sits, in px. GEOMETRY, like `caretGlyph` beside
 * it, and exported for the same reason: part B2's live file tree
 * (`ui/fs-model.ts` `fsRows`) draws in the SAME panel as this module's rows,
 * so the two must be one arithmetic and not two copies that agree today.
 */
export function rowIndent(depth: number): number {
  return ROW_INDENT_BASE + depth * ROW_INDENT_STEP;
}

// ---------------------------------------------------------------------------
// Tree
// ---------------------------------------------------------------------------

/**
 * Flat paths → a folder tree. Every segment but the last is a folder; a path
 * seen twice reuses its node. A folder's `add`/`del` are the sums beneath it
 * and its `editing` is true when ANY descendant is being edited — which is
 * what makes the amber pulse climb the spine without a second walk.
 *
 * A TRAILING SLASH MEANS A FOLDER (part B2, decided from the measured shape of
 * `git status --porcelain`): an untracked DIRECTORY arrives as ONE row,
 * `sub/`, because git reports the directory and not the files under it. So the
 * last segment of such a path is a folder node with NO children — which is
 * exactly what git said: something new is there, and nothing about what is
 * inside it. Splitting naively would have made it a FILE row called `sub`,
 * claiming a file that does not exist; giving it invented children would claim
 * knowledge nobody has.
 */
export function buildTree(files: readonly FileChange[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  for (const f of files) {
    const marked = f.path.endsWith('/');
    const segments = f.path.split('/').filter((s) => s !== '');
    if (segments.length === 0) continue;
    let parentChildren = roots;
    let prefix = '';
    for (let i = 0; i < segments.length; i += 1) {
      const name = segments[i] as string;
      const last = i === segments.length - 1 && !marked;
      prefix = prefix === '' ? name : `${prefix}/${name}`;
      let node = byPath.get(prefix);
      if (node === undefined) {
        node = { path: prefix, name, dir: !last, children: [], add: 0, del: 0, editing: false };
        byPath.set(prefix, node);
        parentChildren.push(node);
      }
      // Every node on the path carries the file's numbers, so a folder row
      // already knows its subtree's totals and whether it must pulse.
      node.add += f.add ?? 0;
      node.del += f.del ?? 0;
      node.editing = node.editing || f.editing === true;
      parentChildren = node.children;
    }
  }
  return roots;
}

/**
 * Tree → the rows actually drawn, for one open-folder set. A closed folder
 * hides its subtree entirely; a file row always knows whether it has a diff,
 * because that decides its ink.
 */
export function treeRows(
  nodes: readonly TreeNode[],
  openFolders: ReadonlySet<string>,
  depth = 0,
): TreeRow[] {
  const out: TreeRow[] = [];
  for (const n of nodes) {
    const indent = rowIndent(depth);
    if (n.dir) {
      const open = openFolders.has(n.path);
      // A folder with NOTHING under it gets no caret: since part B2 one exists
      // — git reports an untracked DIRECTORY as a single `sub/` row and says
      // nothing about its contents — and a disclosure mark that opens onto an
      // empty tree is a promise the data cannot keep.
      const foldable = n.children.length > 0;
      out.push({
        path: n.path,
        name: n.name,
        depth,
        indent,
        dir: true,
        open,
        caret: foldable ? caretGlyph(open) : '',
        hasDiff: false,
        add: 0,
        del: 0,
        editing: false,
        busy: n.editing,
      });
      if (open) out.push(...treeRows(n.children, openFolders, depth + 1));
    } else {
      out.push({
        path: n.path,
        name: n.name,
        depth,
        indent,
        dir: false,
        open: false,
        caret: '',
        hasDiff: n.add > 0 || n.del > 0,
        add: n.add,
        del: n.del,
        editing: n.editing,
        busy: n.editing,
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Summaries and copy
// ---------------------------------------------------------------------------

/** Totals for the summary row: only files that actually carry a diff count. */
export function diffSummary(files: readonly FileChange[]): DiffSummary {
  let add = 0;
  let del = 0;
  let changed = 0;
  for (const f of files) {
    const a = f.add ?? 0;
    const d = f.del ?? 0;
    add += a;
    del += d;
    if (a > 0 || d > 0) changed += 1;
  }
  return { add, del, files: changed };
}

/** `since last commit in 1 file` / `… in 7 files` (copy rule: counts pluralise). */
export function summaryText(files: number): string {
  return `since last commit in ${files} ${files === 1 ? 'file' : 'files'}`;
}

/**
 * `main, 1 commit` / `main, 214 commits` — the branch is the only name in it,
 * and the count is `rev-list --count`, not the number of rows on screen (B3:
 * the list holds one page of ten). A repository with no branch to name says
 * `Detached`, which `branchLabel()` in `ui/commit-model.ts` decides.
 */
export function commitsHeaderText(branch: string, count: number): string {
  return `${branch}, ${count} ${count === 1 ? 'commit' : 'commits'}`;
}

// ---------------------------------------------------------------------------
// File-type icons (part B12 — replaced A5's text chips)
// ---------------------------------------------------------------------------

/**
 * Colour families. The ICON can differ inside a family (`.tsx` and `.ts` share
 * the TypeScript logo; Kotlin wears the PHP purple) — the family only decides
 * the one custom property `--badge-<kind>-fg` that app.css maps onto the glyph.
 * The first twelve are A5's own; the rest arrived with B12 in the same oklch
 * band. There is no background any more: the glyph IS the icon.
 */
export const BADGE_KINDS = [
  'ts',
  'js',
  'py',
  'md',
  'json',
  'ps',
  'css',
  'html',
  'sh',
  'yml',
  'rs',
  'go',
  'git',
  'docker',
  'c',
  'java',
  'ruby',
  'php',
  'vue',
  'npm',
  'vim',
  'config',
  'text',
  'key',
  'secret',
  'cert',
  'image',
  'archive',
  'pdf',
  'doc',
  'sheet',
  'media',
  'db',
  'history',
  'marker',
  'binary',
  'font',
  'lockfile',
  'plain',
] as const;
export type BadgeKind = (typeof BADGE_KINDS)[number];

/**
 * Every glyph the classifier can hand out. Language and tool LOGOS are Simple
 * Icons slugs (CC0); CATEGORY glyphs are Phosphor names (MIT, the app's icon
 * family). `ui/icons-files.ts` holds one path per id — typed as a Record over
 * this union, so a missing path is a compile error, and a unit test checks it
 * again at runtime.
 */
export type FileIconId =
  // Simple Icons
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'markdown'
  | 'json'
  | 'css'
  | 'html5'
  | 'gnubash'
  | 'yaml'
  | 'rust'
  | 'go'
  | 'docker'
  | 'git'
  | 'c'
  | 'cplusplus'
  | 'openjdk'
  | 'ruby'
  | 'php'
  | 'kotlin'
  | 'swift'
  | 'dotnet'
  | 'vuedotjs'
  | 'svelte'
  | 'toml'
  | 'npm'
  | 'vim'
  | 'sass'
  | 'dotenv'
  | 'jupyter'
  | 'dart'
  | 'haskell'
  | 'elixir'
  | 'scala'
  | 'r'
  | 'graphql'
  | 'terraform'
  | 'cmake'
  // Phosphor
  | 'file'
  | 'file-text'
  | 'key'
  | 'gear-six'
  | 'lock-simple'
  | 'lock-key'
  | 'image'
  | 'file-zip'
  | 'file-pdf'
  | 'database'
  | 'table'
  | 'music-note'
  | 'film-strip'
  | 'clock-counter-clockwise'
  | 'terminal-window'
  | 'certificate'
  | 'book-open'
  | 'hammer'
  | 'shield-check'
  | 'flag'
  | 'cpu'
  | 'text-aa'
  | 'file-doc'
  | 'presentation-chart'
  | 'file-code';

export interface FileIcon {
  readonly icon: FileIconId;
  readonly kind: BadgeKind;
}

// Frozen: the table's entries are SHARED (every `.bashrc` gets the same
// object), so a caller that mutated one would recolour every file like it.
const fi = (icon: FileIconId, kind: BadgeKind): FileIcon => Object.freeze({ icon, kind });

// The shared entries, so one type reads as one thing wherever it is reached.
const SHELL_CONFIG = fi('gear-six', 'sh');
const CONFIG = fi('gear-six', 'config');
const HISTORY = fi('clock-counter-clockwise', 'history');
const MARKER = fi('flag', 'marker');
const SSH_KEY = fi('key', 'key');
const TRUST_LIST = fi('shield-check', 'cert');
const SECRET = fi('lock-key', 'secret');
const GIT = fi('git', 'git');
const DOCKER = fi('docker', 'docker');
const NPM = fi('npm', 'npm');
const VIM = fi('vim', 'vim');
const TEXT = fi('file-text', 'text');

/**
 * The plain file glyph: a file nothing is known about. Still a real icon —
 * A5's centred `·` is gone — but the quietest one, so the typed files read
 * first.
 */
export const PLAIN_FILE: FileIcon = fi('file', 'plain');

/**
 * Rule 1 — whole names, lower-cased. What a file is CALLED says more than any
 * extension it has (`package.json` is npm's, not just JSON), and most dotfiles
 * have no extension at all. A Map, not an object: a file named `constructor`
 * must not find an entry on Object.prototype.
 */
const EXACT: ReadonlyMap<string, FileIcon> = new Map([
  ['dockerfile', DOCKER],
  ['containerfile', DOCKER],
  ['.dockerignore', DOCKER],
  ['makefile', fi('hammer', 'config')],
  ['gnumakefile', fi('hammer', 'config')],
  ['cmakelists.txt', fi('cmake', 'c')],
  ['.gitignore', GIT],
  ['.gitconfig', GIT],
  ['.gitattributes', GIT],
  ['.gitmodules', GIT],
  ['.gitkeep', GIT],
  // Git's plain-text credential store: a secret, whatever its name says.
  ['.git-credentials', SECRET],
  ['.bashrc', SHELL_CONFIG],
  ['.bash_profile', SHELL_CONFIG],
  ['.bash_login', SHELL_CONFIG],
  ['.bash_logout', SHELL_CONFIG],
  ['.bash_aliases', SHELL_CONFIG],
  ['.profile', SHELL_CONFIG],
  ['.zshrc', SHELL_CONFIG],
  ['.zshenv', SHELL_CONFIG],
  ['.zprofile', SHELL_CONFIG],
  ['.zlogin', SHELL_CONFIG],
  ['.zlogout', SHELL_CONFIG],
  ['.inputrc', SHELL_CONFIG],
  ['.bash_history', HISTORY],
  ['.zsh_history', HISTORY],
  ['.python_history', HISTORY],
  ['.node_repl_history', HISTORY],
  ['.psql_history', HISTORY],
  ['.mysql_history', HISTORY],
  ['.sqlite_history', HISTORY],
  ['.lesshst', HISTORY],
  ['.viminfo', VIM],
  ['.vimrc', VIM],
  ['.gvimrc', VIM],
  ['_vimrc', VIM],
  ['.npmrc', NPM],
  ['.npmignore', NPM],
  ['package.json', NPM],
  ['package-lock.json', NPM],
  ['tsconfig.json', fi('typescript', 'ts')],
  ['go.mod', fi('go', 'go')],
  ['go.sum', fi('go', 'go')],
  ['.editorconfig', CONFIG],
  ['.wslconfig', CONFIG],
  ['known_hosts', TRUST_LIST],
  ['authorized_keys', TRUST_LIST],
  ['authorized_keys2', TRUST_LIST],
  // Empty stamp files a login leaves behind: they mark that something
  // happened once, and hold nothing.
  ['.motd_shown', MARKER],
  ['.sudo_as_admin_successful', MARKER],
  ['.hushlogin', MARKER],
]);

/**
 * Rule 1, the name FAMILIES a Map cannot spell: `LICENSE.md`, `README.txt`,
 * `.env.local`, `id_ed25519` (and its `_sk` hardware twin), a `*rc` dotfile.
 * Checked in this order, after EXACT.
 */
const NAME_PATTERNS: ReadonlyArray<readonly [RegExp, FileIcon]> = [
  [/^(license|licence|copying)([._-].*)?$/, fi('certificate', 'text')],
  [/^readme(\..*)?$/, fi('book-open', 'md')],
  [/^dockerfile\..+$|^.+\.dockerfile$|^(docker-)?compose(\..+)?\.ya?ml$/, DOCKER],
  [/^\.env(\..+)?$/, fi('dotenv', 'config')],
  [/^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/, SSH_KEY],
  // `.xyzrc` is a run-control file by the oldest convention there is:
  // configuration, whichever program reads it.
  [/^\.[a-z0-9_.-]+rc$/, CONFIG],
];

/**
 * Rule 2 — a backup suffix is not a type. `known_hosts.old` is known_hosts;
 * the suffix is cut (repeatedly: `a.bak.old`) and the rest classified again.
 */
const BACKUP_SUFFIX = /(\.old|\.bak|\.orig|~)$/;

/** Rule 3 — the LAST extension, lower-cased. */
const EXT: ReadonlyMap<string, FileIcon> = new Map(
  (
    [
      // Languages: their own logo, on A5's colour families where one existed.
      [['ts', 'tsx', 'mts', 'cts'], fi('typescript', 'ts')],
      [['js', 'jsx', 'mjs', 'cjs'], fi('javascript', 'js')],
      [['py', 'pyw', 'pyi'], fi('python', 'py')],
      [['ipynb'], fi('jupyter', 'rs')],
      [['md', 'markdown', 'mdx'], fi('markdown', 'md')],
      [['json', 'jsonc', 'json5'], fi('json', 'json')],
      [['ps1', 'psm1', 'psd1', 'bat', 'cmd'], fi('terminal-window', 'ps')],
      [['css', 'less'], fi('css', 'css')],
      [['scss', 'sass'], fi('sass', 'css')],
      [['html', 'htm'], fi('html5', 'html')],
      [['xml', 'xsd', 'xsl', 'plist'], fi('file-code', 'html')],
      [['sh', 'bash', 'zsh', 'ksh'], fi('gnubash', 'sh')],
      [['fish', 'lua', 'pl'], fi('file-code', 'sh')],
      [['yml', 'yaml'], fi('yaml', 'yml')],
      [['rs'], fi('rust', 'rs')],
      [['go'], fi('go', 'go')],
      [['c', 'h'], fi('c', 'c')],
      [['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'], fi('cplusplus', 'c')],
      [['java'], fi('openjdk', 'java')],
      [['kt', 'kts'], fi('kotlin', 'php')],
      [['scala', 'sc'], fi('scala', 'ruby')],
      [['rb'], fi('ruby', 'ruby')],
      [['php'], fi('php', 'php')],
      [['swift'], fi('swift', 'rs')],
      [['cs', 'csproj', 'sln', 'fs', 'vb'], fi('dotnet', 'php')],
      [['vue'], fi('vuedotjs', 'vue')],
      [['svelte'], fi('svelte', 'rs')],
      [['dart'], fi('dart', 'go')],
      [['hs'], fi('haskell', 'php')],
      [['ex', 'exs'], fi('elixir', 'php')],
      [['r'], fi('r', 'ts')],
      [['graphql', 'gql'], fi('graphql', 'yml')],
      [['tf', 'hcl'], fi('terraform', 'php')],
      [['vim'], VIM],
      [['patch', 'diff'], GIT],
      [['dockerfile'], DOCKER],
      [['mk', 'mak'], fi('hammer', 'config')],
      // Configuration.
      [['toml'], fi('toml', 'config')],
      [['env'], fi('dotenv', 'config')],
      [['conf', 'cfg', 'ini', 'properties', 'service', 'desktop'], CONFIG],
      // Text and data.
      [['txt', 'log', 'rst', 'text'], TEXT],
      [['csv', 'tsv', 'xls', 'xlsx', 'ods'], fi('table', 'sheet')],
      [['doc', 'docx', 'odt', 'rtf'], fi('file-doc', 'doc')],
      [['ppt', 'pptx', 'odp'], fi('presentation-chart', 'doc')],
      [['pdf'], fi('file-pdf', 'pdf')],
      [['sql', 'db', 'sqlite', 'sqlite3', 'db3'], fi('database', 'db')],
      // Media.
      [['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg', 'avif', 'tif', 'tiff', 'heic'], fi('image', 'image')],
      [['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus'], fi('music-note', 'media')],
      [['mp4', 'mkv', 'mov', 'webm', 'avi'], fi('film-strip', 'media')],
      [['ttf', 'otf', 'woff', 'woff2'], fi('text-aa', 'font')],
      // Packed and compiled.
      [['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'jar', 'whl', 'deb', 'rpm'], fi('file-zip', 'archive')],
      [['exe', 'dll', 'so', 'dylib', 'bin', 'o', 'a', 'wasm'], fi('cpu', 'binary')],
      // Keys, certificates, locks.
      [['pem', 'key', 'pub', 'p12', 'pfx', 'gpg', 'asc', 'ppk'], SSH_KEY],
      [['crt', 'cer', 'der', 'csr'], fi('certificate', 'cert')],
      [['lock'], fi('lock-simple', 'lockfile')],
    ] as ReadonlyArray<readonly [readonly string[], FileIcon]>
  ).flatMap(([exts, icon]) => exts.map((e) => [e, icon] as const)),
);

/**
 * Rule 4 — a name that SAYS it holds a secret (`anthropic_api_key`,
 * `pi_password`) is shown as one when nothing above claimed it. After the
 * extension on purpose: `pi_askpass.sh` is a script, and `token.json` is JSON.
 */
const SECRET_NAME = /password|passwd|secret|token|api[_-]?key|credential/;

/** Rules 1–3 on one (already lower-cased) name; null = nothing matched. */
function byName(lower: string): FileIcon | null {
  const exact = EXACT.get(lower);
  if (exact !== undefined) return exact;
  for (const [re, icon] of NAME_PATTERNS) if (re.test(lower)) return icon;
  const dot = lower.lastIndexOf('.');
  // A dotfile's leading dot is not an extension (`.env` is not "env");
  // a trailing dot is not one either.
  if (dot <= 0 || dot === lower.length - 1) return null;
  return EXT.get(lower.slice(dot + 1)) ?? null;
}

/**
 * The icon for a file NAME (not a path), case-insensitive: whole name →
 * backup suffix cut and classified again → last extension → secret-sounding
 * name → the plain file glyph. Pure; `ui/icons-files.ts` draws it.
 */
export function fileIconFor(name: string): FileIcon {
  let lower = name.toLowerCase();
  const direct = byName(lower);
  if (direct !== null) return direct;
  let cut = lower.replace(BACKUP_SUFFIX, '');
  while (cut !== lower && cut !== '') {
    const again = byName(cut);
    if (again !== null) return again;
    lower = cut;
    cut = lower.replace(BACKUP_SUFFIX, '');
  }
  if (SECRET_NAME.test(name.toLowerCase())) return SECRET;
  return PLAIN_FILE;
}

/**
 * Every icon the classifier can hand out, once each — for the tests that
 * check each has path data and each colour family a token and a CSS rule.
 */
export function allFileIcons(): FileIcon[] {
  const all = [
    ...EXACT.values(),
    ...NAME_PATTERNS.map(([, icon]) => icon),
    ...EXT.values(),
    SECRET,
    PLAIN_FILE,
  ];
  const seen = new Map<string, FileIcon>();
  for (const f of all) seen.set(`${f.icon}:${f.kind}`, f);
  return Array.from(seen.values());
}
