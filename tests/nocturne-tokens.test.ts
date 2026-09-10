/**
 * Nocturne part A1 contract — the design-token layer, pinned so it cannot
 * drift (landed 2026-09-10; plan `.claude/PLAN-NOCTURNE.md` §A1).
 *
 * A1 replaced the Legacy UI ("steam blend") palette and chrome typeface with
 * Nocturne: `web/src/styles/tokens.css` transcribes the primitives from the
 * design handoff's own stylesheet, a LEGACY ALIAS LAYER re-points the old
 * role names at them so `app.css` never had to change, and the same ground
 * colour is repeated in four places OUTSIDE CSS (the pre-bundle inline style
 * in `web/index.html`, its `theme-color` meta, `web/public/manifest.json`,
 * and the WebView2 host's DWM caption constants in C#). Those repetitions
 * are the fragile part: nothing at build time relates them, so a later part
 * that retunes `--color-bg` would leave a white/blue caption bar or a flash
 * of the old colour with no error anywhere. These tests are that relation.
 *
 * What each test owns:
 *   a. every `--color-*` / `--space-*` / `--radius-*` / `--shadow-*` from
 *      `design_handoff_session_manager/_ds/nocturne-<id>/styles.css` exists in
 *      tokens.css with the same value (tokens.css may define MORE);
 *   b. no dangling `var(--x)` anywhere in app.css, tokens.css or web/src TS;
 *   c. every `--xt-*` resolves to a plain hex or rgb()/rgba() — xterm.js's
 *      colour parser understands nothing else (an oklch() there is a silently
 *      black terminal, not an error);
 *   d. app.css holds zero hex literals, fonts.css fetches nothing over the
 *      network and every url() it names exists, Barlow is gone, Inter's
 *      license is committed;
 *   e. the four out-of-CSS copies of the ground colour equal `--color-bg`;
 *   f. the C# host's three DWM constants equal their tokens.
 *
 * Deliberately NOT here: whether the colours look right. That is
 * `/frontend-designer` plus `.claude/skills/verify-terminal/SKILL.md`.
 *
 * SKIPPED FROM (a), by the plan's own decision: `--color-section*` (the
 * handoff calls them deck-scale fills, not interface colours) and `--font-*`
 * (the app's stack is `--font-sans`/`--font-mono` in tokens.css, a different
 * name and a different fallback chain).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { projectRoot } from './helpers.ts';

const TOKENS_CSS = join(projectRoot, 'web', 'src', 'styles', 'tokens.css');
const APP_CSS = join(projectRoot, 'web', 'src', 'styles', 'app.css');
const FONTS_CSS = join(projectRoot, 'web', 'src', 'styles', 'fonts.css');
const INDEX_HTML = join(projectRoot, 'web', 'index.html');
const MANIFEST_JSON = join(projectRoot, 'web', 'public', 'manifest.json');
const HOST_CS = join(projectRoot, 'launcher', 'host', 'AiSessionManagerHost.cs');
const FONT_DIR = join(projectRoot, 'web', 'src', 'assets', 'fonts');
const WEB_SRC = join(projectRoot, 'web', 'src');
const DS_DIR = join(projectRoot, 'design_handoff_session_manager', '_ds');

const read = (p: string) => readFileSync(p, 'utf8');
const rel = (p: string) => relative(projectRoot, p);

/**
 * Comments are stripped FIRST and everywhere: tokens.css's own header
 * comment contains the literal `:root` and several `--token` names, so a
 * parser that runs before stripping finds the wrong block and invents
 * declarations that do not exist.
 */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Body of the first `:root { … }`, brace-matched (values contain no braces). */
function rootBlock(css: string, what: string): string {
  const start = css.indexOf(':root');
  assert.notEqual(start, -1, `${what}: no :root block found`);
  const open = css.indexOf('{', start);
  assert.notEqual(open, -1, `${what}: :root without an opening brace`);
  let depth = 1;
  let i = open + 1;
  for (; i < css.length && depth > 0; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}') depth--;
  }
  assert.equal(depth, 0, `${what}: unbalanced braces in the :root block`);
  return css.slice(open + 1, i - 1);
}

/** `--name: value;` pairs, whitespace collapsed so formatting is not content. */
function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) {
    out.set(m[1]!, m[2]!.trim().replace(/\s+/g, ' '));
  }
  return out;
}

/** Value equality that ignores spelling whitespace (`rgba(0,0,0,.5)`) and case. */
const norm = (v: string) => v.replace(/\s+/g, '').toLowerCase();

