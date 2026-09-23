/**
 * Size guard: one file, one topic (decided 2026-09-23, user's call — the
 * rules are `tests/README.md` § Size, the plan
 * `.claude/plans/PLAN-RESTRUCTURE.md` § O4–O8).
 *
 * A tracked test module (`tests/**` `*.ts`) stays at or under 800 lines; a
 * tracked source file in `server/`, `web/src/` or `shared/` (`.ts`, `.mjs`,
 * `.css`) at or under 1 000. The reason is reading cost, not speed: a reader
 * — a person or an agent — opens the part about its topic, not 3 000 lines.
 *
 * `GRANDFATHERED` lists the files that were over the limit when the rule
 * came in. The list may only SHRINK: a file on it that is split below its
 * limit must leave the list (the second test fails until it does), and no
 * file may join it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectRoot } from '../helpers/helpers.ts';

const TEST_LIMIT = 800;
const SOURCE_LIMIT = 1000;

/** Over the limit on 2026-09-23. Remove a line when its file is split. */
const GRANDFATHERED = new Set([
  'server/agents.ts',
  'server/api.ts',
  'server/github.ts',
  'server/index.ts',
  'server/sessions.ts',
  'shared/protocol.ts',
  'tests/helpers/fake-dom.ts',
  'tests/release/installer-helpers.test.ts',
  'tests/release/launcher-config.test.ts',
  'tests/server/agents.test.ts',
  'tests/server/buildinfo.test.ts',
  'tests/server/fs-delete.test.ts',
  'tests/server/fs-rename.test.ts',
  'tests/server/fs-text.test.ts',
  'tests/server/fs-upload.test.ts',
  'tests/server/git-changes.test.ts',
  'tests/server/git-commits.test.ts',
  'tests/server/github-connected.test.ts',
  'tests/server/github-token.test.ts',
  'tests/server/github.test.ts',
  'tests/server/history.test.ts',
  'tests/server/logging.test.ts',
  'tests/server/restart.test.ts',
  'tests/server/sessions-kill.test.ts',
  'tests/server/statusline-script.test.ts',
  'tests/server/update-install.test.ts',
  'tests/server/update-release.test.ts',
  'tests/ui/ui-a6-screens.test.ts',
  'tests/ui/ui-a9-drop-dialog.test.ts',
  'tests/ui/ui-b9-theme.test.ts',
  'tests/ui/ui-context-menu.test.ts',
  'tests/ui/ui-dnd-a10.test.ts',
  'tests/ui/ui-drop-model.test.ts',
  'tests/ui/ui-file-pane.test.ts',
  'tests/ui/ui-filedrop.test.ts',
  'tests/ui/ui-files-create.test.ts',
  'tests/ui/ui-files-delete.test.ts',
  'tests/ui/ui-files-panel.test.ts',
  'tests/ui/ui-github-model.test.ts',
  'tests/ui/ui-launch-args.test.ts',
  'tests/ui/ui-launch-dialog.test.ts',
  'tests/ui/ui-settings-panel.test.ts',
  'tests/ui/ui-state.test.ts',
  'tests/ui/ui-update-model.test.ts',
  'web/src/main.ts',
  'web/src/state.ts',
  'web/src/styles/app.css',
  'web/src/ui/files.ts',
  'web/src/ui/github.ts',
  'web/src/ui/launch.ts',
  'web/src/ui/panes.ts',
  'web/src/ui/settings.ts',
]);

function limitFor(rel: string): number | null {
  if (rel.startsWith('tests/')) return rel.endsWith('.ts') ? TEST_LIMIT : null;
  if (/^(server|web\/src|shared)\//.test(rel) && /\.(ts|mjs|css)$/.test(rel)) return SOURCE_LIMIT;
  return null;
}

const tracked = execFileSync('git', ['ls-files', '-z', 'tests', 'server', 'web/src', 'shared'], {
  cwd: projectRoot,
  encoding: 'utf8',
  maxBuffer: 32 * 1024 * 1024,
})
  .split('\0')
  .filter((p) => p.length > 0);

/** Lines as `wc -l` counts them: newline characters. */
function lineCount(rel: string): number {
  const text = readFileSync(join(projectRoot, rel), 'utf8');
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

const measured = tracked
  .map((rel) => ({ rel, limit: limitFor(rel) }))
  .filter((f): f is { rel: string; limit: number } => f.limit !== null)
  .map((f) => ({ ...f, lines: lineCount(f.rel) }));

test('no test module over 800 lines and no source file over 1 000, outside the grandfathered list', () => {
  assert.ok(measured.length > 100, `only ${measured.length} files measured - is this a git tree?`);
  const over = measured
    .filter((f) => f.lines > f.limit && !GRANDFATHERED.has(f.rel))
    .map((f) => `${f.rel}: ${f.lines} lines (limit ${f.limit}) - split it by topic, see tests/README.md`);
  assert.deepEqual(over, []);
});

test('the grandfathered list only shrinks: every entry exists and is still over its limit', () => {
  const byRel = new Map(measured.map((f) => [f.rel, f]));
  const stale = [...GRANDFATHERED].filter((rel) => {
    const f = byRel.get(rel);
    return f === undefined || f.lines <= f.limit;
  });
  assert.deepEqual(stale, [], 'split or gone: remove these from GRANDFATHERED in tests/repo/file-size.test.ts');
});
