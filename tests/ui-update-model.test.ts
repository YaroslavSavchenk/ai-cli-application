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
  PILL_LABEL_UPDATING,
  REASON_AVAILABLE,
  REASON_DEPS,
  REASON_GENERIC,
  REASON_INSTALLED,
  UpdateNotice,
  confirmBody,
  fmtRunningFor,
  moreLabel,
  noticeVerb,
  reasonNote,
  reasonSentence,
  releaseSentence,
  showableVersion,
  summarizeRunning,
  updateLead,
  versionFact,
} from '../web/src/ui/update-model.ts';
import {
  IDLE_GRACE,
  MSG_UPDATE_LOST,
  MSG_UPDATE_REFUSED,
  MSG_UPDATE_UNREACHABLE,
  PHASE_DOWNLOADING,
  PHASE_INSTALLING,
  PHASE_VERIFYING,
  STATUS_MISS_MAX,
  STATUS_POLL_MS,
  UPDATE_TIMEOUT_MS,
  canHideFlow,
  clampPercent,
  followUpdate,
  isBusyStatus,
  isUpdatePhase,
  parseInstallStatus,
  percentText,
  phaseOf,
  phaseText,
  runUpdate,
  type UpdateDeps,
  type UpdateHttpResult,
  type UpdatePhase,
} from '../web/src/ui/update-flow.ts';
import {
  UPDATE_ERROR_CHECKSUM,
  UPDATE_ERROR_FINISH,
  UPDATE_NEW_VERSION_AVAILABLE,
  type UpdateInstallStatus,
  type UpdateRelease,
} from '../shared/protocol.ts';
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

// ---------------------------------------------------------------------------
// PHASE E — the in-app update: one toast, one button, one flow
// ---------------------------------------------------------------------------
//
// The user asked for what other apps do: a notification and ONE button
// (memory/decisions/in-app-update.md). What that costs in rules is everything
// below — which verb the notice offers for which reason, which of a stranger's
// strings may be printed, what the pill says while it runs, and how a state
// from `GET /api/update/status` becomes a phase, an outcome, or a refusal.

function mkRelease(over: Partial<UpdateRelease> = {}): UpdateRelease {
  return {
    version: over.version ?? 'v0.3.0',
    setupName: over.setupName ?? 'AI-Session-Manager-Setup-v0.3.0.exe',
    setupUrl:
      over.setupUrl ??
      'https://github.com/YaroslavSavchenk/ai-cli-application/releases/download/v0.3.0/AI-Session-Manager-Setup-v0.3.0.exe',
    sumsUrl:
      over.sumsUrl ??
      'https://github.com/YaroslavSavchenk/ai-cli-application/releases/download/v0.3.0/SHA256SUMS.txt',
    size: over.size ?? 78_123_456,
  };
}

function mkStatus(over: Partial<UpdateInstallStatus> = {}): UpdateInstallStatus {
  return {
    state: over.state ?? 'downloading',
    version: over.version === undefined ? 'v0.3.0' : over.version,
    percent: over.percent ?? 0,
    error: over.error === undefined ? null : over.error,
  };
}

const ok = (body: unknown): UpdateHttpResult => ({ status: 200, body });

/**
 * A driven install: one POST answer, then a queue of status answers (the last
 * one repeats). No clock, no timers — `sleep` is what advances time, so a
 * timeout is reached by polling, exactly as it is in a browser.
 */
function drive(
  post: UpdateHttpResult | 'throw',
  statuses: UpdateHttpResult[],
): { deps: UpdateDeps; phases: [UpdatePhase, number][]; polls: () => number } {
  const phases: [UpdatePhase, number][] = [];
  let clock = 0;
  let i = 0;
  return {
    phases,
    polls: () => i,
    deps: {
      postUpdate: async () => {
        if (post === 'throw') throw new Error('network');
        return post;
      },
      status: async () => {
        const r = statuses[Math.min(i, statuses.length - 1)] as UpdateHttpResult;
        i += 1;
        return r;
      },
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
      onPhase: (p, percent) => {
        phases.push([p, percent]);
      },
    },
  };
}

// ---- the notice: which verb, which words ----------------------------------