function tokenDecls(): Map<string, string> {
  return declarations(rootBlock(stripComments(read(TOKENS_CSS)), rel(TOKENS_CSS)));
}

/** Follow a `var(--a)`-only value chain to the literal it ends in. */
function resolveToken(name: string, decls: Map<string, string>, seen = new Set<string>()): string {
  assert.ok(decls.has(name), `${rel(TOKENS_CSS)}: ${name} is not defined`);
  assert.ok(!seen.has(name), `${rel(TOKENS_CSS)}: var() cycle through ${name}`);
  seen.add(name);
  const value = decls.get(name)!;
  const alias = /^var\(\s*(--[A-Za-z0-9_-]+)\s*\)$/.exec(value);
  return alias ? resolveToken(alias[1]!, decls, seen) : value;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...tsFiles(abs));
    else if (entry.endsWith('.ts')) out.push(abs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// a. the handoff primitives are transcribed, value for value
// ---------------------------------------------------------------------------

test('A1 (a): tokens.css carries every Nocturne primitive from the handoff, with the handoff value', () => {
  const dirs = readdirSync(DS_DIR).filter((d) => d.startsWith('nocturne-'));
  assert.equal(
    dirs.length,
    1,
    `expected exactly one nocturne-* design system under ${rel(DS_DIR)}, found ${dirs.length}: ${dirs.join(', ')}`,
  );
  const handoffCss = join(DS_DIR, dirs[0]!, 'styles.css');
  const handoff = declarations(rootBlock(stripComments(read(handoffCss)), rel(handoffCss)));
  const tokens = tokenDecls();

  // Parser sanity: if either side silently produced nothing, every assertion
  // below would pass vacuously.
  assert.ok(handoff.size >= 45, `only parsed ${handoff.size} declarations out of ${rel(handoffCss)}`);
  assert.ok(tokens.size >= 150, `only parsed ${tokens.size} declarations out of ${rel(TOKENS_CSS)}`);

  const problems: string[] = [];
  let compared = 0;
  for (const [name, value] of handoff) {
    if (name.startsWith('--color-section')) continue; // deck-only fills, intentionally omitted
    if (name.startsWith('--font-')) continue; // the app has its own stack
    if (!/^--(color|space|radius|shadow)-/.test(name)) continue;
    compared++;
    if (!tokens.has(name)) {
      problems.push(`${name}: missing from tokens.css (handoff: ${value})`);
      continue;
    }
    const mine = tokens.get(name)!;
    if (norm(mine) !== norm(value)) {
      problems.push(`${name}: tokens.css has \`${mine}\`, the handoff says \`${value}\``);
    }
  }
  assert.ok(compared >= 40, `only compared ${compared} primitives — the filter is too narrow`);
  assert.deepEqual(
    problems,
    [],
    `tokens.css must transcribe ${rel(handoffCss)} verbatim (it may define MORE, never a different value):\n${problems.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// b. no dangling var() references
// ---------------------------------------------------------------------------

test('A1 (b): every var(--x) in app.css, tokens.css and web/src TS resolves to a defined token', () => {
  const tokens = tokenDecls();

  // A custom property is "defined" if tokens.css declares it, if the file
  // using it declares it itself, or if the frontend writes it at runtime with
  // setProperty (--split-col/--split-row come from ui/panes.ts, and their CSS
  // use sites carry a fallback for the moment before that happens).
  const defined = new Set<string>(tokens.keys());
  const runtimeSet: string[] = [];
  const sources = tsFiles(WEB_SRC);
  assert.ok(sources.length > 10, `only found ${sources.length} TS modules under ${rel(WEB_SRC)}`);
  for (const file of sources) {
    for (const m of read(file).matchAll(/setProperty\(\s*['"`](--[A-Za-z0-9_-]+)['"`]/g)) {
      defined.add(m[1]!);
      runtimeSet.push(`${m[1]!} (${rel(file)})`);
    }
  }
  assert.ok(runtimeSet.length > 0, 'expected at least one runtime setProperty definition');

  const dangling: string[] = [];
  const scanCss = (path: string) => {
    const text = stripComments(read(path));
    const local = new Set<string>();
    for (const m of text.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) local.add(m[1]!);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i]!.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) {
        const name = m[1]!;
        if (!defined.has(name) && !local.has(name)) dangling.push(`${rel(path)}:${i + 1}: var(${name})`);
      }
    }
  };
  scanCss(APP_CSS);
  scanCss(TOKENS_CSS);

  for (const file of sources) {
    const lines = read(file).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const refs = [
        ...lines[i]!.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g),
        ...lines[i]!.matchAll(/(?:cssVar|getPropertyValue)\(\s*['"`](--[A-Za-z0-9_-]+)['"`]/g),
      ];
      for (const m of refs) {
        if (!defined.has(m[1]!)) dangling.push(`${rel(file)}:${i + 1}: ${m[1]!}`);
      }
    }
  }

  assert.deepEqual(
    dangling,
    [],
    `these custom properties are read but never defined — a dangling var() is invisible at build time and renders as nothing:\n${dangling.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// c. the xterm palette stays in a syntax xterm.js can parse
// ---------------------------------------------------------------------------

test('A1 (c): every --xt-* resolves to a plain hex or rgb()/rgba(), never oklch()/color-mix()', () => {
  const tokens = tokenDecls();
  const xt = [...tokens.keys()].filter((n) => n.startsWith('--xt-'));
  assert.ok(xt.length >= 20, `expected the full xterm palette, found ${xt.length} --xt-* tokens`);

  const HEX = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/;
  const RGB = /^rgba?\(\s*[0-9.]+\s*[, ]\s*[0-9.]+\s*[, ]\s*[0-9.]+\s*(?:[,/]\s*[0-9.%]+\s*)?\)$/;

  const bad: string[] = [];
  for (const name of xt) {
    const value = resolveToken(name, tokens);
    if (!HEX.test(value) && !RGB.test(value)) bad.push(`${name} resolves to \`${value}\``);
  }
  assert.deepEqual(
    bad,
    [],
    `ui/terminal.ts hands these straight to xterm.js, whose colour parser only understands hex and rgb()/rgba(); anything else is a silently wrong terminal, not an error:\n${bad.join('\n')}`,
  );
});

