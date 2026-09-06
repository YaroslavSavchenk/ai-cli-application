/**
 * The DOM-free half of the update notice + backend restart
 * (`web/src/ui/update-model.ts` and `web/src/ui/restart-flow.ts`).
 *
 * WHY THESE TWO MODULES EXIST SEPARATELY FROM `ui/update.ts`: everything that
 * can be got wrong here is a RULE, not a pixel — which surface is shown after
 * which answer, what the confirmation promises for 0 / 1 / N sessions, and how
 * a 202/409/500/timeout maps onto the next state. Both modules take their
 * clock, their sleep and their HTTP through parameters, so `node --test` drives
 * the whole thing with no browser, no timers and no backend.
 *
 * The user's requirement this file is really pinning (2026-09-06): "de popup
 * kun je wegklikken maar die blijft ergens hangen" — dismissing the toast must
 * NOT dismiss the notice, and a poll that keeps repeating the same reason must
 * never bring the toast back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRM_LIST_MAX,
  CONTINUE_NOTE,
  EMPTY,
  REASON_GENERIC,
  UpdateNotice,
  confirmBody,
  fmtRunningFor,
  moreLabel,
  reasonSentence,
  summarizeRunning,
} from '../web/src/ui/update-model.ts';
import {
  HEALTH_POLL_MS,
  HEALTH_TIMEOUT_MS,
  MSG_BUSY,
  MSG_LOST,
  loopbackUrl,
  parseRestartBody,
  runRestart,
  waitForHealth,
  type RestartHttpResult,
  type RestartPhase,
} from '../web/src/ui/restart-flow.ts';
import { hasContinueFlag } from '../web/src/ui/launch-args.ts';
import type { SessionInfo } from '../shared/protocol.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: over.id ?? 'id-1',
    title: over.title ?? 'work',
    command: over.command ?? 'claude',
    args: over.args ?? ['--model', 'opus'],
    cwd: over.cwd ?? '/home/sava/projects/x',
    status: over.status ?? 'running',
    cols: 80,
    rows: 24,
    createdAt: '2026-09-06T10:00:00.000Z',
    attention: false,
    ...(over.projectId !== undefined ? { projectId: over.projectId } : {}),
    ...(over.exitCode !== undefined ? { exitCode: over.exitCode } : {}),
  };
}

const nameOf = (s: SessionInfo): string => s.title;

// ---------------------------------------------------------------------------
// UpdateNotice — the state machine
// ---------------------------------------------------------------------------

test('no update: the notice stays hidden and neither surface is drawn', () => {
  const n = new UpdateNotice();
  assert.equal(n.state, 'hidden');
  assert.equal(n.apply({ available: false, reason: null }), 'hidden');
  assert.equal(n.toastVisible, false);
  assert.equal(n.pillVisible, false);
  assert.equal(n.reason, null);
});

test('an available update raises the toast AND the pill, carrying the reason', () => {
  const n = new UpdateNotice();
  assert.equal(n.apply({ available: true, reason: 'frontend rebuilt' }), 'toast');
  assert.equal(n.toastVisible, true);
  assert.equal(n.pillVisible, true);
  assert.equal(n.reason, 'frontend rebuilt');
});

test('dismissing the toast keeps the PILL — the notice hangs around (the user’s ask)', () => {
  const n = new UpdateNotice();
  n.apply({ available: true, reason: 'frontend rebuilt' });
  assert.equal(n.dismissToast(), 'pill');
  assert.equal(n.toastVisible, false);
  assert.equal(n.pillVisible, true, 'the pill is the persistent half');
});

test('a repeated poll of the SAME reason never re-raises a dismissed toast', () => {
  const n = new UpdateNotice();
  n.apply({ available: true, reason: 'frontend rebuilt' });
  n.dismissToast();
  for (let i = 0; i < 10; i++) {
    assert.equal(n.apply({ available: true, reason: 'frontend rebuilt' }), 'pill');
  }
  assert.equal(n.toastVisible, false);
});

test('a NEW reason is a new fact: the toast comes back', () => {
  const n = new UpdateNotice();
  n.apply({ available: true, reason: 'frontend rebuilt' });
  n.dismissToast();
  assert.equal(n.apply({ available: true, reason: 'server code changed' }), 'toast');
  assert.equal(n.reason, 'server code changed');
  // …and dismissing THAT one does not resurrect the first.
  n.dismissToast();
  assert.equal(n.apply({ available: true, reason: 'frontend rebuilt' }), 'toast');
});

test('a null reason behaves as ONE stable reason, not a new one every poll', () => {
  const n = new UpdateNotice();
  assert.equal(n.apply({ available: true, reason: null }), 'toast');
  n.dismissToast();
  assert.equal(n.apply({ available: true, reason: null }), 'pill');
  assert.equal(n.apply({ available: true, reason: null }), 'pill');
});

test('a backend reporting available:false takes the pill away', () => {
  const n = new UpdateNotice();
  n.apply({ available: true, reason: 'frontend rebuilt' });
  n.dismissToast();
  assert.equal(n.apply({ available: false, reason: null }), 'hidden');
  assert.equal(n.pillVisible, false);
  assert.equal(n.reason, null);
});

test('a missing/absent update member is treated as "nothing to say", never as an update', () => {
  const n = new UpdateNotice();
  assert.equal(n.apply(null), 'hidden');
  assert.equal(n.apply(undefined), 'hidden');
});

test('while restarting, a poll landing mid-handover cannot repaint a toast over the progress', () => {
  const n = new UpdateNotice();
  n.apply({ available: true, reason: 'frontend rebuilt' });
  assert.equal(n.startRestart(), 'restarting');
  assert.equal(n.toastVisible, false);
  assert.equal(n.pillVisible, false);
  assert.equal(n.apply({ available: true, reason: 'something else entirely' }), 'restarting');
});

test('a failed/refused restart restores the surface the pending update deserves', () => {
  const fresh = new UpdateNotice();
  fresh.apply({ available: true, reason: 'frontend rebuilt' });
  fresh.startRestart();
  assert.equal(fresh.restartAborted(), 'toast', 'a never-dismissed reason still toasts');

  const dismissed = new UpdateNotice();
  dismissed.apply({ available: true, reason: 'frontend rebuilt' });
  dismissed.dismissToast();
  dismissed.startRestart();
  assert.equal(
    dismissed.restartAborted(),
    'pill',
    'cancelling a restart is not a new fact — no re-toast',
  );

  const none = new UpdateNotice();
  none.startRestart();
  assert.equal(none.restartAborted(), 'hidden');
});

test('a completed restart is terminal: nothing is shown again on this page', () => {
  const n = new UpdateNotice();
  n.apply({ available: true, reason: 'frontend rebuilt' });
  n.startRestart();
  assert.equal(n.finishRestart(), 'done');
  assert.equal(n.reason, null);
  assert.equal(n.apply({ available: true, reason: 'frontend rebuilt' }), 'done');
  assert.equal(n.toastVisible, false);
  assert.equal(n.pillVisible, false);
});

// ---------------------------------------------------------------------------
// Confirmation copy — the sentence the user has to believe
// ---------------------------------------------------------------------------

test('confirm body: 0 / 1 / N read as English and promise exactly what History delivers', () => {
  assert.equal(confirmBody(0), 'Nothing is running. The app reconnects by itself.');
  assert.equal(
    confirmBody(1),
    'One session is running and will be closed. It stays in History, so you can pick its conversation up again.',
  );
  assert.equal(
    confirmBody(4),
    '4 sessions are running and will be closed. They stay in History, so you can pick each conversation up again.',
  );
  // No CLI vocabulary anywhere in the words the dialog says (the repo-wide
  // guard is tests/ui-copy-rule.test.ts; this is the local canary).
  for (const s of [confirmBody(0), confirmBody(1), confirmBody(7), CONTINUE_NOTE]) {
    assert.ok(!/--\w/.test(s), `copy must not contain a flag: ${s}`);
  }
});

test('summarizeRunning: only RUNNING sessions count — an exited one has nothing left to lose', () => {
  const list = [
    mkSession({ id: 'a', title: 'alpha', status: 'running' }),
    mkSession({ id: 'b', title: 'beta', status: 'exited', exitCode: 0 }),
  ];
  const s = summarizeRunning(list, nameOf, () => 'proj');
  assert.equal(s.count, 1);
  assert.deepEqual(s.rows, [{ name: 'alpha', project: 'proj' }]);
  assert.equal(s.more, 0);
});

test('summarizeRunning: the list is capped at 6 rows and the rest becomes "+ K more"', () => {
  assert.equal(CONFIRM_LIST_MAX, 6);
  const list = Array.from({ length: 9 }, (_, i) =>
    mkSession({ id: `s${i}`, title: `session ${i}`, status: 'running' }),
  );
  const s = summarizeRunning(list, nameOf, () => null);
  assert.equal(s.count, 9);
  assert.equal(s.rows.length, 6);
  assert.equal(s.more, 3);
  assert.equal(moreLabel(s.more), '+ 3 more');
  assert.equal(moreLabel(0), '', 'nothing left out means no line at all');
});

test('summarizeRunning: rows carry the project NAME, and null when there is no project', () => {
  const list = [
    mkSession({ id: 'a', title: 'alpha', projectId: 'p1' }),
    mkSession({ id: 'b', title: 'beta' }),
  ];
  const s = summarizeRunning(list, nameOf, (x) => (x.projectId === 'p1' ? 'Session Manager' : null));
  assert.deepEqual(s.rows, [
    { name: 'alpha', project: 'Session Manager' },
    { name: 'beta', project: null },
  ]);
  // The path never appears — the project's NAME is the only place word.
  for (const r of s.rows) assert.ok(r.project === null || !r.project.includes('/'));
});

test('the "Continue last conversation" footnote appears only when such a session is running', () => {
  const plain = summarizeRunning([mkSession({ args: ['--model', 'opus'] })], nameOf, () => null);
  assert.equal(plain.continued, false);

  const long = summarizeRunning(
    [mkSession({ args: ['--model', 'opus', '--continue'] })],
    nameOf,
    () => null,
  );
  assert.equal(long.continued, true);

  const short = summarizeRunning([mkSession({ args: ['-c'] })], nameOf, () => null);
  assert.equal(short.continued, true, 'the short spelling counts too');

  // An EXITED continued session must not drag the footnote in.
  const exited = summarizeRunning(
    [mkSession({ status: 'exited', exitCode: 0, args: ['--continue'] })],
    nameOf,
    () => null,
  );
  assert.equal(exited.continued, false);

  assert.equal(hasContinueFlag(['--model', 'opus']), false);
  assert.equal(hasContinueFlag(['--continue']), true);
  assert.equal(hasContinueFlag(['-c']), true);
});

test('the footnote is CLAUDE-only: a custom command whose `-c` means something else is not a resume', () => {
  // `ssh -c aes256-gcm@openssh.com host` and `sh -c '…'` both carry a -c that
  // has nothing to do with a Claude conversation. The rule is the server's:
  // basename(command) === 'claude' (server/conversation.ts).
  const ssh = summarizeRunning(
    [mkSession({ command: 'ssh', args: ['-c', 'aes256-gcm@openssh.com', 'box'] })],
    nameOf,
    () => null,
  );
  assert.equal(ssh.continued, false, 'a custom command never earns the Claude footnote');

  const claude = summarizeRunning([mkSession({ command: 'claude', args: ['-c'] })], nameOf, () => null);
  assert.equal(claude.continued, true);

  const absolute = summarizeRunning(
    [mkSession({ command: '/home/sava/.nvm/versions/node/v24.14.0/bin/claude', args: ['--continue'] })],
    nameOf,
    () => null,
  );
  assert.equal(absolute.continued, true, 'a full path to claude is still claude');

  const lookalike = summarizeRunning(
    [mkSession({ command: 'claude-wrapper', args: ['--continue'] })],
    nameOf,
    () => null,
  );
  assert.equal(lookalike.continued, false, 'a name that merely starts with claude is not claude');
});

test('reasonSentence: the server’s diagnostic reason is never what the user reads', () => {
  // PROJECT-SCOPE copy rule: no code, hashes or file words in the GUI. The raw
  // reason keeps its place in the client LOG line — this is the visible half.
  assert.equal(reasonSentence('server code changed (6113709 → a1b2c3d)'), 'The server code changed.');
  assert.equal(reasonSentence('frontend rebuilt'), "The app's screens were rebuilt.");
  assert.equal(reasonSentence('server files edited'), 'Server files were edited.');

  for (const sentence of [
    reasonSentence('server code changed (6113709 → a1b2c3d)'),
    reasonSentence('frontend rebuilt'),
    reasonSentence('server files edited'),
  ]) {
    assert.ok(sentence !== null && !/[0-9a-f]{7}/.test(sentence), `no git hash in: ${String(sentence)}`);
  }

  // Anything the backend grows later still cannot leak into the chrome.
  assert.equal(reasonSentence('web/dist/index.html mtime 1757150000000'), REASON_GENERIC);
  assert.equal(REASON_GENERIC, 'A newer version is on disk.');

  // Nothing to add: there IS an update, the server just did not say why.
  assert.equal(reasonSentence(null), null);
  assert.equal(reasonSentence(''), null);
  assert.equal(reasonSentence(undefined), null);
});

test('hasContinueFlag matches WHOLE argv tokens — a look-alike flag is not a continue', () => {
  // The footnote this drives makes a promise about which conversation comes
  // back. A prefix/substring match would attach it to flags that mean nothing
  // of the sort, and would drop it from a `--continue` sitting after a value.
  for (const args of [
    [],
    ['--continued'],
    ['--continue-session'],
    ['-continue'],
    ['--c'],
    ['-C'],
    ['--model', 'continue'],
    ['--resume', 'c'],
    ['--settings', '/tmp/-c'],
  ]) {
    assert.equal(hasContinueFlag(args), false, JSON.stringify(args));
  }
  for (const args of [
    ['--continue'],
    ['-c'],
    ['--model', 'opus', '--continue'],
    ['--effort', 'high', '-c', '--dangerously-skip-permissions'],
  ]) {
    assert.equal(hasContinueFlag(args), true, JSON.stringify(args));
  }
});

// ---------------------------------------------------------------------------
// Readouts
// ---------------------------------------------------------------------------

test('fmtRunningFor: coarse, honest, and never a fabricated age', () => {
  const base = Date.parse('2026-09-06T12:00:00.000Z');
  const at = (ms: number): string => new Date(base - ms).toISOString();
  assert.equal(fmtRunningFor(at(5_000), base), 'just started');
  assert.equal(fmtRunningFor(at(60_000), base), '1 min');
  assert.equal(fmtRunningFor(at(41 * 60_000), base), '41 min');
  assert.equal(fmtRunningFor(at(3 * 3_600_000), base), '3 h');
  assert.equal(fmtRunningFor(at(3 * 3_600_000 + 41 * 60_000), base), '3 h 41 min');
  assert.equal(fmtRunningFor(at(50 * 3_600_000), base), '2 d 2 h');
  assert.equal(fmtRunningFor(at(48 * 3_600_000), base), '2 d');
  assert.equal(fmtRunningFor(null, base), EMPTY);
  assert.equal(fmtRunningFor('not a timestamp', base), EMPTY);
  // Clock skew is not an event: a future boot time reads as just started.
  assert.equal(fmtRunningFor(at(-60_000), base), 'just started');
});

// ---------------------------------------------------------------------------
// restart-flow — the 202 / 409 / 500 / timeout handshake
// ---------------------------------------------------------------------------

interface Harness {
  deps: {
    postRestart(): Promise<RestartHttpResult>;
    health(): Promise<boolean>;
    now(): number;
    sleep(ms: number): Promise<void>;
    onPhase(p: RestartPhase): void;
  };
  phases: RestartPhase[];
  slept: number[];
  healthCalls: number;
}

/**
 * A fake clock that only moves when the flow SLEEPS — so the 20 s budget is
 * exercised in microseconds and the number of probes is exact rather than
 * timing-dependent.
 */
