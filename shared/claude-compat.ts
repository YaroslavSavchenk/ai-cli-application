/**
 * Which Claude Code versions this app was built for, and the pure rules that
 * place an installed version against that range (Nocturne D6,
 * `.claude/plans/nocturne/PLAN-D6.md` § Defaults). The range lives HERE and
 * nowhere else: the server computes `RuntimeStatusResponse.claude.compat` with
 * `claudeCompat`, the browser only reads that answer, and the release-notes
 * pin (`tests/release/`) checks the draft names the same `testedUpTo`.
 *
 * Pure: no I/O, no clock. The server's probe is server/claude-version.ts.
 */
import type { ClaudeCompat } from './protocol-runtime.ts';

export type { ClaudeCompat } from './protocol-runtime.ts';

/**
 * `min`: the oldest Claude Code the app's flags work with (`--session-id`,
 * `--resume <id>`, `--settings <file>`; decided in
 * `memory/decisions/session-history-resume.md`). `testedUpTo`: the newest one
 * a release was verified with. A newer PATCH counts as newer — the tested
 * list is exact, and Claude Code ships often.
 */
export const CLAUDE_SUPPORTED: { readonly min: string; readonly testedUpTo: string } = {
  min: '2.1.263',
  testedUpTo: '2.1.287',
};

/**
 * A version this app believes: three dot-separated runs of 1–9 digits, nothing
 * else (so at most 29 characters). The one shape for the probe's answer, the
 * dev override `AI_SM_CLAUDE_VERSION_OVERRIDE` and the `claudeNoticeHidden`
 * pref.
 */
export const CLAUDE_VERSION_SHAPE = /^\d{1,9}\.\d{1,9}\.\d{1,9}$/;

/** The first `X.Y.Z` token not glued to a further digit or dot (`1.2.3.4` is none). */
const VERSION_TOKEN = /(?<![\d.])(\d{1,9}\.\d{1,9}\.\d{1,9})(?![\d.])/;

/** The first `X.Y.Z` token in `claude --version`'s output, or null. */
export function parseClaudeVersion(stdout: string): string | null {
  return VERSION_TOKEN.exec(stdout)?.[1] ?? null;
}

/** Numeric per part (`2.1.9` < `2.1.10`); negative, 0 or positive like a sort comparator. */
export function compareClaudeVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * Where `version` stands. `found` false (no `claude` on PATH) is `missing`
 * whatever the version says; a version that is not exactly `X.Y.Z` (garbage,
 * a timeout, not probed yet) is `unknown`, which shows no notice.
 */
export function claudeCompat(version: string | null, found: boolean): ClaudeCompat {
  if (!found) return 'missing';
  if (version === null || !CLAUDE_VERSION_SHAPE.test(version)) return 'unknown';
  if (compareClaudeVersion(version, CLAUDE_SUPPORTED.min) < 0) return 'older';
  if (compareClaudeVersion(version, CLAUDE_SUPPORTED.testedUpTo) > 0) return 'newer';
  return 'ok';
}