// ---------------------------------------------------------------------------
// d. app.css owns no colour; fonts are self-hosted and really present
// ---------------------------------------------------------------------------

test('A1 (d1): app.css contains no hex colour literal — every colour comes from tokens.css', () => {
  const text = stripComments(read(APP_CSS));
  const lines = text.split('\n');
  const hits: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    // 3/4/6/8 hex digits with no further word character after them, so the
    // `#app` id selector (p is not a hex digit anyway) can never match.
    for (const m of lines[i]!.matchAll(/#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z_-])/g)) {
      hits.push(`${rel(APP_CSS)}:${i + 1}: ${m[0]}`);
    }
  }
  assert.deepEqual(
    hits,
    [],
    `app.css must stay colour-free so the whole app recolours from tokens.css alone:\n${hits.join('\n')}`,
  );
});

test('A1 (d2): fonts.css fetches nothing over the network and every url() it names exists', () => {
  const text = read(FONTS_CSS);
  const lower = text.toLowerCase();
  for (const forbidden of ['@import', 'googleapis', 'gstatic', 'http://', 'https://fonts']) {
    assert.equal(
      lower.includes(forbidden),
      false,
      `${rel(FONTS_CSS)} must not contain \`${forbidden}\` — this is an offline localhost tool, the typefaces are self-hosted`,
    );
  }

  const urls = [...text.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]!);
  assert.ok(urls.length >= 4, `expected at least 4 @font-face sources, found ${urls.length}`);
  for (const url of urls) {
    assert.match(
      url,
      /^\.\.\/assets\/fonts\/[A-Za-z0-9._-]+$/,
      `${rel(FONTS_CSS)}: font source \`${url}\` must live under web/src/assets/fonts/`,
    );
    const abs = join(FONT_DIR, url.slice('../assets/fonts/'.length));
    assert.ok(existsSync(abs), `${rel(FONTS_CSS)} references ${url}, but ${rel(abs)} does not exist`);
    assert.ok(statSync(abs).size > 1024, `${rel(abs)} is suspiciously small (${statSync(abs).size} bytes)`);
  }
});

test('A1 (d3): Barlow is gone and Inter ships with its license', () => {
  const entries = readdirSync(FONT_DIR);
  const barlow = entries.filter((e) => e.toLowerCase().includes('barlow'));
  assert.deepEqual(
    barlow,
    [],
    `A1 replaced Barlow with Inter; these leftovers ship bytes nothing references: ${barlow.join(', ')}`,
  );
  assert.ok(
    entries.includes('OFL-Inter.txt'),
    `Inter is SIL OFL 1.1 — the license must be committed beside the woff2 (found: ${entries.join(', ')})`,
  );
  assert.ok(entries.includes('inter-latin-var.woff2'), 'the Inter variable woff2 must be committed');
  // Pin the exact asset: Google serves Inter as several per-script subsets
  // with near-identical names, and the first A1 cut shipped the *latin-ext*
  // subset (85068 B, no basic ASCII) by mistake. Only the latin subset
  // (48256 B) renders the UI's own letters.
  const woff2 = readFileSync(join(FONT_DIR, 'inter-latin-var.woff2'));
  assert.equal(woff2.length, 48256, 'inter-latin-var.woff2 must be the 48256-byte Google *latin* subset');
  assert.equal(
    createHash('sha256').update(woff2).digest('hex'),
    '3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62',
    'inter-latin-var.woff2 changed — if deliberate, verify with fontTools that U+0041-005A are present and update this hash',
  );
  assert.match(read(FONTS_CSS), /font-family:\s*"Inter"/, 'fonts.css must declare the Inter face');
  assert.match(read(TOKENS_CSS), /--font-sans:\s*"Inter"/, 'tokens.css --font-sans must lead with Inter');
});