function harness(opts: {
  post: RestartHttpResult | (() => Promise<RestartHttpResult>);
  healthyAfter?: number; // probes that must fail before /health answers
}): Harness {
  const phases: RestartPhase[] = [];
  const slept: number[] = [];
  let clock = 0;
  let healthCalls = 0;
  const h: Harness = {
    phases,
    slept,
    get healthCalls() {
      return healthCalls;
    },
    deps: {
      postRestart:
        typeof opts.post === 'function'
          ? opts.post
          : async (): Promise<RestartHttpResult> => opts.post as RestartHttpResult,
      async health() {
        healthCalls += 1;
        return opts.healthyAfter !== undefined && healthCalls > opts.healthyAfter;
      },
      now: () => clock,
      async sleep(ms: number) {
        slept.push(ms);
        clock += ms;
      },
      onPhase: (p) => phases.push(p),
    },
  };
  return h;
}

test('202 samePort: the flow waits for /health, then asks for a reload', async () => {
  const h = harness({
    post: { status: 202, body: { port: 41234, startedAt: 'x', samePort: true } },
    healthyAfter: 3,
  });
  const out = await runRestart(h.deps);
  assert.deepEqual(h.phases, ['restarting', 'reconnecting'], 'both in-flight states are announced');
  assert.equal(out.kind, 'reload');
  assert.equal(h.healthCalls, 4, 'one immediate probe, then one per 250 ms');
  assert.deepEqual(h.slept, [HEALTH_POLL_MS, HEALTH_POLL_MS, HEALTH_POLL_MS]);
  if (out.kind === 'reload') assert.equal(out.afterMs, 3 * HEALTH_POLL_MS);
});

