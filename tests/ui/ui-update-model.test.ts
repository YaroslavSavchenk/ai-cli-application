/**
 * The DOM-free half of the update notice (`web/src/ui/update-model.ts`):
 * the UpdateNotice state machine, the restart confirmation body and the
 * version fact. The restart handshake is in `ui-update-model-restart.test.ts`,
 * the in-app update (phase E) in `ui-update-model-install.test.ts`.
 *
 * WHY THIS MODULE EXISTS SEPARATELY FROM `ui/update.ts`: everything that
 * can be got wrong here is a RULE, not a pixel — which surface is shown after
 * which answer and what the confirmation promises for 0 / 1 / N sessions.
 * Seam: the pure module, imported and called — `node --test` drives it with
 * no browser, no timers and no backend.
 *
 * The user's requirement this file is really pinning (2026-09-06): "de popup
 * kun je wegklikken maar die blijft ergens hangen" — dismissing the toast must
 * NOT dismiss the notice, and a poll that keeps repeating the same reason must
 * never bring the toast back.
 *
 * NOT claimed: how the toast and pill render in a browser
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONFIRM_LIST_MAX,
  CONTINUE_NOTE,
  EMPTY,
  PILL_LABEL,
  PILL_LABEL_RESTARTING,
  REASON_GENERIC,
  UpdateNotice,
  confirmBody,
  fmtRunningFor,
  moreLabel,
  reasonSentence,
  summarizeRunning,
  versionFact,
} from '../../web/src/ui/update-model.ts';
import { START_FROM, hasContinueFlag } from '../../web/src/ui/launch-args.ts';
import type { SessionInfo } from '../../shared/protocol.ts';

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
  // guard is tests/ui/ui-copy-rule.test.ts; this is the local canary).
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

test('the continue footnote names the launch dialog choice by its CURRENT words (Nocturne A4)', () => {
  // The footnote quotes a label the user saw when starting the session; since
  // A4 that is the Start from option, not the removed checkbox. Read from the
  // one table, so a relabel there cannot leave this sentence quoting a ghost.
  const label = START_FROM.find((s) => s.value === 'continue')?.label ?? '';
  assert.ok(label.length > 0, 'the continue option must exist');
  assert.ok(CONTINUE_NOTE.includes(`"${label}"`), CONTINUE_NOTE);
  assert.equal(CONTINUE_NOTE.includes('Continue last conversation'), false, 'the checkbox is gone');
});