test('the ONLINE reason is a reason like any other — and the only one whose verb is Update', () => {
  const n = new UpdateNotice();
  assert.equal(n.apply({ available: true, reason: UPDATE_NEW_VERSION_AVAILABLE }), 'toast');
  assert.equal(n.reason, UPDATE_NEW_VERSION_AVAILABLE);
  // Precedence between "installed" and "available" is the backend's job; the UI
  // renders whichever one arrives, with the verb that fits it.
  assert.equal(noticeVerb(UPDATE_NEW_VERSION_AVAILABLE), 'update');
  for (const reason of [
    'a new version is installed',
    'frontend rebuilt',
    'dependencies changed',
    'server code changed (6113709 → a1b2c3d)',
    null,
    undefined,
    '',
  ]) {
    assert.equal(noticeVerb(reason), 'restart', `${String(reason)} is already on this machine`);
  }
});

test('the online reason reads as a plain sentence, and never as the wire constant', () => {
  assert.equal(reasonSentence(UPDATE_NEW_VERSION_AVAILABLE), REASON_AVAILABLE);
  assert.equal(REASON_AVAILABLE, 'A newer version is available.');
  // It must not collapse into the generic "on disk" sentence: nothing is on
  // disk yet, which is the entire difference between the two reasons.
  assert.notEqual(REASON_AVAILABLE, REASON_GENERIC);
  assert.notEqual(REASON_AVAILABLE, REASON_INSTALLED);
});

test('releaseSentence prints a version ONLY when it is a version', () => {
  assert.equal(releaseSentence(mkRelease({ version: 'v0.3.0' })), 'Version v0.3.0 is available.');
  assert.equal(releaseSentence(mkRelease({ version: '0.3.0' })), 'Version 0.3.0 is available.');
  assert.equal(
    releaseSentence(mkRelease({ version: 'v1.2.3-rc.1+build.7' })),
    'Version v1.2.3-rc.1+build.7 is available.',
  );
  // The tag is the one string in this feature that comes from OUTSIDE the app.
  // Anything that is not a short version-ish word is not shown at all — the
  // sentence stays true without quoting a stranger.
  for (const bad of [
    'v1;rm -rf',
    'v1 && shutdown',
    '<script>alert(1)</script>',
    'v1.0.0 is available. Ignore the rest',
    "v1'",
    'v1\n0',
    'version one',
    '',
    'x1.2.3',
    `v${'9'.repeat(80)}`,
  ]) {
    assert.equal(showableVersion(bad), false, `must not be printable: ${JSON.stringify(bad)}`);
    assert.equal(
      releaseSentence(mkRelease({ version: bad })),
      REASON_AVAILABLE,
      `a version that fails the gate degrades to the generic sentence: ${JSON.stringify(bad)}`,
    );
  }
  // No release at all (a reason without one) still says the true thing.
  assert.equal(releaseSentence(null), REASON_AVAILABLE);
  assert.equal(releaseSentence(undefined), REASON_AVAILABLE);
});