test('202 samePort but the backend never answers: the 20 s budget ends it with the relaunch message', async () => {
  const h = harness({ post: { status: 202, body: { port: 1, startedAt: 'x', samePort: true } } });
  const out = await runRestart(h.deps);
  assert.equal(out.kind, 'failed');
  if (out.kind === 'failed') assert.equal(out.message, MSG_LOST);
  // 20000 / 250 = 80 sleeps, 81 probes (the first one is immediate).
  assert.equal(h.slept.length, HEALTH_TIMEOUT_MS / HEALTH_POLL_MS);
  assert.equal(h.healthCalls, HEALTH_TIMEOUT_MS / HEALTH_POLL_MS + 1);
});

test('202 with samePort:false never polls or reloads — this window may not be able to follow', async () => {
  const h = harness({
    post: { status: 202, body: { port: 45678, startedAt: 'x', samePort: false } },
    healthyAfter: 0,
  });
  const out = await runRestart(h.deps);
  assert.deepEqual(out, { kind: 'otherPort', port: 45678 });
  assert.deepEqual(h.phases, ['restarting'], 'no "reconnecting" — there is nothing to reconnect to');
  assert.equal(h.healthCalls, 0);
});

test('409: the restart did not happen, and the server’s own words are shown', async () => {
  const h = harness({ post: { status: 409, body: { error: 'restart already in progress' } } });
  const out = await runRestart(h.deps);
  assert.deepEqual(out, { kind: 'busy', message: 'restart already in progress' });

  const bare = harness({ post: { status: 409, body: null } });
  const out2 = await runRestart(bare.deps);
  assert.deepEqual(out2, { kind: 'busy', message: MSG_BUSY }, 'a bodyless 409 still says something');
});

