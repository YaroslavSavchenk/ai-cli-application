/**
 * Go-public guard: no tracked file may carry the author's machine identity.
 *
 * The repo is published (installer/go-public phase D). Three strings would
 * follow it out and be wrong for every other user — and two of them are worse
 * than wrong, they are an instruction someone's tooling could follow:
 *
 *   - the author's Linux home path, `/home/<user>/…` — and its Windows UNC
 *     spelling `\\wsl.localhost\<distro>\home\<user>\…`, which is the same
 *     directory with the other separator — it appeared in test fixtures, design
 *     docs, vault notes and, most dangerously, in the Windows launcher's
 *     built-in defaults, where it meant "start a backend for a repo you do not
 *     have";
 *   - the author's Windows user dir, `C:\Users\<user>\…`;
 *   - the author's full surname handle.
 *
 * The placeholder everywhere is `/home/you` (and `you` for the Windows user).
 *
 * ALLOW-LIST: empty, deliberately. Nothing in this repo needs the author's
 * real paths — every occurrence was either an example (placeholder works), a
 * unit-test fixture string (placeholder works), or a default that had to be
 * removed for correctness. If a future file genuinely needs one, add it to
 * `ALLOWED` below WITH a written reason; an unexplained entry defeats the
 * point of the test.
 *
 * OUT OF SCOPE, deliberately: the bare four-letter alias `sava` where it is a
 * fictional GitHub account in a fixture — the mock login and clone URL in
 * tests/ui-github-model.test.ts, the same name in the design prototype. That is
 * neither a filesystem path (nothing here can follow it) nor the author's real
 * GitHub handle, so scrubbing it would only churn fixtures. The patterns above
 * therefore require a path around it (`/home/`, `Users\`) or the full surname.
 *
 * Self-scan note: this file is itself scanned once it is tracked, so the
 * patterns below are ASSEMBLED from fragments and never appear literally in
 * the source. Do not "simplify" them back into literals.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { projectRoot } from './helpers.ts';

/** Never spelled out: see the self-scan note above. */
const A = 'sa' + 'va';

const PATTERNS: { name: string; re: RegExp }[] = [
  // Both separators, deliberately: the same home directory is spelled
  // `/home/<user>/x` in WSL and `\\wsl.localhost\Ubuntu\home\<user>\x` from
  // Windows, and the launcher, its README and the installer docs all speak the
  // second form. A forward-slash-only pattern let the UNC spelling through
  // (mutation audit, 2026-09-09).
  { name: "the author's linux home", re: new RegExp(`[/\\\\]+home[/\\\\]+${A}(?![A-Za-z0-9_-])`, 'i') },
  { name: "the author's windows user dir", re: new RegExp(`Users[\\\\/]+${A}s(?![A-Za-z0-9_-])`, 'i') },
  { name: "the author's surname handle", re: new RegExp(`${A}${'savchenko'}`, 'i') },
];

/** Reason required beside every entry. Empty is the correct state. */
const ALLOWED: { path: string; reason: string }[] = [];

/** Extensions we never scan as text (binary assets). */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.icns', '.bmp', '.webp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.gz', '.tgz', '.zip', '.xz', '.bz2', '.7z',
  '.pdf', '.exe', '.dll', '.node', '.wasm', '.bin', '.jsonl',
]);

function trackedFiles(): string[] {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0').filter((p) => p.length > 0);
}

test('no tracked file carries the author\u2019s home path, windows user or handle', () => {
  const allowed = new Map(ALLOWED.map((a) => [a.path, a.reason]));
  for (const a of ALLOWED) {
    assert.ok(a.reason.trim().length > 0, `allow-list entry ${a.path} needs a written reason`);
  }

  const files = trackedFiles();
  assert.ok(files.length > 50, `git ls-files returned only ${files.length} paths - is this a git tree?`);

  const hits: string[] = [];
  for (const rel of files) {
    if (allowed.has(rel)) continue;
    if (BINARY_EXT.has(extname(rel).toLowerCase())) continue;

    const abs = join(projectRoot, rel);
    let buf: Buffer;
    try {
      if (!statSync(abs).isFile()) continue;
      buf = readFileSync(abs);
    } catch {
      continue; // listed but not in the worktree (deleted, sparse checkout)
    }
    // Binary by content: a NUL in the first 8 KiB.
    if (buf.subarray(0, 8192).includes(0)) continue;

    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const p of PATTERNS) {
        if (p.re.test(lines[i]!)) {
          hits.push(`${rel}:${i + 1}: ${p.name}: ${lines[i]!.trim().slice(0, 160)}`);
        }
      }
    }
  }

  assert.deepEqual(
    hits,
    [],
    `the repo is public: scrub these (placeholder \`/home/you\`), or add a justified ALLOWED entry:\n${hits.join('\n')}`,
  );
});