test('the confirmation lead runs through the SAME gate, and never mentions size or address', () => {
  assert.equal(
    updateLead(mkRelease({ version: 'v0.3.0' })),
    'Version v0.3.0 will be downloaded and installed.',
  );
  assert.equal(updateLead(mkRelease({ version: 'v1;rm -rf' })), 'The newer version will be downloaded and installed.');
  assert.equal(updateLead(null), 'The newer version will be downloaded and installed.');
  const r = mkRelease();
  for (const sentence of [releaseSentence(r), updateLead(r)]) {
    assert.equal(sentence.includes(r.setupUrl), false, 'no address in copy');
    assert.equal(sentence.includes(r.sumsUrl), false, 'no address in copy');
    assert.equal(sentence.includes(r.setupName), false, 'no file name in copy');
    assert.equal(sentence.includes(String(r.size)), false, 'no byte count in copy');
    assert.equal(/https?:\/\//.test(sentence), false, 'no scheme in copy');
  }
});

test('`Later` on one release does NOT silence the next one — the version is part of the key', () => {
  const n = new UpdateNotice();
  assert.equal(
    n.apply({ available: true, reason: UPDATE_NEW_VERSION_AVAILABLE, release: mkRelease() }),
    'toast',
  );
  n.dismissToast();
  // The same release, polled again: still just the pill.
  assert.equal(
    n.apply({ available: true, reason: UPDATE_NEW_VERSION_AVAILABLE, release: mkRelease() }),
    'pill',
  );
  // A NEWER release is new news, even though the reason sentence is identical.
  assert.equal(
    n.apply({
      available: true,
      reason: UPDATE_NEW_VERSION_AVAILABLE,
      release: mkRelease({ version: 'v0.4.0' }),
    }),
    'toast',
  );
  n.dismissToast();
  assert.equal(
    n.apply({
      available: true,
      reason: UPDATE_NEW_VERSION_AVAILABLE,
      release: mkRelease({ version: 'v0.4.0' }),
    }),
    'pill',
  );
  // And an aborted update on the dismissed release comes back as the pill,
  // not as a toast.
  n.startUpdate();
  assert.equal(n.updateAborted(), 'pill');
});

// ---- the pill while the update runs ---------------------------------------

test('while UPDATING the pill has its own word, and a click can only bring the dialog back', () => {
  const n = new UpdateNotice();
  n.apply({ available: true, reason: UPDATE_NEW_VERSION_AVAILABLE, release: mkRelease() });
  assert.equal(n.startUpdate(), 'updating');
  assert.equal(n.toastVisible, false, 'the toast steps aside for the dialog');
  assert.equal(n.pillVisible, true, 'the pill is the only thing left saying so');
  assert.equal(n.pillLabel, PILL_LABEL_UPDATING);
  assert.equal(PILL_LABEL_UPDATING, 'Updating');
  assert.notEqual(PILL_LABEL_UPDATING, PILL_LABEL_RESTARTING, 'the two halves are not the same news');
  assert.equal(n.pillAction, 'reveal');
  // A poll landing mid-install must not repaint a toast over the progress.
  assert.equal(n.apply({ available: true, reason: 'frontend rebuilt' }), 'updating');
  assert.equal(n.state, 'updating');
});

test('an update that did not happen puts the pending notice back, exactly like an aborted restart', () => {
  const fresh = new UpdateNotice();
  fresh.apply({ available: true, reason: UPDATE_NEW_VERSION_AVAILABLE, release: mkRelease() });
  fresh.startUpdate();
  assert.equal(fresh.updateAborted(), 'toast', 'a never-dismissed reason still toasts');

  const dismissed = new UpdateNotice();
  dismissed.apply({ available: true, reason: UPDATE_NEW_VERSION_AVAILABLE });
  dismissed.dismissToast();
  dismissed.startUpdate();
  assert.equal(dismissed.updateAborted(), 'pill', 'a dismissed reason does not re-toast after a refusal');

  // Each abort may only leave its OWN half: the update half cannot un-do a
  // restart that is already running, and vice versa.
  const running = new UpdateNotice();
  running.apply({ available: true, reason: UPDATE_NEW_VERSION_AVAILABLE });
  running.startRestart();
  assert.equal(running.updateAborted(), 'restarting');
  running.startUpdate();
  assert.equal(running.restartAborted(), 'updating');
});

test('the update half hands over to the restart half without passing through a surface', () => {
  const n = new UpdateNotice();
  n.apply({ available: true, reason: UPDATE_NEW_VERSION_AVAILABLE });
  n.startUpdate();
  assert.equal(n.startRestart(), 'restarting', 'installed -> restarting, with nothing shown in between');
  assert.equal(n.pillLabel, PILL_LABEL_RESTARTING);
  assert.equal(n.finishRestart(), 'done');
  assert.equal(n.pillVisible, false);
});

// ---- the phase machine ----------------------------------------------------

test('the state table: every install state maps to exactly one phase, or to none', () => {
  assert.deepEqual(
    (['idle', 'downloading', 'verifying', 'installing', 'installed', 'failed'] as const).map(phaseOf),
    [null, 'downloading', 'verifying', 'installing', null, null],
  );
  assert.deepEqual(
    (['downloading', 'verifying', 'installing'] as const).map(phaseText),
    [PHASE_DOWNLOADING, PHASE_VERIFYING, PHASE_INSTALLING],
  );
  assert.deepEqual(
    [PHASE_DOWNLOADING, PHASE_VERIFYING, PHASE_INSTALLING],
    ['Downloading…', 'Verifying…', 'Installing…'],
  );
  for (const p of ['downloading', 'verifying', 'installing'] as const) assert.equal(isUpdatePhase(p), true);
  for (const p of ['restarting', 'reconnecting'] as const) assert.equal(isUpdatePhase(p), false);
  assert.equal(isBusyStatus(mkStatus({ state: 'installing' })), true);
  assert.equal(isBusyStatus(mkStatus({ state: 'installed' })), false);
  assert.equal(isBusyStatus(null), false);
});

test('the dialog may be hidden for the WHOLE install, and never during the handover', () => {
  // Nothing is torn down while the app downloads, verifies and installs: every
  // session is alive behind the dialog, so locking the window would be a cost
  // with no purpose. The restart half keeps its own rule.
  for (const p of ['downloading', 'verifying', 'installing', 'restarting'] as const) {
    assert.equal(canHideFlow(p), true, `${p} must be hidable`);
  }
  assert.equal(canHideFlow('reconnecting'), false, 'the old process is gone: there is nothing to go back to');
});

test('percent is a readout, not a promise: it is clamped, rounded, and only shown as a whole number', () => {
  assert.equal(clampPercent(42), 42);
  assert.equal(clampPercent(41.6), 42);
  assert.equal(clampPercent(-1), 0);
  assert.equal(clampPercent(1e9), 100);
  assert.equal(clampPercent(Number.NaN), 0);
  assert.equal(clampPercent('42'), 0);
  assert.equal(clampPercent(null), 0);
  assert.equal(percentText(42), '42%');
  assert.equal(percentText(-3), '0%');
});

test('parseInstallStatus accepts exactly the contract and rejects everything else', () => {
  assert.deepEqual(parseInstallStatus({ state: 'downloading', version: 'v0.3.0', percent: 42, error: null }), {
    state: 'downloading',
    version: 'v0.3.0',
    percent: 42,
    error: null,
  });
  assert.deepEqual(parseInstallStatus({ state: 'idle', version: null, percent: 0, error: null })?.version, null);
  for (const bad of [
    null,
    'idle',
    42,
    {},
    { state: 'running', version: null, percent: 0, error: null },
    { state: 'downloading', version: 7, percent: 0, error: null },
    { state: 'failed', version: null, percent: 0, error: 7 },
  ]) {
    assert.equal(parseInstallStatus(bad), null, `must not parse: ${JSON.stringify(bad)}`);
  }
  // A percent the server got wrong is repaired, not rejected: the STATE is the
  // load-bearing field.
  assert.equal(parseInstallStatus({ state: 'downloading', version: null, percent: 999, error: null })?.percent, 100);
});

// ---- the flow ------------------------------------------------------------

test('the happy path: 202, then the three phases, then the new version is on disk', async () => {
  const d = drive(
    { status: 202, body: { version: 'v0.3.0' } },
    [
      ok(mkStatus({ state: 'downloading', percent: 12 })),
      ok(mkStatus({ state: 'downloading', percent: 87 })),
      ok(mkStatus({ state: 'verifying', percent: 100 })),
      ok(mkStatus({ state: 'installing', percent: 100 })),
      ok(mkStatus({ state: 'installed', percent: 100 })),
    ],
  );
  const outcome = await runUpdate(d.deps);
  assert.deepEqual(outcome, { kind: 'installed', version: 'v0.3.0' });
  assert.deepEqual(d.phases, [
    ['downloading', 0], // painted before the POST: the dialog is never blank
    ['downloading', 12],
    ['downloading', 87],
    ['verifying', 100],
    ['installing', 100],
  ]);
});

test('409 is not a refusal: an install is already running and the flow watches THAT one', async () => {
  // A double press, or a second window. The honest answer to "update" while an
  // update runs is to show it.
  const d = drive({ status: 409, body: { error: 'an update is already running' } }, [
    ok(mkStatus({ state: 'installing', percent: 100 })),
    ok(mkStatus({ state: 'installed', percent: 100 })),
  ]);
  assert.deepEqual(await runUpdate(d.deps), { kind: 'installed', version: 'v0.3.0' });
  assert.deepEqual(d.phases.at(-1), ['installing', 100]);
});

test('422 is a refusal in the server’s own words; 503 is NOT — and nothing was touched', async () => {
  // 422 carries a plain sentence written for this dialog.
  const d = drive({ status: 422, body: { error: 'There is nothing to install.' } }, [
    ok(mkStatus({ state: 'idle' })),
  ]);
  assert.deepEqual(await runUpdate(d.deps), { kind: 'refused', message: 'There is nothing to install.' });
  assert.equal(d.polls(), 0, 'a refused POST is never followed by a status watch');

  // 503's body is the technical line meant for a log ('updates are not
  // available in this process') — the UI speaks plain language, so it says its
  // own sentence instead.
  const wired = drive(
    { status: 503, body: { error: 'updates are not available in this process' } },
    [ok(mkStatus({ state: 'idle' }))],
  );
  assert.deepEqual(await runUpdate(wired.deps), { kind: 'refused', message: MSG_UPDATE_REFUSED });
  assert.equal(wired.polls(), 0);

  // A body without a sentence still says the one thing true of every refusal.
  const bare = drive({ status: 422, body: null }, []);
  assert.deepEqual(await runUpdate(bare.deps), { kind: 'refused', message: MSG_UPDATE_REFUSED });
  assert.equal(MSG_UPDATE_REFUSED, 'The update did not start, so nothing changed.');
  // And so does any other broken answer.
  const broken = drive({ status: 500, body: { error: 'boom' } }, []);
  assert.deepEqual(await runUpdate(broken.deps), { kind: 'refused', message: MSG_UPDATE_REFUSED });
});

test('a POST that never arrived is a refusal too, with the sentence for it', async () => {
  const thrown = drive('throw', []);
  assert.deepEqual(await runUpdate(thrown.deps), { kind: 'refused', message: MSG_UPDATE_UNREACHABLE });
  const offline = drive({ status: 0, body: null }, []);
  assert.deepEqual(await runUpdate(offline.deps), { kind: 'refused', message: MSG_UPDATE_UNREACHABLE });
  assert.equal(MSG_UPDATE_UNREACHABLE, 'The update could not be started. Nothing has changed.');
});

test('a failed install shows the backend’s CONSTANT sentence, never remote text', async () => {
  const d = drive({ status: 202, body: { version: 'v0.3.0' } }, [
    ok(mkStatus({ state: 'downloading', percent: 3 })),
    ok(mkStatus({ state: 'failed', percent: 3, error: UPDATE_ERROR_CHECKSUM })),
  ]);
  assert.deepEqual(await runUpdate(d.deps), { kind: 'refused', message: UPDATE_ERROR_CHECKSUM });
  // …and a failure with no sentence still gets one.
  const mute = drive({ status: 202, body: {} }, [ok(mkStatus({ state: 'failed', error: null }))]);
  assert.deepEqual(await runUpdate(mute.deps), { kind: 'refused', message: MSG_UPDATE_LOST });
  assert.equal(MSG_UPDATE_LOST, UPDATE_ERROR_FINISH);
});

test('an install that never starts, and one that vanishes, both end as refusals', async () => {
  // `idle` right after the 202 is the beat before the runner flips its state —
  // tolerated. `idle` forever is a runner that never ran.
  const never = drive({ status: 202, body: {} }, [ok(mkStatus({ state: 'idle', version: null }))]);
  assert.deepEqual(await runUpdate(never.deps), { kind: 'refused', message: MSG_UPDATE_LOST });
  assert.equal(never.polls(), IDLE_GRACE, 'the grace is spent, and not one poll more');

  // `idle` AFTER a busy state is an install that went away without saying how
  // it ended: no grace, because the answer already changed once.
  const vanished = drive({ status: 202, body: {} }, [
    ok(mkStatus({ state: 'downloading', percent: 50 })),
    ok(mkStatus({ state: 'idle', version: null })),
  ]);
  assert.deepEqual(await runUpdate(vanished.deps), { kind: 'refused', message: MSG_UPDATE_LOST });
});

test('unreadable answers are tolerated in ones and twos, and given up on in tens', async () => {
  const blip = drive({ status: 202, body: {} }, [
    ok(mkStatus({ state: 'downloading', percent: 1 })),
    { status: 0, body: null },
    { status: 500, body: null },
    ok({ nonsense: true }),
    ok(mkStatus({ state: 'installed', percent: 100 })),
  ]);
  assert.deepEqual(await blip.deps.postUpdate(), { status: 202, body: {} });
  assert.deepEqual(await runUpdate(blip.deps), { kind: 'installed', version: 'v0.3.0' });

  const gone = drive({ status: 202, body: {} }, [{ status: 0, body: null }]);
  assert.deepEqual(await runUpdate(gone.deps), { kind: 'refused', message: MSG_UPDATE_LOST });
  assert.equal(gone.polls(), STATUS_MISS_MAX, 'it stops at the tenth miss, not the hundredth');
});

test('a watch nobody will ever be told about ends: the budget is finite', async () => {
  const stuck = drive({ status: 202, body: {} }, [ok(mkStatus({ state: 'downloading', percent: 7 }))]);
  assert.deepEqual(await runUpdate(stuck.deps), { kind: 'refused', message: MSG_UPDATE_LOST });
  // Polls are one second apart, so the budget is spent in seconds, not answers.
  assert.equal(stuck.polls(), UPDATE_TIMEOUT_MS / STATUS_POLL_MS + 1);
});

test('a page that reloads mid-install ADOPTS it: no POST, straight into the progress', async () => {
  // The backend kept working while the page went away; asking the question
  // again would be asking about something that is already happening.
  const d = drive({ status: 202, body: {} }, [
    ok(mkStatus({ state: 'installing', percent: 100 })),
    ok(mkStatus({ state: 'installed', percent: 100 })),
  ]);
  assert.deepEqual(await followUpdate(d.deps), { kind: 'installed', version: 'v0.3.0' });
  assert.deepEqual(d.phases, [['installing', 100]], 'it starts on the phase it found, not on "downloading"');
});
