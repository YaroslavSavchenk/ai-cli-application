/**
 * Persistent session history with REAL resume (decided 2026-09-06) —
 * planConversation / resumeSpawn / stripConversationArgs
 * (server/conversation.ts): the pure argv table — when `--session-id` is
 * injected, when a client uuid is adopted, that a picker flag is never fought,
 * the `--flag=value` forms, and `--resume` vs `--continue` on a resume.
 *
 * How: the pure functions called in-process.
 *
 * NOT claimed here: that the child really receives this argv —
 * `tests/server/history.test.ts` (a `claude` double records it).
 *
 * Split out of `tests/server/history.test.ts` by topic (PLAN-RESTRUCTURE O6);
 * the `claude` double, the server fixture and the unit store are
 * `tests/helpers/history-fixture.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planConversation, resumeSpawn, stripConversationArgs } from '../../server/conversation.ts';
import {
  SID,
  CLIENT_UUID,
} from '../helpers/history-fixture.ts';

// ---------------------------------------------------------------------------
// (h) planConversation / resumeSpawn — the pure argv table
// ---------------------------------------------------------------------------

test('planConversation: injects for a bare claude launch, adopts a client uuid, never fights a picker flag', () => {
  // Non-claude: never touched, never a conversation.
  const bash = planConversation('bash', ['-c', 'sleep 300'], SID);
  assert.deepEqual(bash, {
    id: SID,
    conversation: false,
    baseArgs: ['-c', 'sleep 300'],
    spawnArgs: ['-c', 'sleep 300'],
    injected: [],
  });
  // ...even when the argv happens to contain look-alike flags.
  assert.deepEqual(planConversation('/bin/sh', ['-c', 'x'], SID).spawnArgs, ['-c', 'x']);

  // Bare claude launch: inject.
  const bare = planConversation('claude', ['--model', 'opus'], SID);
  assert.deepEqual(bare, {
    id: SID,
    conversation: true,
    baseArgs: ['--model', 'opus'],
    spawnArgs: ['--model', 'opus', '--session-id', SID],
    injected: ['--session-id', SID],
  });
  // An absolute path to claude is still claude.
  assert.deepEqual(planConversation('/usr/bin/claude', [], SID).spawnArgs, ['--session-id', SID]);

  // --continue: no injection (the two flags must never be emitted together).
  const cont = planConversation('claude', ['--continue', '--model', 'opus'], SID);
  assert.equal(cont.conversation, false);
  assert.equal(cont.id, SID);
  assert.deepEqual(cont.spawnArgs, ['--continue', '--model', 'opus'], 'argv untouched');
  assert.deepEqual(cont.baseArgs, ['--model', 'opus'], '--continue is stripped from the base args');
  assert.deepEqual(planConversation('claude', ['-c'], SID).spawnArgs, ['-c']);

  // A client-supplied --session-id uuid IS the conversation; nothing injected.
  const adopted = planConversation('claude', ['--session-id', CLIENT_UUID, '--model', 'opus'], SID);
  assert.deepEqual(adopted, {
    id: CLIENT_UUID,
    conversation: true,
    baseArgs: ['--model', 'opus'],
    spawnArgs: ['--session-id', CLIENT_UUID, '--model', 'opus'],
    injected: [],
  });

  // So is a --resume / -r uuid.
  assert.equal(planConversation('claude', ['--resume', CLIENT_UUID], SID).id, CLIENT_UUID);
  assert.equal(planConversation('claude', ['--resume', CLIENT_UUID], SID).conversation, true);
  assert.equal(planConversation('claude', ['-r', CLIENT_UUID], SID).id, CLIENT_UUID);
  assert.equal(planConversation('claude', [`--resume=${CLIENT_UUID}`], SID).id, CLIENT_UUID);

  // Valueless --resume (the interactive picker) and a non-uuid value: we cannot
  // know which conversation it will be, so no injection and no conversation.
  for (const args of [['--resume'], ['-r'], ['--resume', 'yesterday'], ['--session-id', 'not-a-uuid']]) {
    const plan = planConversation('claude', args, SID);
    assert.equal(plan.conversation, false, `${JSON.stringify(args)} must not claim a conversation`);
    assert.equal(plan.id, SID);
    assert.deepEqual(plan.spawnArgs, args, `${JSON.stringify(args)} must be spawned verbatim`);
  }
  // A dangling --resume before another flag keeps that flag.
  assert.deepEqual(planConversation('claude', ['--resume', '--model', 'opus'], SID).baseArgs, [
    '--model',
    'opus',
  ]);
});

test('planConversation: the agent is named by its last segment on either separator, exactly', () => {
  // Part Q1: the server used path.basename (only `/`), the browser cut both
  // `/` and `\`, so a `C:\x\claude` session read as Claude in the drawer and
  // was never pinned to a conversation here. One rule now (isClaudeCommand in
  // shared/protocol-settings.ts): both separators, and nothing else relaxed.
  for (const command of ['/usr/bin/claude', 'C:\\x\\claude', 'D:\\tools/claude']) {
    assert.deepEqual(planConversation(command, [], SID).injected, ['--session-id', SID], command);
  }
  for (const command of ['C:\\x\\claude.exe', 'claude.exe', 'Claude', '/usr/bin/claude-code', 'claude\\']) {
    assert.deepEqual(planConversation(command, [], SID).injected, [], command);
  }
});

test('stripConversationArgs removes only the resume/session flags (and their values)', () => {
  assert.deepEqual(
    stripConversationArgs([
      '--model', 'opus',
      '--session-id', CLIENT_UUID,
      '--permission-mode', 'plan',
      '-r', 'abc',
      '--continue',
      '-c',
      '--effort', 'high',
      '--settings', '/tmp/x.json',
      '--weird-unknown',
    ]),
    [
      '--model', 'opus',
      '--permission-mode', 'plan',
      '--effort', 'high',
      '--settings', '/tmp/x.json',
      '--weird-unknown',
    ],
  );
  // A value is only eaten when it does not look like a flag.
  assert.deepEqual(stripConversationArgs(['-r', '--model', 'opus']), ['--model', 'opus']);
  assert.deepEqual(stripConversationArgs(['--session-id']), []);
  assert.deepEqual(stripConversationArgs([]), []);
});

test('resumeSpawn: --resume for a pinned conversation, --continue for claude without one, bare argv otherwise', () => {
  assert.deepEqual(
    resumeSpawn({ id: CLIENT_UUID, conversation: true, command: 'claude', args: ['--model', 'opus'] }),
    { command: 'claude', args: ['--model', 'opus', '--resume', CLIENT_UUID] },
  );
  assert.deepEqual(
    resumeSpawn({ id: 'app-session-id', conversation: false, command: 'claude', args: ['--model', 'opus'] }),
    { command: 'claude', args: ['--model', 'opus', '--continue'] },
  );
  assert.deepEqual(
    resumeSpawn({ id: 'app-session-id', conversation: false, command: 'bash', args: ['-c', 'sleep 1'] }),
    { command: 'bash', args: ['-c', 'sleep 1'] },
  );
});

test('planConversation: the --flag=value forms are recognised, uppercase uuids count, and a client picker flag is never fought', () => {
  // `--session-id=<uuid>`: adopted exactly like the space-separated form, and
  // nothing is injected on top of it.
  const eq = planConversation('claude', [`--session-id=${CLIENT_UUID}`, '--model', 'opus'], SID);
  assert.deepEqual(eq, {
    id: CLIENT_UUID,
    conversation: true,
    baseArgs: ['--model', 'opus'],
    spawnArgs: [`--session-id=${CLIENT_UUID}`, '--model', 'opus'],
    injected: [],
  });

  // A uuid is a uuid whatever its case (Claude Code accepts either).
  const upper = CLIENT_UUID.toUpperCase();
  assert.equal(planConversation('claude', [`--session-id=${upper}`], SID).id, upper);
  assert.equal(planConversation('claude', ['-r', upper], SID).conversation, true);

  // `=<not a uuid>` forms: we cannot pin them, so no injection, argv verbatim.
  for (const args of [
    ['--session-id=not-a-uuid'],
    ['--session-id='],
    ['--resume=yesterday'],
    ['--resume='],
    ['-r', 'yesterday'],
  ]) {
    const plan = planConversation('claude', args, SID);
    assert.equal(plan.conversation, false, `${JSON.stringify(args)} must not claim a conversation`);
    assert.equal(plan.id, SID);
    assert.deepEqual(plan.spawnArgs, args, `${JSON.stringify(args)} must be spawned verbatim`);
    assert.deepEqual(plan.injected, [], 'nothing may be reported as injected');
    assert.deepEqual(plan.baseArgs, [], 'the picker flag is stripped from the base args');
  }

  // `-c` with other flags: the base args keep everything else.
  assert.deepEqual(planConversation('claude', ['-c', '--model', 'opus'], SID).baseArgs, [
    '--model',
    'opus',
  ]);

  // A client that typed BOTH a picker and a session id is passed through as-is
  // (the id wins as the entry key); we never ADD a flag next to one of theirs.
  const both = planConversation('claude', ['--continue', '--session-id', CLIENT_UUID], SID);
  assert.equal(both.id, CLIENT_UUID);
  assert.equal(both.conversation, true);
  assert.deepEqual(both.spawnArgs, ['--continue', '--session-id', CLIENT_UUID], 'argv untouched');
  assert.deepEqual(both.baseArgs, [], 'a resume of it starts from the bare args');

  // The injection is exactly two tokens appended at the END, nothing reordered.
  const injected = planConversation('claude', ['--model', 'opus', '--effort', 'high'], SID);
  assert.deepEqual(injected.spawnArgs, [
    '--model',
    'opus',
    '--effort',
    'high',
    '--session-id',
    SID,
  ]);
  assert.equal(injected.spawnArgs.length, injected.baseArgs.length + 2);
  // `injected` names those tokens EXPLICITLY — the caller must not have to
  // diff spawnArgs against the client argv to find them.
  assert.deepEqual(injected.injected, ['--session-id', SID]);

  // Non-claude commands are untouched even when they carry the very flags this
  // module knows — `claude` must be the basename, not a substring.
  for (const command of ['bash', '/bin/sh', 'claude-code', 'myclaude', 'node']) {
    const plan = planConversation(command, ['--session-id', CLIENT_UUID, '--continue'], SID);
    assert.equal(plan.conversation, false, `${command} must never be treated as claude`);
    assert.equal(plan.id, SID);
    assert.deepEqual(plan.spawnArgs, ['--session-id', CLIENT_UUID, '--continue']);
    assert.deepEqual(plan.baseArgs, ['--session-id', CLIENT_UUID, '--continue'],
      'a non-claude command keeps its args verbatim, strip included');
  }
});

test('stripConversationArgs: the =value forms go too, a dangling flag eats nothing, and a flag-shaped value is kept', () => {
  assert.deepEqual(
    stripConversationArgs([
      `--session-id=${CLIENT_UUID}`,
      '--model',
      'opus',
      '--resume=yesterday',
      '--settings',
      '/tmp/x.json',
    ]),
    ['--model', 'opus', '--settings', '/tmp/x.json'],
  );
  // A dangling flag at the end: nothing left to eat.
  assert.deepEqual(stripConversationArgs(['--model', 'opus', '-r']), ['--model', 'opus']);
  assert.deepEqual(stripConversationArgs(['--model', 'opus', '--continue']), ['--model', 'opus']);
  // A `-`-leading token after the flag is NOT its value — it survives.
  assert.deepEqual(stripConversationArgs(['--session-id', '-x']), ['-x']);
  // `--session-idle` is not `--session-id`: only the exact flag and its
  // `=`-form are removed.
  assert.deepEqual(stripConversationArgs(['--session-idle', '5']), ['--session-idle', '5']);
  assert.deepEqual(stripConversationArgs(['--resumed', 'x']), ['--resumed', 'x']);
});
