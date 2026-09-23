/**
 * Shared runners and payloads for the `server/statusline.mjs` tests
 * (`tests/server/statusline-script.test.ts`,
 * `tests/server/statusline-script-snapshot.test.ts`): spawn the script the way
 * Claude Code does, a realistic status-line payload (Claude Code 2.1.220's
 * stdin JSON shape), and a temp workspace with a real git repo on `main`.
 */
import { spawn } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot, makeTempDir } from './helpers.ts';

export const SCRIPT = join(projectRoot, 'server', 'statusline.mjs');

/** Run the script the way Claude Code does; resolve with trimmed stdout + code. */
export function runStatusline(
  mode: string,
  prefsFile: string,
  payload: unknown,
): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, mode, prefsFile], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ out: out.replace(/\n$/, ''), err, code }));
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

/** Run the script with an ARBITRARY argv (fewer/odd args), same stdin protocol. */
export function runRaw(
  args: string[],
  payload: unknown,
  env?: NodeJS.ProcessEnv,
): Promise<{ out: string; err: string; code: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(env !== undefined ? { env } : {}),
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ out: out.replace(/\n$/, ''), err, code }));
    // The script destroys stdin as soon as it has an answer (or hits its size
    // ceiling), so a large write can legitimately fail with EPIPE mid-flight —
    // that is the guard working, not a test failure.
    child.stdin.on('error', () => {});
    child.stdin.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
  });
}

export interface Fixture {
  session_id: string;
  cwd: string;
  workspace: { current_dir: string; project_dir: string; added_dirs: string[] };
  model: { id: string; display_name: string };
  cost: Record<string, number>;
  context_window: Record<string, unknown>;
  rate_limits?: Record<string, unknown>;
  [key: string]: unknown;
}

/** A full, realistic payload rooted at `dir`. */
export function fixture(dir: string, sessionId = 'sess-1'): Fixture {
  return {
    session_id: sessionId,
    transcript_path: '/home/u/.claude/projects/p/sess-1.jsonl',
    cwd: dir,
    model: { id: 'claude-opus-5', display_name: 'Opus 5' },
    workspace: { current_dir: dir, project_dir: dir, added_dirs: [] },
    version: '2.1.220',
    output_style: { name: 'default' },
    cost: {
      total_cost_usd: 0.4231,
      total_duration_ms: 12_000,
      total_api_duration_ms: 8_000,
      total_lines_added: 120,
      total_lines_removed: 14,
    },
    context_window: {
      total_input_tokens: 64_000,
      total_output_tokens: 1_200,
      context_window_size: 200_000,
      used_percentage: 32.4,
      remaining_percentage: 67.6,
    },
    exceeds_200k_tokens: false,
    rate_limits: {
      five_hour: { used_percentage: 45.6, resets_at: 1_780_000_000 },
      seven_day: { used_percentage: 12.2, resets_at: 1_780_500_000 },
    },
  };
}

/** temp workspace: `git` = a real repo on branch `main`, `plain` = not a repo. */
export async function makeWorkspace(): Promise<{ root: string; repo: string; plain: string; prefs: string }> {
  const root = await makeTempDir('ai-sm-statusline-');
  const repo = join(root, 'repo');
  const plain = join(root, 'plain');
  await mkdir(repo);
  await mkdir(plain);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  const prefs = join(root, 'prefs.json');
  // Claude's own line is OFF by factory default since 2026-09-17 (the bar
  // under the terminal is the default place). The item tests are about
  // the ITEMS, so the workspace switches the line on; the defaults tests write
  // (or omit) their own prefs.
  await writeFile(prefs, JSON.stringify({ statusLine: { enabled: true } }));
  return { root, repo, plain, prefs };
}
