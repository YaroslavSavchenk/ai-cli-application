/**
 * The security boundary of server/agents.ts: which transcript path may be
 * opened at all (subagentsDirFor) and the one pending-folder allowance
 * (pendingSlug) the watcher re-applies per poll.
 *
 * Split from server/agents.ts (PLAN-RESTRUCTURE O8, 2026-09-23), moved
 * byte-exact; server/agents.ts re-exports subagentsDirFor. Sibling pieces:
 * server/agents.ts (AgentsWatcher: the poll, the bounded reads, the rows) and
 * server/agents-fold.ts (the pure line fold, wire comparisons and turn verdict).
 */
import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { isUuid } from './conversation.ts';
import { isUnder } from './fsbrowse.ts';
import { CONTROL_CHAR } from './sanitise.ts';

/**
 * The subagents directory for a snapshot's transcript path, or null when the
 * path is refused. Pure except for the two realpath calls.
 *
 * THIS IS THE SECURITY BOUNDARY of the whole module. `transcript` came out of
 * a file any local process can write, so every one of these refusals is load
 * bearing:
 *   - not a non-empty string, or longer than 1024 characters;
 *   - a control character or NUL anywhere in it (an ESC would also reach a
 *     terminal through the log line);
 *   - not absolute, or `normalize(p) !== p` — which is how `..`, `//` and a
 *     trailing separator are refused as WRITTEN, before any resolution could
 *     quietly make them look innocent;
 *   - a basename that is not `<uuid>.jsonl` with the exact UUID shape
 *     server/conversation.ts already checks — the only names Claude Code
 *     gives a transcript;
 *   - a real directory that is not inside the real projects root. Both sides
 *     are realpath'd, so a symlink planted anywhere along the path is resolved
 *     BEFORE the comparison instead of aiming it somewhere else, and the
 *     prefix test carries a trailing separator so `/home/u/.claude/projects-evil`
 *     is not accepted as being under `/home/u/.claude/projects`.
 * A projects root that does not exist (no Claude Code on this machine) makes
 * every path refusable, which is the correct answer: there is nothing to read.
 *
 * NOT THE WHOLE BOUNDARY. The `<uuid>` and `subagents` components are appended
 * to the real directory and are NOT resolved here (they usually do not exist
 * yet). AgentsWatcher re-checks the resolved directory on every poll, which is
 * also the only place that can: a symlink may be planted long after this
 * returned.
 */
export function subagentsDirFor(transcript: string, projectsRoot: string): string | null {
  if (typeof transcript !== 'string' || transcript.length === 0 || transcript.length > 1024) {
    return null;
  }
  if (CONTROL_CHAR.test(transcript)) return null;
  if (!isAbsolute(transcript)) return null;
  if (normalize(transcript) !== transcript) return null;
  // normalize() KEEPS a trailing separator, and basename() then ignores it, so
  // `/…/<uuid>.jsonl/` would pass every check above while naming a directory.
  if (transcript.endsWith(sep)) return null;

  const name = basename(transcript);
  if (!name.endsWith('.jsonl')) return null;
  const uuid = name.slice(0, -'.jsonl'.length);
  if (!isUuid(uuid)) return null;

  let realRoot: string;
  try {
    realRoot = realpathSync(projectsRoot);
  } catch {
    return null; // No projects root: nothing to read, ever.
  }
  // PENDING (B11 F1): the first session in a folder Claude Code never opened.
  // `<root>/<slug>` does not exist until the first prompt, and no new snapshot
  // arrives then — refusing here would leave the session untracked for good.
  // Accepted ONLY when the slug is exactly one missing component directly
  // under the REAL root (pendingSlug); the returned path is built from the
  // real root, and the watcher applies the full boundary per poll once the
  // slug exists.
  if (pendingSlug(dirname(transcript), realRoot)) {
    return join(realRoot, basename(dirname(transcript)), uuid, 'subagents');
  }

  let realDir: string;
  try {
    realDir = realpathSync(dirname(transcript));
  } catch {
    return null; // Gone, unreadable, or a root that does not exist.
  }
  if (!isUnder(realDir, realRoot)) return null;

  return join(realDir, uuid, 'subagents');
}

/**
 * True when `parent` is a transcript folder Claude Code has not created YET
 * (B11 F1): exactly ONE missing component, directly under the real projects
 * root. Every check is load bearing:
 *   - its name is a real slug: non-empty, not `.`/`..`, no separator, no
 *     control character (basename() of a normalised absolute path already
 *     cannot hold a separator; the others are checked here again);
 *   - it is TRULY missing: `lstat` says ENOENT. A dangling symlink planted
 *     under the slug's name exists for lstat and is refused, not "pending";
 *   - its parent's realpath is EXACTLY the real root — not merely inside it,
 *     so two or more missing components, or a missing folder anywhere else,
 *     never count.
 * Pure except for one lstat and one realpath. Once the folder exists this is
 * false and the ordinary realpath boundary applies.
 */
export function pendingSlug(parent: string, realRoot: string): boolean {
  const slug = basename(parent);
  if (slug === '' || slug === '.' || slug === '..' || slug.includes(sep) || CONTROL_CHAR.test(slug)) {
    return false;
  }
  try {
    lstatSync(parent);
    return false; // It exists (or a symlink wears its name): not pending.
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  try {
    return realpathSync(dirname(parent)) === realRoot;
  } catch {
    return false;
  }
}
