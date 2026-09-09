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
  DEPS_NOTE,
  EMPTY,
  PILL_LABEL,
  PILL_LABEL_RESTARTING,
  REASON_DEPS,
  REASON_GENERIC,
  REASON_INSTALLED,
  UpdateNotice,
  confirmBody,
  fmtRunningFor,
  moreLabel,
  reasonNote,
  reasonSentence,
  summarizeRunning,
  versionFact,
} from '../web/src/ui/update-model.ts';
import {
  HEALTH_POLL_MS,
  HEALTH_TIMEOUT_MS,
  MSG_BUSY,
  MSG_LOST,
  MSG_REFUSED,
  canHideRestartDialog,
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
    cwd: over.cwd ?? '/home/you/projects/x',
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
  assert.equal(n.apply({ available: true, reason: 'something else entirely' }), 'restarting');
});

test('while restarting the PILL stays, renamed, and a click can only bring the dialog back', () => {
  // The dialog may be hidden during the preflight (sessions are alive), and it
  // then has to be reachable from something other than the settings panel —
  // and the screen has to say a restart is running at all.
  const n = new UpdateNotice();
  n.apply({ available: true, reason: 'frontend rebuilt' });
  assert.deepEqual(
    { label: n.pillLabel, action: n.pillAction, pill: n.pillVisible },
    { label: PILL_LABEL, action: 'confirm', pill: true },
    'before the restart it is the ordinary update pill',
  );

  n.startRestart();

  assert.equal(n.pillVisible, true, 'the pill is the only on-screen sign of a running restart');
  assert.equal(n.toastVisible, false, 'the toast still steps aside');
  assert.equal(n.pillLabel, PILL_LABEL_RESTARTING);
  assert.equal(n.pillAction, 'reveal', 'a click shows the flow, it never re-asks the question');

  // …and when the restart is refused, the pill goes back to being the pill.
  n.restartAborted();
  assert.deepEqual({ label: n.pillLabel, action: n.pillAction }, { label: PILL_LABEL, action: 'confirm' });
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
  assert.equal(n.pillVisible, false, 'the page is being replaced: nothing to press any more');
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
    [mkSession({ command: '/home/you/.nvm/versions/node/v24.14.0/bin/claude', args: ['--continue'] })],
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

test('versionFact: the bundle version wins, the commit is the fallback, neither is never invented', () => {
  // Two ways this app runs (2026-09-08). An INSTALLED backend knows its bundle
  // version and that is the identity its user can act on — it matches what the
  // releases page lists. A developer clone has no version and identifies
  // itself by the commit it was started from, exactly as this line always did.
  assert.equal(versionFact('v0.2.0', 'a1b2c3d'), 'v0.2.0');
  assert.equal(versionFact('v0.2.0', null), 'v0.2.0');
  assert.equal(versionFact(null, 'a1b2c3d'), 'a1b2c3d');
  // A backend that could answer neither says so with the app's one empty glyph,
  // never with a plausible-looking stand-in.
  assert.equal(versionFact(null, null), EMPTY);
  assert.equal(EMPTY, '—');
  // One fact, one slot: the fallback replaces, it never concatenates.
  assert.equal(versionFact('v0.2.0', 'a1b2c3d').includes('a1b2c3d'), false);
});

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

// ---------------------------------------------------------------------------
// 422 — the preflight refusal (2026-09-08)
// ---------------------------------------------------------------------------

test('422: the preflight refused, and that is NOT a failure — the old backend is untouched', async () => {
  // The whole point of the separate outcome: `failed` makes the page tell the
  // user to relaunch from the shortcut, which would be a lie here. Nothing was
  // touched — the caller has to un-arm the restart gap and let the app go on.
  const h = harness({
    post: {
      status: 422,
      body: { error: 'restart refused: dependencies changed — install them in the project folder, then restart' },
    },
  });
  const out = await runRestart(h.deps);
  assert.deepEqual(out, {
    kind: 'refused',
    message: 'restart refused: dependencies changed — install them in the project folder, then restart',
  });
  // Only the preflight phase was ever announced: there is nothing to reconnect
  // to, because nothing went away.
  assert.deepEqual(h.phases, ['restarting']);
  assert.equal(h.healthCalls, 0, 'a refusal must not poll /health — the backend never left');
  assert.deepEqual(h.slept, []);
});

test('a 422 with no usable body still says the one thing that is true of every refusal', async () => {
  for (const body of [null, {}, { error: '' }, { error: 42 }, 'nope']) {
    const h = harness({ post: { status: 422, body } });
    const out = await runRestart(h.deps);
    assert.deepEqual(out, { kind: 'refused', message: MSG_REFUSED }, JSON.stringify(body));
  }
  assert.equal(
    MSG_REFUSED,
    'The restart did not start, so nothing changed. Your sessions are still running.',
  );
  // It must not be the relaunch instruction: that sentence ends this page.
  assert.notEqual(MSG_REFUSED, MSG_LOST);
});

test('the refusal is distinguishable from every other outcome by KIND, not by text', async () => {
  // A caller switching on the message would be one server reword away from
  // killing a live page. Each status maps to its own kind.
  const kinds: Record<number, string> = {};
  for (const status of [202, 409, 422, 500]) {
    const body =
      status === 202 ? { port: 41234, startedAt: 'x', samePort: true } : { error: 'because' };
    const h = harness({ post: { status, body }, healthyAfter: 0 });
    kinds[status] = (await runRestart(h.deps)).kind;
  }
  assert.deepEqual(kinds, { 202: 'reload', 409: 'busy', 422: 'refused', 500: 'failed' });
});

test('the phase copy the dialog shows is driven by exactly two callbacks, in order', async () => {
  // The first phase is now a PREFLIGHT that can run for seconds (a build) with
  // nothing yet destroyed, so the dialog has to be able to say "preparing"
  // before it says "reconnecting" — one callback each, never the reverse.
  const ok = harness({
    post: { status: 202, body: { port: 41234, startedAt: 'x', samePort: true } },
    healthyAfter: 0,
  });
  await runRestart(ok.deps);
  assert.deepEqual(ok.phases, ['restarting', 'reconnecting']);

  const refused = harness({ post: { status: 422, body: { error: 'no' } } });
  await runRestart(refused.deps);
  assert.deepEqual(refused.phases, ['restarting'], 'a refusal never reaches the reconnect phase');

  const busy = harness({ post: { status: 409, body: null } });
  await runRestart(busy.deps);
  assert.deepEqual(busy.phases, ['restarting']);
});

test('a refused restart puts the pending notice back exactly like a cancelled one', () => {
  // `restartAborted()` is the model half of the un-arming: after a refusal the
  // update is still pending and the surface it deserves comes back.
  const n = new UpdateNotice();
  n.apply({ available: true, reason: 'dependencies changed' });
  n.dismissToast();
  n.startRestart();
  assert.equal(n.restartAborted(), 'pill', 'a dismissed reason does not re-toast after a refusal');
  assert.equal(n.reason, 'dependencies changed', 'and the reason is still pending');
  // A poll landing afterwards keeps saying the same thing, without nagging.
  assert.equal(n.apply({ available: true, reason: 'dependencies changed' }), 'pill');
});

test('the new preflight reasons all read as plain sentences, and the dependency one instructs', () => {
  assert.equal(
    reasonSentence('frontend build missing'),
    "The app's screens have not been built yet.",
  );
  assert.equal(reasonSentence('frontend source changed'), "The app's screens changed.");
  assert.equal(reasonSentence('dependencies changed'), REASON_DEPS);
  assert.equal(
    REASON_DEPS,
    'Dependencies changed; install them in the project folder first, then restart.',
  );
  // Copy rule (PROJECT-SCOPE 2026-07-25): the sentence tells the user WHERE to
  // act without naming a command, a flag or a file.
  for (const s of [
    reasonSentence('frontend build missing'),
    reasonSentence('frontend source changed'),
    REASON_DEPS,
    DEPS_NOTE,
  ]) {
    assert.ok(s !== null);
    assert.ok(!/--\w/.test(s as string), `no flag in: ${String(s)}`);
    assert.ok(!/\bnpm\b|\bnode_modules\b|\bvite\b/i.test(s as string), `no tooling name in: ${String(s)}`);
  }
});

test('installed mode: the one reason a packaged app can report reads as a plain sentence', () => {
  // Installed mode (2026-09-08) replaces the six developer reasons with exactly
  // one: `<app>/current` resolves to a version directory other than the running
  // one, because the user ran a newer Setup. The user never sees that sentence
  // — they see what happened to THEM.
  assert.equal(reasonSentence('a new version is installed'), REASON_INSTALLED);
  assert.equal(REASON_INSTALLED, 'A new version has been installed.');

  // It is a statement, not an instruction: unlike the dependency reason there
  // is nothing left for the user to do first, so it must not carry a footnote
  // or send anyone to a folder.
  assert.equal(reasonNote('a new version is installed'), null);

  // Copy rule (PROJECT-SCOPE 2026-07-25) — and the raw reason must not be it:
  // no flags, no tooling names, no paths, no `current`-shaped code words, and
  // nothing that reads like the server's own diagnostic string.
  assert.notEqual(REASON_INSTALLED, 'a new version is installed');
  assert.ok(!/--\w/.test(REASON_INSTALLED));
  assert.ok(!/\bnpm\b|\bnode_modules\b|\bvite\b|\bbundle\b|\bsymlink\b/i.test(REASON_INSTALLED));
  assert.ok(!REASON_INSTALLED.includes('/'), 'no path in the sentence');
  assert.ok(!/[0-9a-f]{7}/.test(REASON_INSTALLED), 'no commit hash in the sentence');
  // A real sentence, which is what separates it from the server's reason.
  assert.match(REASON_INSTALLED, /^[A-Z].*\.$/);

  // It must not collide with the developer reasons: an installed backend and a
  // clone are telling the user two different stories.
  assert.notEqual(REASON_INSTALLED, REASON_GENERIC);
  assert.notEqual(REASON_INSTALLED, REASON_DEPS);
  // And an unknown reason still falls back rather than leaking through.
  assert.equal(reasonSentence('a new version is installed somewhere'), REASON_GENERIC);
});

test('only the dependency reason carries a confirmation footnote', () => {
  // The footnote exists to stop a user pressing Restart into a guaranteed
  // refusal. Every other reason restarts fine and must not be decorated.
  assert.equal(reasonNote('dependencies changed'), DEPS_NOTE);
  assert.equal(
    DEPS_NOTE,
    'Dependencies changed. Until they are installed in the project folder, the app will refuse to restart.',
  );
  for (const r of [
    null,
    undefined,
    '',
    'frontend rebuilt',
    'frontend build missing',
    'frontend source changed',
    'server files edited',
    'server code changed (6113709 → a1b2c3d)',
    'dependencies changed a bit',
  ]) {
    assert.equal(reasonNote(r), null, String(r));
  }
});

test('the restart dialog may be hidden during the PREFLIGHT and never during the handover', () => {
  // While the POST is out the backend is only checking and building: every
  // session is alive and reachable, so a modal that cannot be dismissed locks a
  // working app for up to two minutes. Hiding stops nothing — the flow runs on.
  assert.equal(canHideRestartDialog('restarting'), true);
  // Once the 202 has landed the old process is gone with its sessions, and the
  // page is committed to reloading or to saying it cannot. There is nothing
  // behind the dialog left to go back to, so it stays.
  assert.equal(canHideRestartDialog('reconnecting'), false);
});