// ---------------------------------------------------------------------------
// e. the pre-bundle ground colour, in all four places it is repeated
// ---------------------------------------------------------------------------

test('A1 (e): index.html and manifest.json repeat --color-bg exactly (no flash of the wrong ground)', () => {
  const bg = resolveToken('--color-bg', tokenDecls());
  assert.match(bg, /^#[0-9a-fA-F]{6}$/, `--color-bg must be a plain hex to be repeatable outside CSS, got \`${bg}\``);

  const html = read(INDEX_HTML);
  const style = /<style>([\s\S]*?)<\/style>/.exec(html);
  assert.ok(style, `${rel(INDEX_HTML)}: no inline <style> block`);
  const inlineBg = /html\s*\{[^}]*background:\s*([^;}]+)[;}]/.exec(style[1]!);
  assert.ok(inlineBg, `${rel(INDEX_HTML)}: no \`html { background: … }\` rule in the inline style`);
  assert.equal(
    norm(inlineBg[1]!),
    norm(bg),
    `${rel(INDEX_HTML)}'s inline html background is the ONE sanctioned colour outside tokens.css — it exists to avoid a white flash before the bundle's CSS lands, so it must equal --color-bg`,
  );

  const meta = /<meta[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/.exec(html);
  assert.ok(meta, `${rel(INDEX_HTML)}: no <meta name="theme-color">`);
  assert.equal(norm(meta[1]!), norm(bg), `${rel(INDEX_HTML)}: theme-color must equal --color-bg`);

  const manifest = JSON.parse(read(MANIFEST_JSON)) as Record<string, unknown>;
  assert.equal(norm(String(manifest.background_color)), norm(bg), `${rel(MANIFEST_JSON)}: background_color must equal --color-bg`);
  assert.equal(norm(String(manifest.theme_color)), norm(bg), `${rel(MANIFEST_JSON)}: theme_color must equal --color-bg`);
});

// ---------------------------------------------------------------------------
// f. the WebView2 host's DWM caption colours
// ---------------------------------------------------------------------------

