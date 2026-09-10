/**
 * The committed icon set must always match what `launcher/make-icon.mjs`
 * renders today (Nocturne part A1, 2026-09-10, rewrote both the generator and
 * its five outputs from `design_handoff_session_manager/app-icon.svg`).
 *
 * Five binaries are checked into the repo — `launcher/app.ico`,
 * `web/public/favicon.ico`, `web/public/icon-192.png`,
 * `web/public/icon-512.png` and the generated `web/public/manifest.json` —
 * and nothing in the build reproduces them, so an edit to the generator's
 * geometry or palette that is never re-run leaves the repo shipping the
 * previous icon with no diff to notice. `--check` re-renders and compares;
 * this test is that command inside the suite, so `npm test` alone catches it
 * (CI runs the same command separately in `verify.yml`'s check job).
 *
 * It compares DECODED pixels for the PNGs, not raw bytes, so a different
 * zlib build cannot produce a false failure; the ICOs and the manifest are
 * byte-exact by construction.
 *
 * Plain node, no dependencies, ~1 s.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectRoot } from './helpers.ts';

const SCRIPT = join(projectRoot, 'launcher', 'make-icon.mjs');

/** The five outputs `--check` must report on, in the script's own order. */
const OUTPUTS = [
  'launcher/app.ico',
  'web/public/favicon.ico',
  'web/public/icon-192.png',
  'web/public/icon-512.png',
  'web/public/manifest.json',
];

test('make-icon.mjs --check: every committed icon output still matches a fresh render', () => {
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [SCRIPT, '--check'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    assert.fail(
      `\`node launcher/make-icon.mjs --check\` exited ${e.status}. Re-run \`node launcher/make-icon.mjs\` and commit the outputs.\n` +
        `stdout:\n${e.stdout ?? ''}\nstderr:\n${e.stderr ?? ''}`,
    );
  }

  for (const out of OUTPUTS) {
    assert.match(
      stdout,
      new RegExp(`^OK\\s+${out.replace(/[.]/g, '\\.')}\\s`, 'm'),
      `--check did not report OK for ${out}; full output:\n${stdout}`,
    );
  }
  assert.match(
    stdout,
    new RegExp(`All ${OUTPUTS.length} icon outputs match a fresh render\\.`),
    `--check must verify exactly ${OUTPUTS.length} outputs; full output:\n${stdout}`,
  );
});

test('make-icon.mjs --preview needs a directory and writes nothing without one', () => {
  let status: number | null = null;
  let stderr = '';
  try {
    execFileSync(process.execPath, [SCRIPT, '--preview'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const e = err as { status?: number | null; stderr?: string };
    status = e.status ?? null;
    stderr = e.stderr ?? '';
  }
  assert.equal(status, 1, '--preview without a directory must exit 1');
  assert.match(stderr, /--preview needs a directory argument/);
});

test('make-icon.mjs --check --preview: mutually exclusive, and the tree is untouched', () => {
  // `--preview` verifies nothing, so accepting the combination would let a
  // `--check` in a script (CI, the suite above) exit 0 having checked nothing.
  // The refusal must also come BEFORE any render, so neither the committed
  // outputs nor the preview directory are written.
  const porcelainBefore = execFileSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  const scratch = mkdtempSync(join(tmpdir(), 'ai-sm-icon-preview-'));
  try {
    for (const args of [
      ['--check', '--preview', scratch],
      ['--preview', scratch, '--check'],
    ]) {
      let status: number | null = null;
      let stderr = '';
      let stdout = '';
      try {
        stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
          cwd: projectRoot,
          encoding: 'utf8',
          timeout: 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (err) {
        const e = err as { status?: number | null; stdout?: string; stderr?: string };
        status = e.status ?? null;
        stdout = e.stdout ?? '';
        stderr = e.stderr ?? '';
      }
      assert.equal(status, 1, `\`${args.join(' ')}\` must exit 1; stdout:\n${stdout}`);
      assert.match(stderr, /mutually exclusive/);
      assert.deepEqual(
        readdirSync(scratch),
        [],
        `\`${args.join(' ')}\` wrote preview files despite refusing`,
      );
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const porcelainAfter = execFileSync('git', ['status', '--porcelain'], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.equal(
    porcelainAfter,
    porcelainBefore,
    'the refused run changed tracked files; --check --preview must render nothing',
  );
});
