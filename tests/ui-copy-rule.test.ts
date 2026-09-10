/**
 * "No commands, flags, or code in the UI" (PROJECT-SCOPE, settled 2026-07-25) —
 * enforced across EVERY frontend module at once, instead of one module's
 * exported vocabulary at a time.
 *
 * WHY THIS UNIT AND NOT THE BUILT BUNDLE. A bundle-level scan sounds stronger
 * and is in fact weaker here: `web/dist/assets/index-*.js` is ~562 kB of which
 * the overwhelming majority is @xterm/xterm, whose own minified literals are
 * full of `--`-shaped strings, and after minification there is no way left to
 * tell OUR display copy from OUR argv tokens from a vendor's internals. So the
 * guard runs over `web/src/**\/*.ts` — the exact set of first-party modules the
 * bundle is built from — with comments stripped and every string/template
 * literal extracted. Anything the bundle renders from our code is in here.
 *
 * THE RULE, mechanically: a string literal that has a CLI/code SHAPE is only
 * allowed if it is listed in ALLOWED for that specific file, which is where the
 * three legitimate roles live —
 *   1. argv tokens that are composed or parsed (launch-args, util, sessions),
 *   2. CSS custom-property names, same `--x` shape by coincidence (terminal,
 *      theme, panes),
 *   3. the ONE construction-exempt display spot: the launch dialog's
 *      custom-command field and its literal command echo (user's call —
 *      that field's content IS a command).
 * The list is per FILE, so an argv token that is legitimate in `util.ts` still
 * fails the moment it appears in `settings.ts` or `github.ts`.
 *
 * This is a source-shape guard, not a substitute for reading the UI: it cannot
 * see a code-shaped string BUILT at runtime from non-code-shaped parts. The
 * manual pass in `.claude/skills/verify-terminal/SKILL.md` still owns "does it
 * read like a human wrote it".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(REPO_ROOT, 'web', 'src');

/** Stand-in for a `${…}` interpolation, so a template's literal text is still checked. */
const HOLE = '\u0000';

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

interface Lit {
  text: string;
  line: number;
}

/** Read one string/template literal starting at the quote `src[i]`. */
function readLiteral(src: string, i: number): { text: string; end: number } {
  const quote = src[i];
  let j = i + 1;
  let text = '';
  while (j < src.length) {
    const c = src[j];
    if (c === '\\') {
      text += src[j + 1] ?? '';
      j += 2;
      continue;
    }
    if (c === quote) return { text, end: j + 1 };
    if (quote === '`' && c === '$' && src[j + 1] === '{') {
      j = skipExpression(src, j + 2);
      text += HOLE;
      continue;
    }
    text += c;
    j += 1;
  }
  return { text, end: j };
}

/** Skip a `${ … }` expression, including nested braces, strings and templates. */
function skipExpression(src: string, i: number): number {
  let depth = 1;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === "'" || c === '"' || c === '`') {
      j = readLiteral(src, j).end;
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return j;
}