test('A1 (f): the C# host DWM constants equal their tokens (a mismatch is a white caption bar)', () => {
  const tokens = tokenDecls();
  const cs = read(HOST_CS);
  const pairs: { constant: string; token: string }[] = [
    { constant: 'TokenBgApp', token: '--color-bg' },
    { constant: 'TokenTextHd', token: '--color-neutral-200' },
    { constant: 'TokenEdge', token: '--color-neutral-800' },
  ];
  for (const { constant, token } of pairs) {
    const m = new RegExp(`\\b${constant}\\s*=\\s*0x([0-9a-fA-F]{6})\\b`).exec(cs);
    assert.ok(m, `${rel(HOST_CS)}: constant ${constant} not found (expected \`private const int ${constant} = 0xRRGGBB;\`)`);
    const value = resolveToken(token, tokens);
    assert.match(value, /^#[0-9a-fA-F]{6}$/, `${token} must be a plain hex to be repeatable in C#, got \`${value}\``);
    assert.equal(
      m[1]!.toLowerCase(),
      value.slice(1).toLowerCase(),
      `${rel(HOST_CS)}: ${constant} is 0x${m[1]!} but ${token} is ${value} — the DWM-drawn caption sits OUTSIDE the page, so nothing in the browser can correct it`,
    );
  }
});

// ---------------------------------------------------------------------------
// g. the terminal ground and ramp the theme popover defaults to
// ---------------------------------------------------------------------------

/**
 * A1 also moved entry 0 of both popover tables (`ui/theme-model.ts`) to
 * Nocturne IN PLACE, so persisted indexes keep their meaning. Entry 0 is what
 * `clampTheme` falls back to, i.e. what every user without a stored choice
 * sees — and it is a fourth and fifth copy of colours that live in tokens.css.
 * The popover itself goes away in part A8; until then a retuned token with a
 * stale entry 0 means the default theme silently stops matching the app.
 */
test('A1 (g): the theme popover default (GROUNDS[0], RAMPS[0], the swatch ground) is the Nocturne palette', async () => {
  const { GROUNDS, RAMPS } = await import('../web/src/ui/theme-model.ts');
  const tokens = tokenDecls();
  const hexOf = (name: string) => resolveToken(name, tokens).toLowerCase();

  assert.equal(GROUNDS[0]!.hex.toLowerCase(), hexOf('--term-bg'), 'GROUNDS[0] must be the --term-bg ground');
  assert.equal(RAMPS[0]!.cmd.toLowerCase(), hexOf('--xt-cursor'), 'RAMPS[0].cmd must be the --xt-cursor slot it writes');
  assert.equal(RAMPS[0]!.out.toLowerCase(), hexOf('--xt-fg'), 'RAMPS[0].out must be the --xt-fg slot it writes');
  assert.equal(RAMPS[0]!.dim.toLowerCase(), hexOf('--xt-bright-black'), 'RAMPS[0].dim must be the --xt-bright-black slot it writes');
  assert.equal(RAMPS[0]!.out.toLowerCase(), hexOf('--xt-white'), '--xt-white and --xt-fg are the same "out" step');

  // theme.ts owns the DOM, so it cannot be imported here; its one constant is
  // read as text instead.
  const themeTs = read(join(WEB_SRC, 'ui', 'theme.ts'));
  const swatch = /const SWATCH_GROUND\s*=\s*'([^']+)'/.exec(themeTs);
  assert.ok(swatch, 'web/src/ui/theme.ts: SWATCH_GROUND constant not found');
  assert.equal(
    swatch[1]!.toLowerCase(),
    hexOf('--term-bg'),
    'the "Aa" ramp swatches render over SWATCH_GROUND, which must be the real terminal ground',
  );
});

// ---------------------------------------------------------------------------
// h. the ANSI status hues really are the semantic tokens
// ---------------------------------------------------------------------------

/**
 * README-v3 gives three exclusive meanings — running/added, attention/working
 * on, danger/removed — as OKLCH, and tokens.css spells each one twice: once as
 * `oklch(…)` for the chrome, and once as a plain hex in the `--xt-*` palette,
 * because xterm.js cannot parse oklch (test (c)). Nothing at build time keeps
 * the two spellings of ONE colour together, so this converts the OKLCH values
 * with the standard formula and compares. A retune in a later part that
 * updates only the chrome shows up here instead of as a terminal whose "error
 * red" is a different red from the app's.
 */
function oklchToHex(L: number, C: number, H: number): string {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const channel = (x: number) => {
    const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
    return Math.round(Math.max(0, Math.min(1, v)) * 255)
      .toString(16)
      .padStart(2, '0');
  };
  return `#${lin.map(channel).join('')}`;
}

test('A1 (h): the --xt-* ANSI hues are the semantic oklch tokens converted to sRGB', () => {
  const tokens = tokenDecls();
  const pairs: { semantic: string; ansi: string }[] = [
    { semantic: '--color-ok', ansi: '--xt-green' },
    { semantic: '--color-attn', ansi: '--xt-yellow' },
    { semantic: '--color-danger', ansi: '--xt-red' },
  ];
  for (const { semantic, ansi } of pairs) {
    const value = resolveToken(semantic, tokens);
    const m = /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)$/.exec(value);
    assert.ok(m, `${semantic} must stay a bare oklch(L C H) so its sRGB twin is checkable, got \`${value}\``);
    const expected = oklchToHex(Number(m[1]), Number(m[2]), Number(m[3]));
    assert.equal(
      resolveToken(ansi, tokens).toLowerCase(),
      expected,
      `${ansi} must be ${semantic} = ${value} in sRGB (${expected}) — one meaning, two spellings, nothing at build time keeps them together`,
    );
  }

  // The terminal ground is spelled twice for the same reason: oklch for the
  // chrome (--color-term / --bg-deep), plain hex for xterm (--term-bg).
  const term = resolveToken('--color-term', tokens);
  const tm = /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)$/.exec(term);
  assert.ok(tm, `--color-term must stay a bare oklch(L C H), got \`${term}\``);
  assert.equal(
    resolveToken('--term-bg', tokens).toLowerCase(),
    oklchToHex(Number(tm[1]), Number(tm[2]), Number(tm[3])),
    '--term-bg (what xterm paints) must be --color-term (what the app paints behind it) in sRGB',
  );
});
