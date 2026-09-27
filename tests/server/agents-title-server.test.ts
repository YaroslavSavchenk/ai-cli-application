/**
 * server/index.ts — the Nocturne C2 fix after the DEV check
 * (.claude/plans/nocturne/PLAN-C2.md § Fix after the DEV check) as the real
 * backend wires it: the AgentsWatcher gets SessionManager's title stamp
 * through the `titleIdleSince` callback, per session id, so a turn the
 * transcript says RUNS reads 'waiting' (with `turnEnded`) once the session's
 * PTY has shown Claude Code's idle title (`✳ …`) for 3 s, and 'working' again
 * on the spinner.
 *
 * How: a real server child (`startTestServer`) with CLAUDE_CONFIG_DIR on a
 * temp tree holding the session's transcript; a bash session that prints the
 * titles on demand (TITLE_BASH, `tests/helpers/agents-fixture.ts`); the status
 * line's snapshot file, written the way server/statusline.mjs writes it, is
 * what makes the backend track the transcript. The frames are read off a real
 * WebSocket. The backend's own clocks run (2 s poll, 3 s idle), so this file
 * waits on frames for up to 15 s rather than stepping time; every other
 * title-verdict rule is proven on a stepped clock in
 * `tests/server/agents-title.test.ts`.
 *
 * Why it matters: the callback is the only thread between the PTY scan and
 * the verdict. Unwired, or asked with the wrong id, every other test of the
 * rule still passes while the app never shows "Waiting for you" on a
 * question or a permission prompt — the user's DEV-check report.
 *
 * NOT claimed here: a real Claude Code session (the DEV check, PLAN-C2 §
 * Gates); the scan and the stamp rules (`tests/server/sessions-output-scan.test.ts`,
 * `tests/server/sessions-title.test.ts`).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionInfo } from '../../shared/protocol.ts';
import {
  WsClient,
  createSession,
  makeTempDir,
  removeTempDir,
  startTestServer,
  waitUntil,
  wsUrl,
  type TestServer,
} from '../helpers/helpers.ts';
import { REAL, TITLE_BASH, UUID } from '../helpers/agents-fixture.ts';

/** TITLE_IDLE_MS in server/agents-verdict.ts (not exported; kept in step here). */
const TITLE_IDLE_MS = 3_000;

/** A frame the backend's 2 s poll (plus the snapshot debounce) must deliver by: generous for a slow runner. */
const FRAME_WAIT_MS = 15_000;

let server: TestServer;
let claudeDir: string;
let transcript: string;

before(async () => {
  claudeDir = await makeTempDir('ai-sm-title-claude-');
  const slug = join(claudeDir, 'projects', '-home-you-projects-app');
  await mkdir(slug, { recursive: true });
  transcript = join(slug, `${UUID}.jsonl`);
  // The transcript says the turn runs: a prompt, then a tool call.
  await writeFile(transcript, `${REAL.prompt}\n${REAL.toolUse}\n`, { mode: 0o600 });
  server = await startTestServer({ env: { CLAUDE_CONFIG_DIR: claudeDir } });
});

after(async () => {
  await server.stop();
  await removeTempDir(claudeDir);
});

/** The latest `info` frame at index `from` or later whose session matches `ok`. */
function waitFrame(client: WsClient, ok: (s: SessionInfo) => boolean, what: string, from = 0): Promise<{ info: SessionInfo; index: number }> {
  return waitUntil(
    () => {
      for (let i = client.messages.length - 1; i >= from; i--) {
        const m = client.messages[i];
        if (m?.type === 'info' && ok(m.session)) return { info: m.session, index: i };
      }
      return undefined;
    },
    what,
    FRAME_WAIT_MS,
    25,
  );
}

test('C2 title, the real backend: the manager stamp reaches the verdict by session id — idle 3 s -> waiting with turnEnded, the spinner -> working', async () => {
  const session = await createSession(server, { command: 'bash', args: TITLE_BASH, cwd: claudeDir, cols: 80, rows: 24 });
  const client = await WsClient.connect(wsUrl(server, session.id));
  try {
    await client.waitForMessage('replay');
    // The status line's snapshot names the transcript: the backend starts tracking it.
    const snapshot = join(server.dataDir, 'statusline-snapshots', `${session.id}.json`);
    await writeFile(`${snapshot}.tmp`, JSON.stringify({ v: 1, at: Date.now(), transcript }), { mode: 0o600 });
    await rename(`${snapshot}.tmp`, snapshot);
    const working = await waitFrame(client, (s) => s.turn === 'working', 'the transcript verdict: working');

    const sent = Date.now();
    client.send({ type: 'input', data: 'idle\r' });
    await client.waitForOutput('DONE-idle');
    const asked = await waitFrame(client, (s) => s.turn === 'waiting', 'waiting after 3 s of an idle title', working.index + 1);
    const waited = Date.now() - sent;
    assert.ok(waited >= TITLE_IDLE_MS, `not before the title was idle for 3 s: ${waited} ms`);
    assert.equal(asked.info.turnEnded, true, 'working -> waiting: the mascot comes');
    assert.equal(typeof asked.info.pendingSince, 'string');

    client.send({ type: 'input', data: 'spin\r' });
    const back = await waitFrame(client, (s) => s.turn === 'working', 'working again on the spinner', asked.index + 1);
    assert.equal('turnEnded' in back.info, false, 'answered: the mascot leaves');
  } finally {
    await client.close();
  }
});
