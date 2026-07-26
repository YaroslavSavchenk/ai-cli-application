/**
 * Claude Code's OWN status line, drawn by us.
 *
 * Claude Code runs this script for every session the app launches, because the
 * spawn path writes a per-session settings file (server/session-settings.ts)
 * naming it as `statusLine.command` and appends `--settings <file>` to the argv.
 * It is invoked on every assistant message, on /compact, on a permission-mode
 * change, and on the settings file's refreshInterval; stdin carries a JSON
 * payload describing the session. We print ONE line and exit 0.
 *
 * WHY IT IS A STANDALONE .mjs WITH NO IMPORTS FROM server/:
 *   - It runs inside a FOREIGN process (claude), not the backend. It must not
 *     drag in the backend's module graph, node-pty, or any npm dependency.
 *   - It re-reads its config (prefs.json) on EVERY invocation, so flipping a
 *     toggle in the settings panel changes what running sessions draw without
 *     restarting them. Nothing is cached across invocations except the git
 *     branch (see below).
 *
 * HARD RULE — NEVER PRINT AN ERROR. Whatever we print is drawn into the user's
 * terminal on every turn, so any internal failure prints NOTHING and exits 0
 * (Claude Code renders a blank bar). Same for a non-zero exit: it would blank
 * the bar anyway and log a warning into the session, so we never take that path.
 *
 * HONESTY RULE (inherited from the strip this replaces): an item appears only
 * when its toggle is ON and the payload carries a REAL value for it. No
 * zero-as-unknown, no fabricated ratio, no guessed model.
 *
 * ASCII ONLY: the terminal width of emoji/box glyphs is undocumented here and a
 * miscounted cell corrupts the line Claude Code truncates.
 *
 * Usage (composed by the server, never by a client):
 *   node /abs/path/statusline.mjs <permission-mode> <abs path to prefs.json>
 *
 * <permission-mode> is one of the four values in MODE_LABELS, or anything else
 * (e.g. 'unknown') to omit the mode item. It is an ARGUMENT because the payload
 * does not carry the permission mode — verified against Claude Code 2.1.220,
 * whose status-line payload builder passes permissionMode only into its model
 * resolution. If a future version DOES put it in the payload, the payload wins
 * (see permissionLabel).
 *
 * The git branch cache lives next to prefs.json (i.e. in the app data dir) as
 * statusline-cache.json, keyed by the payload's `session_id` — NEVER by pid,
 * which changes per invocation and would make the cache useless and unbounded.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** The four `--permission-mode` values the app launches with, in plain words. */
const MODE_LABELS = {
  default: 'always ask',
  acceptEdits: 'auto-edits',
  plan: 'plan',
  bypassPermissions: 'never ask',
};

/**
 * Factory toggles. An absent or corrupt prefs.json means exactly this set, and
 * any member the stored `statusLine` object does not define keeps its value here.
 */
const DEFAULT_CONFIG = {
  enabled: true,
  model: true,
  mode: true,
  branch: true,
  cost: true,
  lines: false,
  context: true,
  usage: false,
};

/** Item separator. Plain ASCII pipe — see the ASCII-only rule above. */
const SEP = ' | ';
/** Hard cap on the printed line; Claude Code truncates to the pane anyway. */
const MAX_LINE = 240;
/** Longest a single sourced string (branch, model name) may be. */
const MAX_FIELD = 64;

/** Branch cache: fresh for this long, keyed by session_id. */
const BRANCH_TTL_MS = 5_000;
/** Cache entries older than this are dropped whenever we rewrite the file. */
const CACHE_STALE_MS = 60_000;
/** Belt and braces on cache size (one entry per concurrent claude session). */
const CACHE_MAX_ENTRIES = 64;
/** A git probe that hangs must never hold the status line hostage. */
const GIT_TIMEOUT_MS = 1_500;

/** Stop reading stdin after this; a payload that never arrives prints nothing. */
const STDIN_TIMEOUT_MS = 4_000;
/** Payload size ceiling — the real one is a few KiB. */
const STDIN_MAX_BYTES = 1024 * 1024;

/**
 * Terminal-safe single-line text: strip C0/C1 controls and DEL (an escape
 * sequence smuggled through a branch name or a display name would move the
 * cursor / recolor the pane), collapse whitespace, cap the length.
 */
function clean(value, max = MAX_FIELD) {
  if (typeof value !== 'string') return '';
  const stripped = value
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > max ? stripped.slice(0, max) : stripped;
}

/** Finite number or null (guards null/absent/NaN/garbage payload fields). */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A 0-100 percentage floored to an integer, or null. */
function pct(value) {
  const n = num(value);
  if (n === null) return null;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.floor(n);
}

