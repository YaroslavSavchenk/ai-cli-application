/**
 * The in-app update, phase E (`web/src/ui/update-flow.ts` and the notice
 * rules for it in `web/src/ui/update-model.ts`): which verb the notice
 * offers for which reason, which of a stranger's strings may be printed, what
 * the pill says while it runs, and how a state from `GET /api/update/status`
 * becomes a phase, an outcome, or a refusal. Split out of
 * `ui-update-model.test.ts`.
 *
 * Seam: the flow takes its HTTP, clock and sleep through parameters; a driven
 * install (one POST answer, a queue of status answers) runs it with no
 * browser, no timers and no backend.
 *
 * NOT claimed: the real download, checksum and installer run
 * (`tests/server/` update tests, the user's Windows check).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PILL_LABEL_RESTARTING,
  PILL_LABEL_UPDATING,
  REASON_AVAILABLE,
  REASON_GENERIC,
  REASON_INSTALLED,
  UpdateNotice,
  noticeVerb,
  reasonSentence,
  releaseSentence,
  showableVersion,
  updateLead,
} from '../../web/src/ui/update-model.ts';
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
} from '../../web/src/ui/update-flow.ts';
import {
  UPDATE_ERROR_CHECKSUM,
  UPDATE_ERROR_FINISH,
  UPDATE_NEW_VERSION_AVAILABLE,
  type UpdateInstallStatus,
  type UpdateRelease,
} from '../../shared/protocol.ts';

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