test('500 and a network failure both end in the relaunch instruction', async () => {
  const server = harness({ post: { status: 500, body: { error: 'restart failed: child never came up' } } });
  assert.deepEqual(await runRestart(server.deps), {
    kind: 'failed',
    message: 'restart failed: child never came up',
  });

  const bare = harness({ post: { status: 500, body: {} } });
  assert.deepEqual(await runRestart(bare.deps), { kind: 'failed', message: MSG_LOST });

  const dead = harness({ post: { status: 0, body: null } });
  assert.deepEqual(await runRestart(dead.deps), { kind: 'failed', message: MSG_LOST });

  const threw = harness({
    post: () => {
      throw new Error('boom');
    },
  });
  assert.deepEqual(await runRestart(threw.deps), { kind: 'failed', message: MSG_LOST });
});

test('a 202 whose body is not the contract is treated as same-port: wait for this origin', async () => {
  const h = harness({ post: { status: 202, body: { port: 'nope' } }, healthyAfter: 0 });
  const out = await runRestart(h.deps);
  assert.equal(out.kind, 'reload');
  assert.deepEqual(h.phases, ['restarting', 'reconnecting']);
});

test('parseRestartBody accepts exactly the contract and rejects everything else', () => {
  assert.deepEqual(parseRestartBody({ port: 5, startedAt: 'i', samePort: true }), {
    port: 5,
    startedAt: 'i',
    samePort: true,
  });
  for (const bad of [
    null,
    'nope',
    {},
    { port: 5, startedAt: 'i' },
    { port: '5', startedAt: 'i', samePort: true },
    { port: Number.NaN, startedAt: 'i', samePort: true },
    { port: 5, startedAt: 3, samePort: true },
    { port: 5, startedAt: 'i', samePort: 'yes' },
    // The port becomes a NAVIGATION address, so the range is part of the
    // contract: finite is not enough.
    { port: 0, startedAt: 'i', samePort: true },
    { port: -1, startedAt: 'i', samePort: true },
    { port: 65536, startedAt: 'i', samePort: true },
    { port: 1e9, startedAt: 'i', samePort: true },
    { port: 8080.5, startedAt: 'i', samePort: true },
    { port: Number.POSITIVE_INFINITY, startedAt: 'i', samePort: true },
  ]) {
    assert.equal(parseRestartBody(bad), null, JSON.stringify(bad));
  }
  // The edges themselves are real ports.
  assert.equal(parseRestartBody({ port: 1, startedAt: 'i', samePort: true })?.port, 1);
  assert.equal(parseRestartBody({ port: 65535, startedAt: 'i', samePort: true })?.port, 65535);
});

test('a 202 claiming another port but naming an impossible one never becomes a navigation', async () => {
  // Without the range check this ends in location.href = "http://127.0.0.1:0/"
  // (or :1e99). With it, the body is not the contract, so the flow waits on
  // THIS origin and — nothing being there — says the relaunch sentence.
  for (const port of [0, 70000, 8080.5]) {
    const h = harness({ post: { status: 202, body: { port, startedAt: 'x', samePort: false } } });
    const out = await runRestart(h.deps);
    assert.equal(out.kind, 'failed', `port ${port} must not produce an address`);
    if (out.kind === 'failed') assert.equal(out.message, MSG_LOST);
  }
});

test('waitForHealth returns immediately when the replacement is already up', async () => {
  const h = harness({ post: { status: 202, body: null }, healthyAfter: 0 });
  const took = await waitForHealth(h.deps);
  assert.equal(took, 0);
  assert.equal(h.healthCalls, 1);
  assert.deepEqual(h.slept, [], 'a warm handover costs no wait at all');
});

test('the fallback address is loopback-only, ends in a slash, and carries no token', () => {
  assert.equal(loopbackUrl(41234), 'http://127.0.0.1:41234/');
  assert.ok(!loopbackUrl(41234).includes('token'));
});