/** Plain object or undefined. */
function obj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

/** Read the toggles fresh from prefs.json. Absent/corrupt/foreign shape -> defaults. */
function readConfig(prefsPath) {
  const config = { ...DEFAULT_CONFIG };
  if (typeof prefsPath !== 'string' || prefsPath === '') return config;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(prefsPath, 'utf8'));
  } catch {
    return config; // No prefs yet, unreadable, or not JSON: factory defaults.
  }
  const statusLine = obj(obj(parsed)?.statusLine);
  if (statusLine === undefined) return config;
  for (const key of Object.keys(config)) {
    if (typeof statusLine[key] === 'boolean') config[key] = statusLine[key];
  }
  return config;
}

/** Read the whole stdin payload, giving up after STDIN_TIMEOUT_MS. */
function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.destroy();
      resolve(text);
    };
    const timer = setTimeout(() => finish(''), STDIN_TIMEOUT_MS);
    process.stdin.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > STDIN_MAX_BYTES) {
        finish('');
        return;
      }
      chunks.push(chunk);
    });
    process.stdin.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', () => finish(''));
  });
}

/** `git branch --show-current` in `cwd` — argv, no shell. null on anything odd. */
function probeBranch(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  let result;
  try {
    result = spawnSync('git', ['branch', '--show-current'], {
      cwd,
      shell: false,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Skip optional locks: a status line polls, and it must never contend
      // with the user's own git commands in the same worktree.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
  } catch {
    return null;
  }
  if (result === null || result.error !== undefined || result.status !== 0) return null;
  // Empty output = detached HEAD (or not a repo). No branch is an honest answer.
  const branch = clean(result.stdout);
  return branch === '' ? null : branch;
}

/** Atomic 0600 write; a failed cache write is never fatal. */
function writeCache(file, cache) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(cache), { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    try {
      unlinkSync(tmp);
    } catch {
      // Nothing to clean up.
    }
  }
}

/**
 * Branch for this session, cached ~5 s under the session_id so a 1-2 s refresh
 * interval does not fork git on every tick. Stale entries are pruned whenever
 * the file is rewritten, which is also what stops it growing without bound.
 *
 * Concurrent sessions share the file and the last writer wins; the worst case
 * is a lost entry and therefore one extra git probe. Nothing here is worth
 * locking for.
 */
function branchFor(sessionId, cwd, cacheFile) {
  if (typeof sessionId !== 'string' || sessionId === '' || cacheFile === undefined) {
    return probeBranch(cwd);
  }
  const now = Date.now();
  let cache = {};
  try {
    const parsed = obj(JSON.parse(readFileSync(cacheFile, 'utf8')));
    if (parsed !== undefined) cache = parsed;
  } catch {
    cache = {};
  }
  const hit = obj(cache[sessionId]);
  if (hit !== undefined) {
    const at = num(hit.at);
    // `now < at` means the clock moved backwards; treat that as a miss. The
    // recorded cwd must match too: one entry per session is the right shape,
    // but a session id alone does not identify the directory the branch came
    // from, and answering for the wrong directory would be a lie.
    if (at !== null && now >= at && now - at < BRANCH_TTL_MS && hit.cwd === cwd) {
      // The cached string is exactly as untrusted as the fresh probe's stdout:
      // this file sits in the data dir, where any process running as this user
      // can write it, and whatever comes out of here is printed into a terminal.
      // So it takes the SAME clean() (strip controls incl. ESC/BEL, cap
      // MAX_FIELD) the fresh path runs at :192. A value that cleans to empty is
      // a MISS, not an empty item — we fall through and probe git.
      const cached = clean(hit.branch);
      if (cached !== '') return cached;
    }
  }
  const branch = probeBranch(cwd);
  cache[sessionId] = { at: now, branch, cwd: typeof cwd === 'string' ? cwd : null };
  for (const [key, value] of Object.entries(cache)) {
    const entry = obj(value);
    const at = entry === undefined ? null : num(entry.at);
    if (at === null || now - at > CACHE_STALE_MS) delete cache[key];
  }
  const keys = Object.keys(cache);
  if (keys.length > CACHE_MAX_ENTRIES) {
    keys.sort((a, b) => (num(cache[a].at) ?? 0) - (num(cache[b].at) ?? 0));
    for (const key of keys.slice(0, keys.length - CACHE_MAX_ENTRIES)) delete cache[key];
  }
  writeCache(cacheFile, cache);
  return branch;
}

/**
 * Permission mode label.
 *
 * KNOWN LIMIT — this item names the LAUNCH mode, not the current one. Claude
 * Code 2.1.220's status-line payload carries no permission mode at all
 * (verified against the installed binary: its payload builder spreads the
 * session object without one), so the value used here is the argument the
 * server parsed from the session's own `--permission-mode` at spawn. The mode
 * IS mutable mid-session (shift+tab, `set_permission_mode`), and such a change
 * is NOT reflected: a session started in ask-first mode that switches to
 * auto-edits keeps printing `always ask`. The payload probe below stays as
 * feature detection so a future Claude Code that does send the mode wins
 * automatically, with no change here. Documented for the user in the settings
 * panel's row caption and in web/DESIGN.md.
 *
 * A value outside the four known ones names a mode we cannot describe honestly,
 * so the item is omitted.
 */
function permissionLabel(payload, argMode) {
  const fromPayload = [payload?.permission_mode, payload?.permissionMode, obj(payload?.session)?.permission_mode];
  for (const candidate of fromPayload) {
    if (typeof candidate === 'string' && Object.hasOwn(MODE_LABELS, candidate)) {
      return MODE_LABELS[candidate];
    }
  }
  return typeof argMode === 'string' && Object.hasOwn(MODE_LABELS, argMode) ? MODE_LABELS[argMode] : null;
}

/** Build the whole line from payload + toggles. Returns '' when nothing is drawable. */
function buildLine(payload, config, cacheFile) {
  if (!config.enabled) return '';
  const items = [];

  if (config.model) {
    // Verified shape: `model` is always an object { id, display_name }. A bare
    // string there is not a model name we can trust, so it names nothing.
    const model = obj(payload.model);
    const name = clean(model?.display_name) || clean(model?.id);
    if (name !== '') items.push(name);
  }

  if (config.mode) {
    const label = permissionLabel(payload, process.argv[2]);
    if (label !== null) items.push(label);
  }

  if (config.branch) {
    // NOT run through clean(): this is a real path handed to spawnSync as cwd,
    // where collapsing whitespace would break a legitimate directory name. It
    // never reaches a shell, and an unusable value just fails the probe.
    const workspaceDir = obj(payload.workspace)?.current_dir;
    const cwd = typeof workspaceDir === 'string' && workspaceDir !== '' ? workspaceDir : payload.cwd;
    const branch = branchFor(payload.session_id, cwd, cacheFile);
    if (branch !== null) items.push(`git:${branch}`);
  }

  const cost = obj(payload.cost);

  if (config.cost) {
    const usd = num(cost?.total_cost_usd);
    // 0 is what a session that has not called the API yet reports: real, but it
    // says nothing. Draw a cost only once there IS one.
    if (usd !== null && usd > 0) items.push(`$${usd.toFixed(2)}`);
  }

  if (config.lines) {
    const added = num(cost?.total_lines_added) ?? 0;
    const removed = num(cost?.total_lines_removed) ?? 0;
    if (added > 0 || removed > 0) items.push(`+${Math.round(added)} -${Math.round(removed)}`);
  }

  if (config.context) {
    // null until the first turn of the session — omitted, never shown as 0%.
    const used = pct(obj(payload.context_window)?.used_percentage);
    if (used !== null) items.push(`ctx ${used}%`);
  }

  if (config.usage) {
    // Claude.ai Pro/Max only, and only after the first API response.
    const limits = obj(payload.rate_limits);
    const parts = [];
    const five = pct(obj(limits?.five_hour)?.used_percentage);
    const seven = pct(obj(limits?.seven_day)?.used_percentage);
    if (five !== null) parts.push(`5h ${five}%`);
    if (seven !== null) parts.push(`7d ${seven}%`);
    if (parts.length > 0) items.push(parts.join(' '));
  }

  return items.join(SEP).slice(0, MAX_LINE);
}

async function main() {
  const raw = await readStdin();
  if (raw.trim() === '') return '';
  const payload = obj(JSON.parse(raw));
  if (payload === undefined) return '';
  const prefsPath = process.argv[3];
  const config = readConfig(prefsPath);
  // The cache lives beside prefs.json, i.e. in the app data dir. This
  // derivation MUST AGREE WITH `statuslineCacheFile` in server/config.ts, which
  // is where the backend declares the same file (and deletes it at boot); this
  // script cannot import it, see the no-imports rule at the top of this file.
  const cacheFile =
    typeof prefsPath === 'string' && prefsPath !== ''
      ? join(dirname(prefsPath), 'statusline-cache.json')
      : undefined;
  return buildLine(payload, config, cacheFile);
}

try {
  const line = await main();
  if (line !== '') process.stdout.write(`${line}\n`);
} catch {
  // Deliberately silent: an error message here would be printed INTO every
  // terminal, on every turn. A blank bar is the correct failure mode.
}
process.exit(0);
