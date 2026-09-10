/**
 * Nocturne part A2 — the COPY rules of `design_handoff_session_manager/README-v3.md`,
 * enforced mechanically over the chrome that renders them: `web/src/main.ts`
 * and every module in `web/src/ui/`.
 *
 * Three rules live here, plus A2's two structural removals:
 *
 *   1. NO DECORATIVE SEPARATORS in UI text — `·`, `⎿`, `▸`, and a pipe used as
 *      a separator (` | `). Legacy chrome glued fragments together with them
 *      ("ACTIVE · 3", "model · mode · branch"); v3 uses words, spacing and
 *      hairlines instead. A small ALLOWLIST covers the non-text uses (a
 *      disclosure caret is geometry, not a sentence) and each entry carries
 *      its reason; a stale entry fails, so the list cannot quietly outlive
 *      what it excuses.
 *   2. THE STATE WORDS are fixed: `Working`, `Needs your answer`, `Finished`,
 *      `Needs you`. The Legacy vocabulary (`awaiting input`, `waiting for
 *      input`, `needs input`, a bare `running` as a LABEL) may not come back.
 *      Matched as exact label literals — `running` as an identifier, a
 *      protocol value (`status === 'running'`) or a CSS class stays legal, and
 *      the test proves it still recognises the difference.
 *   3. COUNTS ARE PLURALISED — the statusline says `1 session` / `2 sessions`,
 *      never `1 sessions` and never `session(s)`.
 *
 * And A2's removals: `main.ts` no longer wires the theme popover (no
 * `initTheme`, no `Theme` button), and the three chrome heights the new shell
 * is built on are pinned in `tokens.css` (48 / 32 / 26 px).
 *
 * WHY A SOURCE SCAN. There is no DOM in this runner; the chrome is built
 * against `document` inside `buildShell()` and the drawer renderers. So the
 * copy is read out of the source with comments stripped and every string /
 * template literal extracted (the same scanner idiom as
 * `tests/ui-copy-rule.test.ts`, which enforces the OTHER copy rule — no CLI
 * syntax — over all of `web/src`). Every check is paired with a non-vacuity
 * assertion so a scanner that silently reads nothing cannot make this file
 * pass.
 *
 * NOT claimed here: letter-spaced ALL-CAPS labels (a CSS property, invisible
 * to a literal scan — `text-transform`/`letter-spacing` are checked by eye),
 * nor that anything is positioned, sized or legible. That stays manual
 * (`.claude/skills/verify-terminal/SKILL.md`). `fmtUptime`'s own `<h>h <m>m` shape
 * is pinned in `tests/ui-util.test.ts` against the real function.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(REPO_ROOT, 'web', 'src');

/**
 * Stand-in for a `${…}` interpolation, so a template's literal text is still
 * checked. A character that cannot occur in source, deliberately: with a SPACE
 * here a signature join like `` `${a}|${b}` `` would read as ` | ` and be
 * reported as a separator it is not.
 */
const HOLE = '\u0000';

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

/**
 * The chrome A2 owns: the shell itself plus every UI module. Practically every
 * literal in these files can reach the DOM, which is why the scan is
 * deny-by-default with a named allowlist rather than an opt-in list of "copy"
 * strings — a new label must not be able to slip in unscanned.
 */
const FILES: string[] = [
  'main.ts',
  ...readdirSync(join(WEB_SRC, 'ui'))
    .sort()
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => `ui/${f}`),
];

const srcOf = new Map<string, string>(
  FILES.map((f) => [f, readFileSync(join(WEB_SRC, ...f.split('/')), 'utf8')] as const),
);

const litsOf = new Map<string, Lit[]>(FILES.map((f) => [f, literals(srcOf.get(f) as string)] as const));

const src = (f: string): string => srcOf.get(f) as string;

// ---------------------------------------------------------------------------
// The banned glyphs
// ---------------------------------------------------------------------------

