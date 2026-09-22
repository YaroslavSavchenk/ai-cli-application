/**
 * Part B12 — the file-type icon classifier (`web/src/ui/files-model.ts`
 * `fileIconFor`), the path table that draws it (`web/src/ui/icons-files.ts`),
 * the editor-tab icon (`web/src/ui/slots-model.ts` `tabIcon`), and the
 * provenance every transcribed glyph must carry
 * (`.claude/plans/nocturne/PLAN-B12.md`).
 *
 * The rules, in order: whole name → backup suffix cut and classified again →
 * last extension → secret-sounding name → plain file glyph. Each rule has its
 * own test, and the user's own home-directory screenshot names have one that
 * pins every one of them.
 *
 * What this cannot tell: whether a glyph LOOKS right at 16px — that is the
 * browser check's job.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BADGE_KINDS,
  PLAIN_FILE,
  allFileIcons,
  fileIconFor,
  type FileIcon,
} from '../web/src/ui/files-model.ts';
import { FILE_ICON_PATHS } from '../web/src/ui/icons-files.ts';
import { DIFF_TAB_ICON, tabIcon } from '../web/src/ui/slots-model.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const is = (name: string, icon: FileIcon['icon'], kind: FileIcon['kind'], why?: string): void => {
  assert.deepEqual(fileIconFor(name), { icon, kind }, why ?? name);
};

// ---------------------------------------------------------------------------
// The user's screenshot (2026-09-22): every name there gets a sensible icon
// ---------------------------------------------------------------------------

test('the home-directory screenshot: every name has a meaningful icon, none is the plain file', () => {
  const expected: [string, FileIcon['icon'], FileIcon['kind']][] = [
    ['anthropic_api_key', 'lock-key', 'secret'],
    ['pi_askpass.sh', 'gnubash', 'sh'],
    ['pi_password', 'lock-key', 'secret'],
    ['id_ed25519', 'key', 'key'],
    ['id_ed25519.pub', 'key', 'key'],
    ['known_hosts', 'shield-check', 'cert'],
    ['known_hosts.old', 'shield-check', 'cert'],
    ['.bash_history', 'clock-counter-clockwise', 'history'],
    ['.bash_logout', 'gear-six', 'sh'],
    ['.bashrc', 'gear-six', 'sh'],
    ['.claude.json', 'json', 'json'],
    ['.gitconfig', 'git', 'git'],
    ['.motd_shown', 'flag', 'marker'],
    ['.profile', 'gear-six', 'sh'],
    ['.sudo_as_admin_successful', 'flag', 'marker'],
    ['.viminfo', 'vim', 'vim'],
    ['.zshrc', 'gear-six', 'sh'],
  ];
  for (const [name, icon, kind] of expected) {
    is(name, icon, kind);
    assert.notDeepEqual(fileIconFor(name), PLAIN_FILE, `${name} is known`);
  }
});

// ---------------------------------------------------------------------------
// Rule 1 — whole names
// ---------------------------------------------------------------------------

test('rule 1: a whole name beats its extension, case-insensitively', () => {
  is('Dockerfile', 'docker', 'docker');
  is('DOCKERFILE', 'docker', 'docker');
  is('Containerfile', 'docker', 'docker');
  is('.dockerignore', 'docker', 'docker');
  is('Makefile', 'hammer', 'config');
  is('GNUmakefile', 'hammer', 'config');
  is('CMakeLists.txt', 'cmake', 'c', 'not "a .txt"');
  is('package.json', 'npm', 'npm', 'npm’s file, not just JSON');
  is('package-lock.json', 'npm', 'npm');
  is('.npmrc', 'npm', 'npm');
  is('tsconfig.json', 'typescript', 'ts');
  is('go.mod', 'go', 'go');
  is('.gitignore', 'git', 'git');
  is('.gitattributes', 'git', 'git');
  is('.gitmodules', 'git', 'git');
  is('.git-credentials', 'lock-key', 'secret', 'git’s plain-text credential store is a secret');
  is('.zsh_history', 'clock-counter-clockwise', 'history');
  is('.python_history', 'clock-counter-clockwise', 'history');
  is('.vimrc', 'vim', 'vim');
  is('.editorconfig', 'gear-six', 'config');
  is('authorized_keys', 'shield-check', 'cert');
  is('.hushlogin', 'flag', 'marker');
});

test('rule 1, the name families: LICENSE*, README*, .env*, id_*, compose files and *rc dotfiles', () => {
  is('LICENSE', 'certificate', 'text');
  is('LICENSE.md', 'certificate', 'text', 'a licence is a licence before it is markdown');
  is('licence.txt', 'certificate', 'text');
  is('COPYING', 'certificate', 'text');
  is('LICENSE_APACHE', 'certificate', 'text', 'an underscore joins a licence name too');
  is('LICENSE-MIT', 'certificate', 'text');
  is('LICENSE.', 'certificate', 'text');
  is('README.md', 'book-open', 'md');
  is('readme', 'book-open', 'md');
  is('README.txt', 'book-open', 'md');
  is('.env', 'dotenv', 'config');
  is('.env.local', 'dotenv', 'config');
  is('.env.production', 'dotenv', 'config');
  is('id_rsa', 'key', 'key');
  is('id_ecdsa', 'key', 'key');
  is('id_ed25519_sk', 'key', 'key', 'the hardware-key twin');
  is('id_rsa.pub', 'key', 'key');
  is('Dockerfile.dev', 'docker', 'docker');
  is('api.dockerfile', 'docker', 'docker');
  is('docker-compose.yml', 'docker', 'docker');
  is('compose.yaml', 'docker', 'docker');
  is('.babelrc', 'gear-six', 'config', 'a run-control dotfile is configuration');
  is('.envrc', 'gear-six', 'config');
  is('.eslintrc.json', 'json', 'json', 'a dotfile WITH an extension takes the extension');
  // Near misses stay what their extension says.
  is('licenses.ts', 'typescript', 'ts');
  is('readme-generator.py', 'python', 'py');
  is('identity', PLAIN_FILE.icon, PLAIN_FILE.kind, 'id_ is a prefix with a key type, not any word');
});

// ---------------------------------------------------------------------------
// Rule 2 — backup suffixes
// ---------------------------------------------------------------------------

test('rule 2: a backup suffix is cut and the rest classified again', () => {
  is('known_hosts.old', 'shield-check', 'cert');
  is('.bashrc~', 'gear-six', 'sh');
  is('.bashrc.bak', 'gear-six', 'sh');
  is('main.ts.orig', 'typescript', 'ts');
  is('notes.txt.bak.old', 'file-text', 'text', 'repeatedly');
  is('config.OLD', PLAIN_FILE.icon, PLAIN_FILE.kind, 'case-insensitive, and a bare `config` is still unknown');
  is('secret.bak', 'lock-key', 'secret', 'the secret rule still sees the name');
  is('.bak', PLAIN_FILE.icon, PLAIN_FILE.kind, 'nothing left to classify');
  is('~', PLAIN_FILE.icon, PLAIN_FILE.kind);
  is('unknown.xyz.old', PLAIN_FILE.icon, PLAIN_FILE.kind);
});

test('rule 2, the edges: stacked and mixed-case suffixes, whole names under a suffix, and suffix-only names end', () => {
  // Stacked, in any order and any case, down to a language extension.
  is('a.py.bak.old', 'python', 'py', 'two suffixes stripped');
  is('a.py.old.bak~', 'python', 'py', 'three, `~` included');
  is('A.PY.BAK', 'python', 'py', 'a suffix is cut case-insensitively');
  is('main.ts~', 'typescript', 'ts', 'an editor’s tilde backup');
  is('main.ts~~', 'typescript', 'ts');
  // A whole name (rule 1) is found again under a suffix.
  is('known_hosts~', 'shield-check', 'cert');
  is('Makefile.orig', 'hammer', 'config');
  is('id_rsa.bak', 'key', 'key');
  is('README~', 'book-open', 'md');
  is('package.json.bak', 'npm', 'npm', 'the whole name, not just its .json');
  is('.env.local.bak', 'dotenv', 'config');
  // Only a SUFFIX is cut: in the middle it is just part of the name.
  is('a.bak.py', 'python', 'py');
  is('bold', PLAIN_FILE.icon, PLAIN_FILE.kind, '`old` without its dot is not a suffix');
  is('x.gold', PLAIN_FILE.icon, PLAIN_FILE.kind);
  // The cut happens before the secret rule: an extension under the suffix wins.
  is('token.json.bak', 'json', 'json', 'rule 3 on the cut name beats rule 4');
  is('api_key.old', 'lock-key', 'secret', 'nothing under the suffix: rule 4 still sees the name');
  is('password.txt', 'file-text', 'text', 'an extension beats a secret-sounding name');
  // Names made of nothing but suffixes classify as the plain file and END.
  for (const n of ['.old', '.orig', '~~', '~~~', '.bak.bak', '.old.bak~', 'BAK', '.BAK']) {
    assert.deepEqual(fileIconFor(n), PLAIN_FILE, JSON.stringify(n));
  }
});

test('rule 2 terminates fast on a NAME_MAX-long run of suffixes', () => {
  const started = Date.now();
  assert.deepEqual(fileIconFor('~'.repeat(255)), PLAIN_FILE);
  assert.deepEqual(fileIconFor(`a.rs${'.bak'.repeat(62)}`), { icon: 'rust', kind: 'rs' });
  assert.deepEqual(fileIconFor('.old'.repeat(63)), PLAIN_FILE);
  assert.ok(Date.now() - started < 1000, 'a bounded loop, not a runaway');
});

test('case never matters for whole names, dotfiles and name families either', () => {
  is('.BASHRC', 'gear-six', 'sh');
  is('.GitConfig', 'git', 'git');
  is('Known_Hosts', 'shield-check', 'cert');
  is('ID_ED25519', 'key', 'key');
  is('.ENV.LOCAL', 'dotenv', 'config');
  is('Package-Lock.JSON', 'npm', 'npm');
  is('ANTHROPIC_API_KEY', 'lock-key', 'secret');
  // A dotfile with no extension that nothing knows is plain — not "an
  // extension named after the whole dotfile".
  for (const n of ['.DS_Store', '.cache', '.claude', '.lesskey', '.Xauthority']) {
    assert.deepEqual(fileIconFor(n), PLAIN_FILE, n);
  }
  // …but a dotfile that DOES carry an extension takes it.
  is('.prettierrc.yaml', 'yaml', 'yml');
  is('.hidden.py', 'python', 'py');
});

test('a prototype-shaped name or extension never reaches Object.prototype', () => {
  for (const n of ['a.constructor', 'a.__proto__', 'a.toString', 'a.hasOwnProperty', 'constructor.old', '__proto__~', 'valueOf']) {
    assert.deepEqual(fileIconFor(n), PLAIN_FILE, n);
  }
  is('__proto__.ts', 'typescript', 'ts');
});

// ---------------------------------------------------------------------------
// Rule 3 — extensions
// ---------------------------------------------------------------------------

test('rule 3: A5’s families keep their colour, now with the language’s own logo', () => {
  is('main.ts', 'typescript', 'ts');
  is('App.tsx', 'typescript', 'ts');
  is('x.js', 'javascript', 'js');
  is('x.jsx', 'javascript', 'js');
  is('make-icon.mjs', 'javascript', 'js');
  is('a.py', 'python', 'py');
  is('notes.md', 'markdown', 'md');
  is('data.json', 'json', 'json');
  is('launch.ps1', 'terminal-window', 'ps');
  is('app.css', 'css', 'css');
  is('index.html', 'html5', 'html');
  is('run.sh', 'gnubash', 'sh');
  is('ci.yml', 'yaml', 'yml');
  is('ci.yaml', 'yaml', 'yml');
  is('main.rs', 'rust', 'rs');
  is('main.go', 'go', 'go');
});

test('rule 3: the broad table — code, config, text, data, media, archives, keys, locks', () => {
  is('Cargo.toml', 'toml', 'config');
  is('a.c', 'c', 'c');
  is('a.hpp', 'cplusplus', 'c');
  is('Main.java', 'openjdk', 'java');
  is('a.rb', 'ruby', 'ruby');
  is('a.php', 'php', 'php');
  is('App.vue', 'vuedotjs', 'vue');
  is('a.scss', 'sass', 'css');
  is('a.cs', 'dotnet', 'php');
  is('nb.ipynb', 'jupyter', 'rs');
  is('fix.patch', 'git', 'git');
  is('nginx.conf', 'gear-six', 'config');
  is('setup.cfg', 'gear-six', 'config');
  is('php.ini', 'gear-six', 'config');
  is('prod.env', 'dotenv', 'config');
  is('notes.txt', 'file-text', 'text');
  is('server.log', 'file-text', 'text');
  is('a.csv', 'table', 'sheet');
  is('a.xlsx', 'table', 'sheet');
  is('a.docx', 'file-doc', 'doc');
  is('a.pptx', 'presentation-chart', 'doc');
  is('a.xml', 'file-code', 'html');
  is('dump.sql', 'database', 'db');
  is('app.sqlite', 'database', 'db');
  is('a.png', 'image', 'image');
  is('logo.svg', 'image', 'image', 'an svg is a picture here, not markup');
  is('a.pdf', 'file-pdf', 'pdf');
  is('a.zip', 'file-zip', 'archive');
  is('archive.tar.gz', 'file-zip', 'archive', 'the LAST extension');
  is('a.mp3', 'music-note', 'media');
  is('a.mp4', 'film-strip', 'media');
  is('a.woff2', 'text-aa', 'font');
  is('a.exe', 'cpu', 'binary');
  is('server.pem', 'key', 'key');
  is('server.key', 'key', 'key');
  is('ca.crt', 'certificate', 'cert');
  is('yarn.lock', 'lock-simple', 'lockfile', 'a lockfile is not a secret');
  is('Cargo.lock', 'lock-simple', 'lockfile');
});

test('rule 3: the LAST extension counts, and case never matters', () => {
  is('ui-files-model.test.ts', 'typescript', 'ts');
  is('index.d.ts', 'typescript', 'ts');
  is('vite.config.MJS', 'javascript', 'js');
  is('App.TSX', 'typescript', 'ts');
  is('CI.YAML', 'yaml', 'yml');
  is('MAIN.TS', 'typescript', 'ts');
});

// ---------------------------------------------------------------------------
// Rule 4 — secret-sounding names, after the extension
// ---------------------------------------------------------------------------

test('rule 4: a name that says it holds a secret is a lock — unless an extension already said what it is', () => {
  for (const n of ['anthropic_api_key', 'OPENAI_APIKEY', 'gh-api-key', 'pi_password', 'db_passwd', 'client_secret', 'github_token', 'aws_credentials']) {
    is(n, 'lock-key', 'secret');
  }
  is('pi_askpass.sh', 'gnubash', 'sh', '"askpass" is not "password", and a script is a script');
  is('token.json', 'json', 'json', 'the extension comes first');
  is('secrets.yaml', 'yaml', 'yml');
});

// ---------------------------------------------------------------------------
// Rule 5 — nothing known
// ---------------------------------------------------------------------------

test('the handed-out icons are frozen: they are shared, so nobody can recolour every file like one', () => {
  for (const f of [...allFileIcons(), DIFF_TAB_ICON, fileIconFor('.bashrc'), fileIconFor('nothing.xyz')]) {
    assert.ok(Object.isFrozen(f), `${f.icon}/${f.kind}`);
  }
  assert.throws(() => {
    (fileIconFor('.bashrc') as { kind: string }).kind = 'config';
  }, TypeError);
  assert.equal(fileIconFor('.bashrc').kind, 'sh');
});

test('rule 5: a name nothing claims is the plain file glyph — never a guess, never an Object.prototype hit', () => {
  assert.deepEqual(PLAIN_FILE, { icon: 'file', kind: 'plain' });
  for (const n of ['', 'notes.xyz', 'config', 'constructor', 'toString', '__proto__', '.', '..', 'a.', '.foo']) {
    assert.deepEqual(fileIconFor(n), PLAIN_FILE, JSON.stringify(n));
  }
});

// ---------------------------------------------------------------------------
// Every icon can be drawn, every colour exists
// ---------------------------------------------------------------------------

test('every icon the classifier can hand out has path data, and no path is dead weight', () => {
  const used = new Set([...allFileIcons().map((f) => f.icon), DIFF_TAB_ICON.icon]);
  for (const id of used) {
    const p = FILE_ICON_PATHS[id];
    assert.ok(p !== undefined, `${id} has no path`);
    assert.ok(p.d.length > 10 && /^M/i.test(p.d), `${id}: a real path`);
    assert.ok(p.vb === 24 || p.vb === 256, `${id}: a known grid`);
  }
  // The bundle carries only what is used (PLAN-B12: "only the icons the
  // classifier and tools actually use").
  assert.deepEqual(Object.keys(FILE_ICON_PATHS).sort(), Array.from(used).sort());
});

test('every colour family has a token and a rule, and the chip backgrounds are gone', () => {
  const tokens = read('web/src/styles/tokens.css');
  const css = read('web/src/styles/app.css');
  const usedKinds = new Set(allFileIcons().map((f) => f.kind));
  assert.deepEqual(Array.from(usedKinds).sort(), [...BADGE_KINDS].sort(), 'every family is reachable');
  for (const k of BADGE_KINDS) {
    assert.match(tokens, new RegExp(`--badge-${k}-fg:`), `--badge-${k}-fg declared`);
    if (k !== 'plain') {
      assert.ok(
        css.includes(`.files-icon[data-kind='${k}'] { color: var(--badge-${k}-fg); }`),
        `app.css colours the ${k} family`,
      );
    }
  }
  assert.equal(/--badge-[a-z]+-bg/.test(tokens), false, 'no chip background survives');
  assert.equal(css.includes('.files-badge'), false, 'the text chip is gone');
});

test('an editor tab wears its file’s icon; a diff tab git’s', () => {
  assert.deepEqual(tabIcon({ kind: 'file', path: '/home/you/p/web/src/main.ts' }), { icon: 'typescript', kind: 'ts' });
  assert.deepEqual(tabIcon({ kind: 'file', path: '/home/you/.ssh/known_hosts.old' }), { icon: 'shield-check', kind: 'cert' });
  assert.deepEqual(
    tabIcon({ kind: 'diff', hash: 'a'.repeat(40), path: 'README.md', root: '/home/you/p' } as Parameters<typeof tabIcon>[0]),
    { icon: 'git', kind: 'git' },
  );
});

// ---------------------------------------------------------------------------
// Provenance: licences committed, every path cites a pinned source
// ---------------------------------------------------------------------------

test('every transcribed glyph cites its package at a pinned version, and the licences are committed', () => {
  for (const f of ['LICENSE-Phosphor.txt', 'LICENSE-LobeHub.txt', 'LICENSE-SimpleIcons.txt']) {
    assert.ok(existsSync(join(ROOT, 'web/src/assets/icons', f)), `${f} committed`);
  }
  assert.match(read('web/src/assets/icons/LICENSE-LobeHub.txt'), /MIT License[\s\S]*LobeHub/);
  assert.match(read('web/src/assets/icons/LICENSE-SimpleIcons.txt'), /CC0 1\.0/);

  for (const file of ['web/src/ui/icons-files.ts', 'web/src/ui/icons-tools.ts']) {
    const lines = read(file).split('\n');
    let entries = 0;
    lines.forEach((line, i) => {
      if (!/^ {2}'?[a-z0-9-]+'?: \{ vb: /.test(line)) return;
      entries++;
      const cite = lines[i - 1] ?? '';
      assert.match(
        cite,
        /(simple-icons@16\.32\.0|@phosphor-icons\/core@2\.1\.1|@lobehub\/icons-static-svg@1\.95\.1) `[a-z/-]+\/[a-z0-9-]+\.svg` \((CC0|MIT)\)/,
        `${file}:${i + 1} cites its source`,
      );
    });
    assert.ok(entries >= 6, `${file}: entries found (${entries})`);
  }
});

// ---------------------------------------------------------------------------
// The pane header (source scan: ui/panes.ts reaches @xterm/xterm and cannot be
// imported under node --test — see tests/ui-pane-a10.test.ts)
// ---------------------------------------------------------------------------

test('a session pane header carries the tool mark between the dot and the name, from the session’s command', () => {
  const src = read('web/src/ui/panes.ts').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const build = src.slice(src.indexOf('function buildSessionPane'), src.indexOf('\n}', src.indexOf('function buildSessionPane')));
  assert.match(build, /const tool = el\('span', 'pane-tool'\);\n\s*tool\.setAttribute\('aria-hidden', 'true'\);/);
  assert.match(build, /s\.hd\.replaceChildren\(dot, tool, title, /, 'dot, then the mark, then the name');
  const upd = src.slice(src.indexOf('function updateHeader'), src.indexOf('\n}', src.indexOf('function updateHeader')));
  assert.match(upd, /const toolId = info === undefined \? null : toolIconFor\(info\.command\);/, 'never guessed before the session is known');
  assert.match(upd, /pay\.tool\.dataset\.tool !== toolId/, 'redrawn only when it changes');
  assert.match(
    upd,
    /if \(toolId === null\) \{\s*if \(pay\.tool\.dataset\.tool !== undefined\) \{\s*delete pay\.tool\.dataset\.tool;\s*pay\.tool\.replaceChildren\(\);/,
    'a session that drops out of the list loses its mark',
  );
  assert.match(upd, /pay\.tool\.replaceChildren\(toolIcon\(toolId, 14\)\);/);
  // And the empty holder takes no room before the session is known.
  assert.match(read('web/src/styles/app.css'), /\.pane-tool:empty \{\s*display: none;\s*\}/);
});

// ---------------------------------------------------------------------------
// The builders: decorative SVG, coloured by CSS, logos optically matched
// ---------------------------------------------------------------------------

test('fileIcon / toolIcon build a decorative currentColor SVG; a 24-grid logo gets the glyphs’ inset', async () => {
  const { installDom } = await import('./fake-dom.ts');
  installDom();
  const { fileIcon } = await import('../web/src/ui/icons-files.ts');
  const { toolIcon } = await import('../web/src/ui/icons-tools.ts');
  const py = fileIcon(fileIconFor('main.py'));
  assert.equal(py.getAttribute('aria-hidden'), 'true');
  assert.equal(py.getAttribute('focusable'), 'false');
  assert.equal(py.getAttribute('fill'), 'currentColor', 'the colour is the token’s, never the icon’s');
  assert.equal(py.getAttribute('width'), '16');
  assert.equal(py.getAttribute('viewBox'), '-2 -2 28 28', 'Simple Icons: two units of air round the 24 grid');
  assert.equal(py.getAttribute('data-kind'), 'py');
  assert.ok(py.classList.contains('files-icon'));
  const txt = fileIcon(fileIconFor('notes.txt'), 14, 'pane-tab-icon');
  assert.equal(txt.getAttribute('viewBox'), '0 0 256 256', 'Phosphor: its own grid, untouched');
  assert.ok(txt.classList.contains('files-icon') && txt.classList.contains('pane-tab-icon'));
  const claude = toolIcon('claude', 14);
  assert.equal(claude.getAttribute('data-tool'), 'claude');
  assert.equal(claude.getAttribute('viewBox'), '-2 -2 28 28');
  const path = claude.children[0] as unknown as { getAttribute(k: string): string | null };
  assert.equal(path.getAttribute('fill-rule'), 'evenodd', 'LobeHub marks are drawn even-odd');
  assert.equal(
    (toolIcon('terminal', 14).children[0] as unknown as { getAttribute(k: string): string | null }).getAttribute('fill-rule'),
    null,
  );
});
