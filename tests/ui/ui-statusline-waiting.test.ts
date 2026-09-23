/**
 * `web/src/ui/statusline.ts` — the app's bottom bar's amber `N waiting for
 * you`, driven against the fake document.
 *
 * What is pinned: the count is BELs only (`attentionCount()`). B11 first
 * counted ended turns ('Waiting for you') too; the user took that out on the
 * B11 check (2026-09-22) — an ended turn shows on its own pane, not in the
 * counts. Zero draws no segment at all. The Sessions badge in main.ts reads
 * the same `attentionCount()` (pinned here by source).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionInfo } from '../../shared/protocol.ts';
import { byClass, installDom, type FakeElement } from '../helpers/fake-dom.ts';
import { projectRoot } from '../helpers/helpers.ts';

const dom = installDom();

const st = (await import(new URL('../../web/src/state.ts', import.meta.url).href)) as typeof import('../../web/src/state.ts');
const bar = (await import(
  new URL('../../web/src/ui/statusline.ts', import.meta.url).href
)) as typeof import('../../web/src/ui/statusline.ts');

function mk(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    title: id,
    command: 'claude',
    args: [],
    cwd: '/home/tester/api',
    status: 'running',
    cols: 80,
    rows: 24,
    createdAt: '2026-09-22T10:00:00.000Z',
    attention: false,
    ...over,
  };
}

const root = dom.doc.createElement('div') as unknown as FakeElement;
bar.initStatusline(root as unknown as HTMLElement, { openShortcuts: () => {} });

const waitingText = (): string[] => byClass(root, 'status-attn').map((n) => n.textContent);

test('only BELs are counted — an ended turn alone adds nothing', () => {
  st.setSessions([
    mk('s1', { attention: true, turn: 'waiting' }), // both: once
    mk('s2', { turn: 'waiting' }),
    mk('s3', { turn: 'working' }),
    mk('s4'), // no turn readout
    mk('s5', { status: 'exited', turn: 'waiting' }),
  ]);
  bar.render();
  assert.deepEqual(waitingText(), ['1 waiting for you']);
});

test('no BEL -> no segment at all, even with sessions waiting', () => {
  st.setSessions([mk('s1', { turn: 'working' }), mk('s2'), mk('s3', { turn: 'waiting' })]);
  bar.render();
  assert.deepEqual(waitingText(), []);
});

test('the Sessions badge counts the same set (main.ts reads attentionCount)', () => {
  const main = readFileSync(join(projectRoot, 'web', 'src', 'main.ts'), 'utf8');
  const chrome = main.slice(main.indexOf('function updateChrome'));
  assert.ok(chrome.length > 100, 'non-vacuity: updateChrome exists');
  const body = chrome.slice(0, chrome.indexOf('sessionsBadge.textContent'));
  assert.match(body, /const n = st\.attentionCount\(\);/);
});