const BANNED: { glyph: string; why: string }[] = [
  { glyph: '·', why: 'a middle-dot separator (U+00B7)' },
  { glyph: '⎿', why: 'a box-drawing bracket (U+23BF)' },
  { glyph: '▸', why: 'a triangular separator/caret (U+25B8)' },
  { glyph: ' | ', why: 'a pipe used as a separator' },
];

/**
 * Literals that DO contain a banned glyph and are allowed to, per file, with
 * the reason. Every entry is an exact literal and is checked for existence by
 * the staleness test below.
 */
const ALLOWED: Record<string, { text: string; why: string }[]> = {
  // The HISTORY group rows' disclosure caret: `aria-hidden`, set from
  // `aria-expanded`, and it is a shape, not a word — the same role a
  // triangle plays in every tree view. Nothing in it separates two texts.
  'ui/sessions.ts': [
    { text: '▸', why: 'collapsed-group disclosure caret (aria-hidden, paired with ▾)' },
  ],
  // ui/theme.ts is the Legacy theme popover. A2 unwired it (main.ts no longer
  // calls initTheme) and part A8 deletes the file; its copy can never reach a
  // screen while nothing imports it, which the test below proves rather than
  // assumes.
  'ui/theme.ts': [
    {
      text: 'background and text are independent · status colors stay',
      why: 'unwired Legacy theme popover — no importer; deleted in part A8',
    },
  ],
};

// ---------------------------------------------------------------------------

test('the separator scan actually reads the chrome (non-vacuity: files, literals and known copy)', () => {
  assert.ok(FILES.length >= 20, `expected the whole chrome, found ${FILES.length} modules`);
  for (const must of [
    'main.ts',
    'ui/tabs.ts',
    'ui/statusline.ts',
    'ui/sessions.ts',
    'ui/panes.ts',
    'ui/github-model.ts',
    'ui/launch-args.ts',
    'ui/util.ts',
  ]) {
    assert.ok(FILES.includes(must), `${must} must be scanned`);
    assert.ok(src(must).length > 500, `${must} looks empty`);
  }
  // Canaries: real A2 copy the scanner has to see, in the files it must read.
  const canaries: [string, string][] = [
    ['main.ts', 'Session Manager'],
    ['main.ts', 'New session'],
    ['ui/statusline.ts', 'Keyboard shortcuts'],
    ['ui/tabs.ts', 'Needs you'],
    ['ui/sessions.ts', 'Working'],
    ['ui/panes.ts', 'Needs your answer'],
    // Nocturne A4: the New session dialog's own copy and its display tables.
    ['ui/launch.ts', 'Start session'],
    ['ui/launch.ts', 'No projects yet. This one opens in your home folder.'],
    ['ui/launch-args.ts', 'Asks before every edit or command.'],
    ['ui/launch-args.ts', 'The last conversation in this project'],
    ['ui/launch-args.ts', 'Not available yet'],
  ];
  for (const [file, text] of canaries) {
    const found = (litsOf.get(file) as Lit[]).some((l) => l.text === text);
    assert.ok(found, `${file}: the scanner should have found the literal ${JSON.stringify(text)}`);
  }
  // And it has to be able to SEE a banned glyph, or the whole file is vacuous.
  const carets = (litsOf.get('ui/sessions.ts') as Lit[]).filter((l) => l.text.includes('▸'));
  assert.equal(carets.length, 1, 'the known ▸ caret in ui/sessions.ts must be visible to the scan');
});

