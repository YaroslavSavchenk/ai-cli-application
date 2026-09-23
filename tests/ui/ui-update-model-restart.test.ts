/**
 * The backend restart handshake (`web/src/ui/restart-flow.ts`): how a
 * 202/409/422/500/timeout answer from `POST /api/restart` maps onto the next
 * state, and the preflight refusal (422) sentences from
 * `web/src/ui/update-model.ts`. Split out of `ui-update-model.test.ts`.
 *
 * Seam: the flow takes its clock, its sleep and its HTTP through parameters,
 * so a fake clock that only moves when the flow sleeps drives the whole
 * handshake — the 20 s budget in microseconds, the probe count exact — with no
 * browser, no timers and no backend.
 *
 * Why it matters: a refused restart must not tell the user to relaunch (the
 * old backend is untouched), and a failed one must never leave the page
 * waiting forever.
 *
 * NOT claimed: a real backend restart or the page reload in a browser
 * (`.claude/skills/verify-terminal/SKILL.md`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPS_NOTE,
  REASON_DEPS,
  REASON_GENERIC,
  REASON_INSTALLED,
  UpdateNotice,
  reasonNote,
  reasonSentence,
} from '../../web/src/ui/update-model.ts';
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
} from '../../web/src/ui/restart-flow.ts';

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
  if (out.kind === 'reload') {
    assert.equal(out.afterMs, 3 * HEALTH_POLL_MS);
    // The NEW run's stamp rides along (Nocturne B6, D3): the caller writes it
    // into the stored arrangement, so the reload reads that bag as its own run
    // and keeps the tabs with `Reopen tabs on start` off.
    assert.equal(out.startedAt, 'x');
  }
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
  // Nothing to stamp the arrangement with: an unreadable body names no run.
  if (out.kind === 'reload') assert.equal(out.startedAt, null);
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