/** Every string/template literal in `src`, with comments skipped entirely. */
function literals(src: string): Lit[] {
  const out: Lit[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const startLine = line;
      const { text, end } = readLiteral(src, i);
      for (let k = i; k < end; k += 1) if (src[k] === '\n') line += 1;
      out.push({ text, line: startLine });
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

/** The shapes the rule bans from UI copy. */
const SHAPES: { re: RegExp; why: string }[] = [
  { re: /(^|[\s(])--[A-Za-z]/, why: 'a CLI long flag (or a CSS custom property)' },
  { re: /(^|\s)\$(\s|$)/, why: 'a shell prompt' },
  { re: /\b(acceptEdits|bypassPermissions)\b/, why: 'a raw CLI permission-mode value' },
  { re: /\bAI_SM_[A-Z0-9_]+/, why: 'a server env-var name' },
  { re: /\bgit (init|clone|commit|push|pull|status|checkout)\b/, why: 'a git command' },
];

function shapeOf(text: string): string | null {
  for (const s of SHAPES) if (s.re.test(text)) return s.why;
  return null;
}

/**
 * Code-shaped literals that are NOT display copy, keyed by file. Each entry is
 * an exact literal; adding one is a deliberate act that says "this string is an
 * argv token, a CSS property name, or the sanctioned custom-command echo".
 */
const ALLOWED: Record<string, string[]> = {
  // --- argv composition / parsing: these strings ARE the CLI contract --------
  'ui/launch-args.ts': [
    'acceptEdits',
    'bypassPermissions',
    '--model',
    '--permission-mode',
    '--effort',
    '--continue',
  ],
  'ui/util.ts': [
    '--model',
    '--model=',
    '--dangerously-skip-permissions',
    '--permission-mode',
    '--permission-mode=',
    'bypassPermissions',
  ],
  // --- CSS custom properties: same `--x` shape, entirely different job -------
  'ui/terminal.ts': [
    '--xt-bg',
    '--xt-fg',
    '--xt-cursor',
    '--xt-cursor-accent',
    '--xt-selection',
    '--xt-black',
    '--xt-red',
    '--xt-green',
    '--xt-yellow',
    '--xt-blue',
    '--xt-magenta',
    '--xt-cyan',
    '--xt-white',
    '--xt-bright-black',
    '--xt-bright-red',
    '--xt-bright-green',
    '--xt-bright-yellow',
    '--xt-bright-blue',
    '--xt-bright-magenta',
    '--xt-bright-cyan',
    '--xt-bright-white',
    '--fs-term',
    '--font-mono',
  ],
  'ui/theme.ts': ['--term-bg', '--xt-fg', '--xt-white', '--xt-bright-white', '--xt-cursor', '--xt-bright-black'],
  'ui/panes.ts': ['--split-col', '--split-row'],
  // The ONE display exemption (user's call, 2026-07-25) — the custom-command
  // field, whose content IS a command the user types — needs no entry since
  // 2026-09-06: its placeholder is a bare `htop` and the argv echo above it was
  // removed with the rest of the dialog's explanatory surface. The exemption
  // still STANDS as a rule; it simply has nothing code-shaped left to excuse.
};

const files = tsFiles(WEB_SRC);
const rel = (p: string): string => relative(WEB_SRC, p).split('\\').join('/');

test('the copy guard actually reads the frontend (non-vacuity: files, literals, and known copy are all found)', () => {
  // A scanner that silently returns nothing would make every check below pass.
  assert.ok(files.length >= 20, `expected the whole frontend, found ${files.length} modules`);
  for (const must of [
    'main.ts',
    'ui/launch.ts',
    'ui/launch-args.ts',
    'ui/keys.ts',
    'ui/settings.ts',
    'ui/github.ts',
    'ui/newproject.ts',
    'ui/sessions.ts',
    'ui/statusline-model.ts',
    'ui/util.ts',
  ]) {
    assert.ok(files.some((f) => rel(f) === must), `${must} must be scanned`);
  }
  // Canaries: real copy the scanner has to see, in files whose literals it must
  // not desynchronise on.
  const canaries: [string, string][] = [
    ['ui/launch.ts', 'New session'],
    ['ui/launch.ts', 'Continue last conversation'],
    ['ui/settings.ts', 'Settings'],
    ['ui/newproject.ts', 'Initialize git repo'],
    ['ui/launch-args.ts', 'always ask'],
    ['ui/launch-args.ts', 'WSL shell'],
    ['ui/launch.ts', 'Session'],
    // ui/keys.ts (2026-09-08) carries no display copy at all — only selectors
    // and protocol names — so its canaries are those: the scan has to be
    // reading the file for its "no CLI shapes" verdict on it to mean anything.
    ['ui/keys.ts', '.term-host'],
    ['ui/keys.ts', 'AltGraph'],
    ['ui/sessions.ts', 'start again'],
    // 2026-09-08: the keyboard help the user asked for — the settings panel's
    // KEYS excerpt, the statusline opener and the overlay's reason line. Plain
    // words plus key NAMES, which the copy rule allows (a chord is not a flag).
    // (Nocturne A2 removed the topbar `?` button that used to carry main.ts's
    // `keyboard shortcuts` literal; the label moved to ui/statusline.ts, so
    // main.ts is canaried on the top bar's own copy instead.)
    ['main.ts', 'New session'],
    ['main.ts', 'Session Manager'],
    ['ui/statusline.ts', 'Keyboard shortcuts'],
    ['ui/settings.ts', 'paste into a terminal'],
    ['ui/settings.ts', 'open a link printed in a terminal'],
    ['ui/settings.ts', 'all shortcuts'],
    [
      'ui/shortcuts.ts',
      'plain ctrl+v goes to the program running in the terminal, so pasting needs its own keys',
    ],
  ];
  for (const [file, text] of canaries) {
    const f = files.find((x) => rel(x) === file);
    assert.ok(f !== undefined, file);
    const found = literals(readFileSync(f, 'utf8')).some((l) => l.text === text);
    assert.ok(found, `${file}: the scanner should have found the literal ${JSON.stringify(text)}`);
  }
});

test('no frontend string literal has a CLI/code shape unless it is a listed argv token, CSS property, or the custom-command exemption', () => {
  const offenders: string[] = [];
  for (const file of files) {
    const key = rel(file);
    const allowed = new Set(ALLOWED[key] ?? []);
    for (const { text, line } of literals(readFileSync(file, 'utf8'))) {
      const why = shapeOf(text);
      if (why === null || allowed.has(text)) continue;
      const shown = JSON.stringify(text.split(HOLE).join('${…}'));
      offenders.push(`web/src/${key}:${line}  ${shown}  — ${why}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'UI copy must not contain CLI syntax (PROJECT-SCOPE, 2026-07-25). Offenders:\n  ' +
      offenders.join('\n  '),
  );
});

test('the allowlist has no stale entries — every listed exception still exists in its file', () => {
  // Keeps the exception list from silently outliving the code it excuses, which
  // is how a guard like this quietly stops guarding.
  const stale: string[] = [];
  for (const [key, entries] of Object.entries(ALLOWED)) {
    const file = files.find((f) => rel(f) === key);
    assert.ok(file !== undefined, `ALLOWED names a file that does not exist: ${key}`);
    const present = new Set(literals(readFileSync(file, 'utf8')).map((l) => l.text));
    for (const e of entries) {
      if (!present.has(e)) stale.push(`web/src/${key}: ${JSON.stringify(e)}`);
    }
  }
  assert.deepEqual(stale, [], `stale allowlist entries:\n  ${stale.join('\n  ')}`);
});

test('no frontend copy claims security the storage does not have (design gate, 2026-07-25)', () => {
  // A SECOND copy rule, enforced over the same scanned literals. The pasted-token
  // design gate fixed the honesty ceiling for anything we store: "stored on this
  // machine in the app's data folder, readable by your own user account", and
  // NOTHING stronger. An auditor verified there is no OS keyring in this
  // environment and that 0600 does not hold against the Windows side of WSL at
  // all (memory/knowledge/wsl-0600-not-a-boundary.md), so every word below would
  // be a false promise about a real credential. A caption claiming an OS keychain
  // was already shipped and corrected once in this project — this is the guard
  // that stops the third time.
  //
  // Comments are stripped by the scanner, so the module docs that NAME these
  // words while banning them do not trip it.
  const CLAIMS = [
    'keychain',
    'keyring',
    'encrypt', // covers encrypted / encryption
    'vault',
    'secure', // covers secure / securely / security
    'protected',
    'safe from',
  ];
  const hits: string[] = [];
  for (const file of files) {
    for (const { text, line } of literals(readFileSync(file, 'utf8'))) {
      const low = text.toLowerCase();
      for (const w of CLAIMS) {
        if (low.includes(w)) hits.push(`web/src/${rel(file)}:${line}  ${JSON.stringify(text)} — "${w}"`);
      }
    }
  }
  assert.deepEqual(
    hits,
    [],
    'UI copy must not claim a keychain, encryption or "secure" storage — the honest ceiling is ' +
      'file permissions plus discipline. Offenders:\n  ' +
      hits.join('\n  '),
  );
});

test('the exact strings the 2026-07-25 copy pass removed never come back', () => {
  // Named one by one because each was a specific user instruction, and because
  // some of them (a bare `/caveman`) have no code SHAPE for the scan above to
  // catch — only their identity makes them wrong.
  const BANNED = [
    'AI_SM_GITHUB_CLIENT_ID',
    '/caveman',
    'git init',
    'continue last conversation (--continue)',
    'relaunch resumes claude with --continue',
    'read-only planning mode',
    '$ claude',
    'connected · repo scope',
    // 2026-07-25, pasted-token path: the dormant card that HID the paste
    // affordance on exactly the servers it exists for, and the sign-in fine
    // print that called the device flow "secure". (The card's TITLE is not
    // listed: the replacement copy legitimately contains it as a substring of
    // "Signing in with GitHub is not set up on this server", which says
    // something narrower and true. These two lines are unique to the old card.)
    'The server needs a GitHub connection setting before this can be used',
    'one-time server setup · nothing to do in the browser',
    'secure device-flow sign-in',
    // 2026-09-06, the launch-dialog reduction (user: "far too many unnecessary
    // things ... plain short words, without further explanation"): the header
    // subtitle, the preset chip labels, the permission-card descriptions, the
    // custom-command hint, the footer note, and the drawer's previous-run copy.
    'spawns a real pty on the backend',
    'deep work · opus · auto edits · continue',
    'quick fix · sonnet · always ask',
    'yolo · opus · no prompts',
    'custom · any command',
    'before tools that need approval',
    'file changes go through without asking',
    'looks and plans, changes nothing',
    'no prompts at all · dangerous',
    'whitespace split',
    'opens in a new tab',
    'relaunch continues the previous conversation',
    'PREVIOUS RUN',
    'Relaunch previous run',
    'auto from project',
    'command is required for the custom preset',
    'start a new session with the same command',
  ];
  const hits: string[] = [];
  for (const file of files) {
    for (const { text, line } of literals(readFileSync(file, 'utf8'))) {
      for (const bad of BANNED) {
        if (text.includes(bad)) hits.push(`web/src/${rel(file)}:${line}  ${JSON.stringify(bad)}`);
      }
    }
  }
  assert.deepEqual(hits, [], `removed UI copy reappeared:\n  ${hits.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// The one place SERVER text is UI copy (2026-09-08)
// ---------------------------------------------------------------------------
//
// The REFUSED_* constants in server/restart.ts are the 422 body of
// POST /api/restart, and the restart dialog renders them VERBATIM. They are
// therefore display copy that happens to live in the backend, and the same rule
// applies: plain sentences, no flags, no command names, no file paths — and no
// pointer to an artifact the user cannot open from the GUI (server.log is the
// developer's channel; naming it on screen is an instruction the user cannot
// follow). The reason itself is logged beside every refusal.

test('the server-side restart refusals are UI copy and obey the UI copy rule', () => {
  const src = readFileSync(join(REPO_ROOT, 'server', 'restart.ts'), 'utf8');
  const refusals: { name: string; text: string }[] = [];
  for (const line of src.split('\n')) {
    const match = /^export const (REFUSED_[A-Z_]+) = (['"`])/.exec(line);
    if (match === null) continue;
    const quoteAt = line.indexOf(match[2] as string, match[0].length - 1);
    refusals.push({ name: match[1] as string, text: readLiteral(line, quoteAt).text });
  }

  // Non-vacuity: the scan must actually have found the constants it judges.
  assert.deepEqual(
    refusals.map((r) => r.name).sort(),
    ['REFUSED_BUILD', 'REFUSED_DEPENDENCIES', 'REFUSED_STANDBY'],
    'every REFUSED_* constant must be scanned',
  );

  const offenders: string[] = [];
  for (const { name, text } of refusals) {
    const why = shapeOf(text);
    if (why !== null) offenders.push(`${name}: ${JSON.stringify(text)} — ${why}`);
    // The artifact rule: a sentence on screen may not send the user to a file.
    for (const artifact of ['server.log', 'log file', 'the server log', 'node_modules', 'web/dist', '.json']) {
      if (text.toLowerCase().includes(artifact.toLowerCase())) {
        offenders.push(`${name}: ${JSON.stringify(text)} — names ${artifact}, which the GUI cannot open`);
      }
    }
    assert.ok(text.length > 0 && text.length <= 120, `${name} must be one short sentence`);
  }
  assert.deepEqual(
    offenders,
    [],
    'the 422 texts are rendered verbatim in the restart dialog. Offenders:\n  ' + offenders.join('\n  '),
  );
});

// ---------------------------------------------------------------------------
// Phase E: a release's ADDRESSES are backend-only — they never reach the page
// ---------------------------------------------------------------------------
//
// `UpdateRelease` carries `setupUrl` and `sumsUrl` so the BACKEND can download
// and verify. The page needs neither: it presses a button and reads a state.
// Keeping them out of the frontend entirely is what makes "no URL in the copy"
// a structural fact instead of a review habit — a string that is never read
// cannot be rendered, logged, put in a tooltip or built into a link.

/** The source with every comment blanked out, line numbers preserved. */
function codeOnly(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const { end } = readLiteral(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

test('phase E: no frontend module reads a release’s download addresses', () => {
  // Non-vacuity: the fields really are in the contract, so "not found in
  // web/src" means "not used", not "renamed and this test forgot".
  const protocolSrc = readFileSync(join(REPO_ROOT, 'shared', 'protocol.ts'), 'utf8');
  for (const field of ['setupUrl', 'sumsUrl']) {
    assert.ok(protocolSrc.includes(`${field}:`), `shared/protocol.ts must still declare ${field}`);
  }
  // …and the frontend really does read the rest of the release, so the scan is
  // pointed at a module that handles this object at all.
  const modelSrc = readFileSync(join(WEB_SRC, 'ui', 'update-model.ts'), 'utf8');
  assert.ok(modelSrc.includes('UpdateRelease'), 'ui/update-model.ts must still take the release');
  assert.ok(modelSrc.includes('release?.version'), 'the VERSION is the one field the UI prints');

  const offenders: string[] = [];
  for (const file of files) {
    // CODE only: the modules that must not USE these fields are precisely the
    // ones whose comments explain why, and a doc comment is not a code path.
    const src = codeOnly(readFileSync(file, 'utf8'));
    src.split('\n').forEach((line, i) => {
      for (const field of ['setupUrl', 'sumsUrl']) {
        if (line.includes(field)) offenders.push(`web/src/${rel(file)}:${i + 1}  ${field}`);
      }
    });
  }
  assert.deepEqual(
    offenders,
    [],
    'a release download address must never enter the page. Offenders:\n  ' + offenders.join('\n  '),
  );
});

test('phase E: the update dialog prints a version only through the shape gate', () => {
  // The tag comes from a GitHub release — the only string in this feature
  // written by someone who is not the user. `update.ts` may not interpolate it
  // itself; both sentences that carry it live in the model, behind VERSION_SHAPE.
  const updateSrc = codeOnly(readFileSync(join(WEB_SRC, 'ui', 'update.ts'), 'utf8'));
  assert.match(updateSrc, /releaseSentence\(st\.state\.update\?\.release\)/);
  assert.match(updateSrc, /updateLead\(st\.state\.update\?\.release\)/);
  assert.equal(
    /release\??\.version/.test(updateSrc),
    false,
    'the DOM half must not touch the raw version: the gate is in ui/update-model.ts',
  );
  const modelSrc = readFileSync(join(WEB_SRC, 'ui', 'update-model.ts'), 'utf8');
  assert.match(modelSrc, /export const VERSION_SHAPE = \/\^v\?\[0-9\]\[A-Za-z0-9\._\+-\]\{0,63\}\$\//);
});