test('no decorative separator glyph in any chrome literal (README-v3 copy rules)', () => {
  const offenders: string[] = [];
  for (const file of FILES) {
    const allowed = new Set((ALLOWED[file] ?? []).map((a) => a.text));
    for (const { text, line } of litsOf.get(file) as Lit[]) {
      if (allowed.has(text)) continue;
      for (const { glyph, why } of BANNED) {
        if (!text.includes(glyph)) continue;
        const shown = JSON.stringify(text.split(HOLE).join('${…}'));
        offenders.push(`web/src/${file}:${line}  ${shown}  — ${why}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'UI text carries no decorative separators (design_handoff_session_manager/README-v3.md). Offenders:\n  ' +
      offenders.join('\n  '),
  );
});

test('the separator allowlist has no stale entries, and ui/theme.ts really is unwired', () => {
  for (const [file, entries] of Object.entries(ALLOWED)) {
    assert.ok(FILES.includes(file), `ALLOWED names a file that is not scanned: ${file}`);
    const present = new Set((litsOf.get(file) as Lit[]).map((l) => l.text));
    for (const e of entries) {
      assert.ok(present.has(e.text), `stale allowlist entry in web/src/${file}: ${JSON.stringify(e.text)}`);
      assert.ok(e.why.length > 10, `every allowlist entry states a reason: ${e.text}`);
    }
  }
  // The theme entry is excused ONLY because nothing renders that popover. The
  // moment a module imports it again, its Legacy copy is on screen and this
  // must fail instead of silently excusing it.
  const importers = FILES.filter(
    (f) => f !== 'ui/theme.ts' && /from '\.{1,2}(\/ui)?\/theme\.ts'/.test(src(f)),
  );
  assert.deepEqual(importers, [], 'ui/theme.ts is unwired in A2 — its allowlist entry assumes exactly that');
  assert.equal(src('main.ts').includes('initTheme'), false, 'main.ts must not call initTheme');
});

// ---------------------------------------------------------------------------
// The state words
// ---------------------------------------------------------------------------

/** Files that name a session's state to the user. */
const STATE_FILES = ['ui/sessions.ts', 'ui/panes.ts', 'ui/tabs.ts'] as const;

test('the four Nocturne state words are the ones the chrome renders', () => {
  // Per file, exactly what that surface says today — the drawer rows and the
  // pane dot name a session, the tab pill names a TAB holding one.
  const has = (file: string, text: string): boolean =>
    (litsOf.get(file) as Lit[]).some((l) => l.text === text || l.text.startsWith(`${text} `));
  assert.ok(has('ui/sessions.ts', 'Working'), 'the drawer row says Working');
  assert.ok(has('ui/sessions.ts', 'Needs your answer'), 'the drawer row says Needs your answer');
  assert.ok(
    (litsOf.get('ui/sessions.ts') as Lit[]).some((l) => l.text.startsWith('Finished')),
    'the drawer row says Finished (it appends the exit code)',
  );
  assert.ok(has('ui/panes.ts', 'Working'), 'the pane dot says Working');
  assert.ok(has('ui/panes.ts', 'Needs your answer'), 'the pane dot says Needs your answer');
  assert.ok(has('ui/panes.ts', 'Finished'), 'the pane dot says Finished');
  assert.ok(has('ui/tabs.ts', 'Needs you'), 'the tab pill says Needs you');
  // And the four words exist across the three files as a set.
  const all = STATE_FILES.flatMap((f) => (litsOf.get(f) as Lit[]).map((l) => l.text));
  for (const word of ['Working', 'Needs your answer', 'Finished', 'Needs you']) {
    assert.ok(
      all.some((t) => t === word || t.startsWith(`${word} `) || t.startsWith(`${word},`)),
      `no chrome literal says ${JSON.stringify(word)}`,
    );
  }
});

test('the Legacy state vocabulary is gone from every chrome module', () => {
  // Exact LABELS, case-insensitively, anywhere inside a literal — these were
  // sentences, so a substring match is the right granularity.
  const legacy = ['awaiting input', 'waiting for input', 'needs input'];
  const offenders: string[] = [];
  for (const file of FILES) {
    for (const { text, line } of litsOf.get(file) as Lit[]) {
      const low = text.toLowerCase();
      for (const bad of legacy) {
        if (low.includes(bad)) offenders.push(`web/src/${file}:${line}  ${JSON.stringify(text)}  — ${bad}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'Legacy state words are replaced by the Nocturne four. Offenders:\n  ' + offenders.join('\n  '));
});

test('`running` survives only as a protocol value, never as a rendered label', () => {
  // The subtle half of the rule: `status === 'running'` and `is-running` are
  // the wire and the stylesheet, both legal. What may not come back is a
  // literal the DOM shows — a bare `running` / `Running` word.
  const offenders: string[] = [];
  for (const file of FILES) {
    for (const { text, line } of litsOf.get(file) as Lit[]) {
      if (/^\s*running\s*$/i.test(text) && text !== 'running') {
        offenders.push(`web/src/${file}:${line}  ${JSON.stringify(text)}`);
      }
      // A sentence-shaped label containing the word, e.g. `running · 3`.
      if (/(^|[^-\w])running\b/i.test(text) && /[ ]/.test(text.trim()) && !text.includes(HOLE)) {
        const low = text.toLowerCase();
        const prose =
          low.includes('running sessions') || low.includes('sessions running') || low.includes('is running');
        if (!prose && text.trim().split(/\s+/).length <= 3) {
          offenders.push(`web/src/${file}:${line}  ${JSON.stringify(text)}  — short label containing "running"`);
        }
      }
    }
  }
  assert.deepEqual(offenders, [], 'no rendered `running` label. Offenders:\n  ' + offenders.join('\n  '));
  // Non-vacuity: the protocol value IS still there (this check must be able to
  // tell the two apart, not simply find nothing anywhere).
  assert.ok(
    (litsOf.get('ui/sessions.ts') as Lit[]).some((l) => l.text === 'running'),
    'ui/sessions.ts must still compare against the protocol value',
  );
});

// ---------------------------------------------------------------------------
// Pluralised counts
// ---------------------------------------------------------------------------

test('the statusline pluralises its counts instead of writing `session(s)`', () => {
  const S = src('ui/statusline.ts');
  assert.match(S, /sessions === 1 \? 'session' : 'sessions'/);
  assert.match(S, /panes === 1 \? 'pane' : 'panes'/);
  const offenders = FILES.flatMap((f) =>
    (litsOf.get(f) as Lit[])
      .filter((l) => /\(s\)|\(es\)/.test(l.text))
      .map((l) => `web/src/${f}:${l.line}  ${JSON.stringify(l.text)}`),
  );
  assert.deepEqual(offenders, [], 'a count is pluralised, never "session(s)". Offenders:\n  ' + offenders.join('\n  '));
});

// ---------------------------------------------------------------------------
// A2's removals and the chrome heights
// ---------------------------------------------------------------------------

test('main.ts wires no theme control any more (Nocturne is the only theme)', () => {
  const MAIN = src('main.ts');
  assert.ok(MAIN.includes('function buildShell'), 'non-vacuity: main.ts must still build the shell');
  assert.equal(MAIN.includes('initTheme'), false, 'no initTheme import or call');
  assert.equal(/from '\.\/ui\/theme\.ts'/.test(MAIN), false, 'no import of the theme popover');
  const themeLabels = (litsOf.get('main.ts') as Lit[]).filter((l) => /^theme$/i.test(l.text.trim()));
  assert.deepEqual(
    themeLabels.map((l) => `main.ts:${l.line} ${JSON.stringify(l.text)}`),
    [],
    'the Theme button label is gone from the top bar',
  );
});

test('tokens.css pins the three Nocturne chrome heights, and app.css builds on them', () => {
  const TOKENS = readFileSync(join(WEB_SRC, 'styles', 'tokens.css'), 'utf8');
  const APP = readFileSync(join(WEB_SRC, 'styles', 'app.css'), 'utf8');
  assert.ok(TOKENS.length > 1000, 'non-vacuity: tokens.css looks empty');
  for (const [name, value] of [
    ['--topbar-h', '48px'],
    ['--tab-h', '32px'],
    ['--status-h', '26px'],
  ] as const) {
    const m = new RegExp(`${name}:\\s*([^;]+);`).exec(TOKENS);
    assert.notEqual(m, null, `tokens.css must declare ${name}`);
    assert.equal((m?.[1] as string).trim(), value, `${name}`);
    // A token nothing consumes is a comment, not a contract.
    assert.ok(APP.includes(`var(${name})`), `app.css must size the chrome with var(${name})`);
  }
});
