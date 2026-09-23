/**
 * Manual restart, preflight step 2 — the frontend build + swap
 * (server/webbuild.ts) on a real filesystem: the build is STAGED in dist-next,
 * then swapped in; revertFrontend puts the old build back after a post-swap
 * refusal (also with no previous dist); a legacy dist without build-id.json
 * still swaps; the duration is on a monotonic clock; swapFrontend refuses to
 * rename a directory that is not a frontend build; a failed build or one with
 * no build-id.json never reaches the served web/dist.
 *
 * How: vite itself is stubbed (`fakeVite`, `buildFixture` in
 * `tests/helpers/restart-fixture.ts`); what is exercised is the part that can
 * destroy a working app: the verification and the two renames, in temp dirs.
 * Build and swap are SEPARATE calls — the restart only swaps once the
 * replacement backend has reported ready — so the tests call them in that
 * order, with the sabotage in between.
 *
 * NOT claimed here: the build's failure modes (missing vite, a hang, a
 * failing rename, a leftover dist-next, a spawn error) —
 * `tests/server/restart-webbuild-failures.test.ts`; a real vite run —
 * `tests/server/restart-real.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  RestartController,
  RestartRefusal,
  REFUSED_BUILD,
  REFUSED_STANDBY,
} from '../../server/restart.ts';
import {
  buildFrontend,
  commitFrontend,
  discardFrontend,
  revertFrontend,
  swapFrontend,
} from '../../server/webbuild.ts';
import { readSource } from '../helpers/helpers.ts';
import {
  FAKE_BUILD,
  OLD_PID,
  OLD_PORT,
  fakeVite,
  writeBuild,
  buildFixture,
} from '../helpers/restart-fixture.ts';

// ---------------------------------------------------------------------------
// 1c. The frontend build + swap (server/webbuild.ts) on a real filesystem
// ---------------------------------------------------------------------------
//
// vite itself is stubbed (the REAL restart test in restart-real.test.ts runs the real
// one); what is exercised here is the part that can destroy a working app: the
// verification and the two renames. Build and swap are SEPARATE calls — the
// restart only swaps once the replacement backend has reported ready — so the
// tests below call them in that order, with the sabotage in between.

test('web build: the DURATION is measured on a monotonic clock, never the wall clock', () => {
  // A SOURCE PIN, and it says why it is one: the thing it defends is a wall
  // clock that jumps BACKWARD. This host is WSL2, whose clock is resynced
  // against the Windows host and was measured moving ~1.9 s back inside a ten
  // second window (2026-09-16) — a real `-1795ms` was logged for a build. No
  // test can cause that jump: the process cannot move the system clock, and the
  // one seam that could fake it (WebBuildOptions.now) is the branch that is NOT
  // the default, so exercising it would prove nothing about the default. What
  // is checkable is that the default branch reads a clock that cannot go
  // backwards, and that nothing later re-reads the wall clock for the same
  // number.
  const src = readSource('server', 'webbuild.ts');
  const fn = /function elapsedMs\([\s\S]*?\n\}/.exec(src);
  assert.ok(fn !== null, 'server/webbuild.ts still measures the duration through elapsedMs()');
  const body = fn[0];
  assert.match(body, /process\.hrtime\.bigint\(\)/, 'the default branch is the monotonic clock');
  assert.equal(
    /Date\.now\(\)/.test(body),
    false,
    'and the wall clock appears nowhere in the duration path',
  );
  // The seam survives for a test that wants a fake clock, and only there.
  assert.match(body, /if \(now !== undefined\)/, 'opts.now is still honoured when it is given');
  // The duration the log line prints comes from that stopwatch and nothing else.
  assert.match(src, /const elapsed = elapsedMs\(opts\.now\);/, 'one stopwatch, started once');
  assert.match(src, /const ms = elapsed\(\);/, 'and read once, through it');
});

test('web build: a good build is STAGED, then swapped in, and dist-next is gone afterwards', async () => {
  const fx = buildFixture();
  const nextDir = join(fx.root, 'web', 'dist-next');
  try {
    const opts = {
      repoRoot: fx.root,
      webDistDir: fx.dist,
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
        fx.lines.push(`[${level}] ${message}`),
      spawnFn: fakeVite({
        code: 0,
        stdout: 'transforming...\n✓ built in 184ms\n',
        write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
      }),
    };
    const result = await buildFrontend(opts);

    // BEFORE the swap: the user is still on the old screens. This is the whole
    // reason the two halves are separate — the standby is proven in between.
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'the served build is untouched until the swap',
    );
    assert.ok(existsSync(join(nextDir, 'build-id.json')), 'and the new one is staged beside it');

    swapFrontend(opts);

    assert.deepEqual(
      { buildId: result.buildId, asset: result.asset },
      { buildId: '20260908-1200-newnew1', asset: 'assets/index-NEWNEW00.js' },
    );
    assert.ok(result.ms >= 0);
    assert.equal(readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(), '{"id":"20260908-1200-newnew1"}');
    assert.ok(existsSync(join(fx.dist, 'assets', 'index-NEWNEW00.js')), 'the new bundle is being served');
    assert.ok(!existsSync(join(fx.dist, 'assets', 'index-OLDOLD00.js')), 'and the old one is gone');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')), 'no scratch dir left behind');
    // The backup OUTLIVES the swap on purpose: the standby can still be found
    // dead before the teardown, and that answers 422 — which promises web/dist
    // is unchanged. Only `commitFrontend` (called once `go` is out) drops it.
    assert.ok(existsSync(join(fx.root, 'web', 'dist-prev')), 'the old build is kept as a backup');
    commitFrontend(opts);
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-prev')), 'and the commit is what removes it');
    assert.ok(
      fx.lines.some((l) => l.startsWith('[debug]') && l.includes('vite output') && l.includes('built in 184ms')),
      `the bounded vite tail is logged at debug: ${fx.lines.join(' | ')}`,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: revertFrontend puts the OLD build back, so a post-swap refusal changes nothing', () => {
  // The window the swap opens: the standby can still be found dead between the
  // swap and the teardown, and that is a 422 — which the contract says leaves
  // web/dist UNCHANGED. The backup kept by the swap is what makes that true.
  const fx = buildFixture();
  const opts = {
    webDistDir: fx.dist,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      fx.lines.push(`[${level}] ${message}`),
  };
  try {
    writeBuild(join(fx.root, 'web', 'dist-next'), '20260908-1200-newnew1');
    const swapped = swapFrontend(opts);
    assert.equal(swapped.hadPrevious, true, 'a build WAS moved aside');
    assert.equal(readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(), '{"id":"20260908-1200-newnew1"}');

    revertFrontend({ ...opts, hadPrevious: swapped.hadPrevious });

    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'the served build is byte-for-byte the one that was there before the swap',
    );
    assert.ok(existsSync(join(fx.dist, 'assets', 'index-OLDOLD00.js')), 'old bundle back');
    assert.ok(!existsSync(join(fx.dist, 'assets', 'index-NEWNEW00.js')), 'new bundle gone');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')), 'and no staging dir is left');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-prev')), 'and no backup either');
    assert.ok(
      fx.lines.some((l) => l.startsWith('[info]') && l.includes('the refused restart changed nothing')),
      `the restore is one line in the log: ${fx.lines.join(' | ')}`,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: with NO previous dist, a post-swap refusal leaves the served path ABSENT again', async () => {
  // The other half of "every 422 leaves web/dist unchanged": when there was no
  // web/dist at all (the `frontend build missing` reason — exactly the state
  // that lights the pill), the swap moves nothing aside, so undoing it means
  // REMOVING the new build. Leaving it would serve screens built for the
  // replacement from the backend that refused to be replaced.
  const fx = buildFixture();
  rmSync(fx.dist, { recursive: true, force: true }); // No frontend at all.
  const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string): number =>
    fx.lines.push(`[${level}] ${message}`);
  const events: string[] = [];
  try {
    const controller = new RestartController({
      log,
      counts: () => ({ sessions: 1, presence: 1, attached: 1 }),
      port: () => OLD_PORT,
      pid: OLD_PID,
      teardown: () => events.push('teardown'),
      dependenciesReady: () => true,
      buildFrontend: async () =>
        buildFrontend({
          repoRoot: fx.root,
          webDistDir: fx.dist,
          log,
          spawnFn: fakeVite({
            code: 0,
            stdout: 'built\n',
            write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
          }),
        }),
      swapFrontend: () => swapFrontend({ webDistDir: fx.dist, log }),
      revertFrontend: (swap) => revertFrontend({ webDistDir: fx.dist, log, ...swap }),
      commitFrontend: () => commitFrontend({ webDistDir: fx.dist }),
      discardFrontend: () => discardFrontend({ webDistDir: fx.dist }),
      startStandby: () =>
        Promise.resolve({
          pid: 12,
          // Alive through the preflight, dead by the last look before teardown.
          dead: () => existsSync(join(fx.dist, 'index.html')),
          stop: () => events.push('stop'),
          go: () => events.push('go'),
        }),
      readRuntime: () => undefined,
      probeHealth: () => Promise.resolve(false),
      exit: (code) => events.push(`exit${code}`),
    });

    const outcome = await controller.request();

    assert.equal(outcome.status, 422);
    assert.deepEqual(outcome.body, { error: REFUSED_STANDBY });
    assert.deepEqual(events, [], 'nothing was torn down and nothing exited');
    assert.ok(!existsSync(fx.dist), 'the served directory is absent again, exactly as it was');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')), 'no staged build survives');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-prev')), 'and no backup was invented');
    assert.ok(
      fx.lines.some(
        (l) =>
          l.startsWith('[info]') &&
          l.includes('the refused restart changed nothing') &&
          l.includes('there is none now'),
      ),
      `and one line says the served path is empty again: ${fx.lines.join(' | ')}`,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: a LEGACY dist without build-id.json is still a frontend build and swaps fine', () => {
  // The guard decides what may be MOVED ASIDE, and a web/dist built before
  // build-id.json existed is a real frontend build. Requiring the id here would
  // refuse every restart on such a tree forever — with a message about screens
  // that could not be rebuilt, which is not what happened.
  const fx = buildFixture();
  rmSync(join(fx.dist, 'build-id.json'), { force: true });
  const opts = {
    webDistDir: fx.dist,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      fx.lines.push(`[${level}] ${message}`),
  };
  try {
    writeBuild(join(fx.root, 'web', 'dist-next'), '20260908-1200-newnew1');

    const swapped = swapFrontend(opts);

    assert.deepEqual(swapped, { hadPrevious: true });
    assert.equal(readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(), '{"id":"20260908-1200-newnew1"}');
    assert.ok(
      existsSync(join(fx.root, 'web', 'dist-prev', 'assets', 'index-OLDOLD00.js')),
      'the legacy build is the backup, entry bundle and all',
    );
    // …and it comes back byte-for-byte on a refusal, id file or not.
    revertFrontend({ ...opts, ...swapped });
    assert.ok(existsSync(join(fx.dist, 'assets', 'index-OLDOLD00.js')), 'the legacy bundle is served again');
    assert.ok(!existsSync(join(fx.dist, 'build-id.json')), 'and it is still the id-less build it was');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: a newline in the served path can never forge a second log line', async () => {
  // AI_SM_WEB_DIST_DIR is an environment value and a directory name may hold a
  // newline on Linux. Interpolated raw, `<dir>\n2026-… [error] …` would read as
  // an entry this process never wrote.
  const fx = buildFixture();
  const name = 'ev\nil [error] [restart] forged';
  const evil = join(fx.root, 'web', name);
  mkdirSync(evil, { recursive: true }); // Exists, but is NOT a frontend build.
  const lines: string[] = [];
  const opts = {
    repoRoot: fx.root,
    webDistDir: evil,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      lines.push(`[${level}] ${message}`),
    spawnFn: fakeVite({
      code: 0,
      stdout: 'built\n',
      write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
    }),
  };
  try {
    // Logs the staging dir twice: 'building the frontend into …' and 'staged in …'.
    await buildFrontend(opts);
    // …and this logs the served dir in its refusal line.
    assert.throws(
      () => swapFrontend(opts),
      (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_BUILD,
      'no index.html: refused, whatever the directory is called',
    );

    assert.ok(lines.length >= 3, `the paths really were logged: ${lines.length} lines`);
    for (const line of lines) {
      assert.ok(!line.includes('\n'), `one event is one line: ${JSON.stringify(line)}`);
      assert.ok(!line.includes('\r'), `no carriage returns either: ${JSON.stringify(line)}`);
    }
    assert.ok(
      lines.some((l) => l.includes('il [error] [restart] forged')),
      `and the path is still readable, just flattened: ${JSON.stringify(lines)}`,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: swapFrontend REFUSES to rename a directory that is not a frontend build', () => {
  // AI_SM_WEB_DIST_DIR is an env value, and this code renames what it names and
  // later deletes the backup. A value like the user's projects folder must not
  // become `projects-prev` and then vanish.
  const fx = buildFixture();
  const stranger = join(fx.root, 'not-a-build');
  mkdirSync(join(stranger, 'src'), { recursive: true });
  writeFileSync(join(stranger, 'README.md'), '# a real folder of the user\n');
  writeFileSync(join(stranger, 'src', 'main.ts'), 'export const x = 1;\n');
  const opts = {
    webDistDir: stranger,
    log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
      fx.lines.push(`[${level}] ${message}`),
  };
  try {
    writeBuild(join(fx.root, 'not-a-build-next'), '20260908-1200-newnew1');

    assert.throws(
      () => swapFrontend(opts),
      (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_BUILD,
      'a swap onto something that is not a build is a refusal, not a rename',
    );

    assert.equal(readFileSync(join(stranger, 'README.md'), 'utf8'), '# a real folder of the user\n');
    assert.ok(existsSync(join(stranger, 'src', 'main.ts')), 'the directory is untouched, file for file');
    assert.ok(!existsSync(join(fx.root, 'not-a-build-prev')), 'NOTHING was renamed aside');
    assert.ok(!existsSync(join(fx.root, 'not-a-build-next')), 'and the staged build is dropped');
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('is not a frontend build directory')),
      `and the log says exactly why: ${fx.lines.join(' | ')}`,
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('preflight: a standby dying after the REAL swap answers 422 with web/dist byte-identical', async () => {
  // The controller wired to the real filesystem halves, which is the only way
  // to prove the promise the docs make: every 422 leaves the served build
  // exactly as it was, and leaves no staging directory behind.
  const fx = buildFixture();
  try {
    writeBuild(join(fx.root, 'web', 'dist-next'), '20260908-1200-newnew1');
    const log = (level: 'debug' | 'info' | 'warn' | 'error', message: string): number =>
      fx.lines.push(`[${level}] ${message}`);
    const events: string[] = [];
    const controller = new RestartController({
      log,
      counts: () => ({ sessions: 1, presence: 1, attached: 1 }),
      port: () => OLD_PORT,
      pid: OLD_PID,
      teardown: () => events.push('teardown'),
      dependenciesReady: () => true,
      // Already staged above: this test is about what happens AFTER the swap.
      buildFrontend: () => Promise.resolve(FAKE_BUILD),
      swapFrontend: () => swapFrontend({ webDistDir: fx.dist, log }),
      revertFrontend: (swap) => revertFrontend({ webDistDir: fx.dist, log, ...swap }),
      commitFrontend: () => commitFrontend({ webDistDir: fx.dist }),
      discardFrontend: () => discardFrontend({ webDistDir: fx.dist }),
      startStandby: () =>
        Promise.resolve({
          pid: 11,
          // Alive through the preflight, dead by the last look before teardown.
          dead: () => existsSync(join(fx.dist, 'assets', 'index-NEWNEW00.js')),
          stop: () => events.push('stop'),
          go: () => events.push('go'),
        }),
      readRuntime: () => undefined,
      probeHealth: () => Promise.resolve(false),
      exit: (code) => events.push(`exit${code}`),
    });

    const outcome = await controller.request();

    assert.equal(outcome.status, 422);
    assert.deepEqual(outcome.body, { error: REFUSED_STANDBY });
    assert.deepEqual(events, [], 'nothing was torn down, nothing was handed over, nothing exited');
    assert.equal(controller.inProgress, false);
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'the served build is the one that was there before the POST',
    );
    assert.ok(existsSync(join(fx.dist, 'assets', 'index-OLDOLD00.js')), 'down to the entry bundle');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')), 'no staged build survives the refusal');
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-prev')), 'and no backup either');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: a FAILED build refuses and leaves the served web/dist byte-for-byte intact', async () => {
  const fx = buildFixture();
  try {
    await assert.rejects(
      buildFrontend({
        repoRoot: fx.root,
        webDistDir: fx.dist,
        log: (level, message) => fx.lines.push(`[${level}] ${message}`),
        spawnFn: fakeVite({
          code: 1,
          stderr: 'error during build: Could not resolve "./gone.ts"\n',
          write: (outDir) => {
            // A half-written output, exactly what a crashed bundler leaves.
            mkdirSync(outDir, { recursive: true });
            writeFileSync(join(outDir, 'index.html'), '<!doctype html>');
          },
        }),
      }),
      (err: unknown) => {
        assert.ok(err instanceof RestartRefusal);
        assert.equal(err.refusal, REFUSED_BUILD);
        return true;
      },
    );

    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'the old build is untouched: the app the user is looking at keeps working',
    );
    assert.ok(existsSync(join(fx.dist, 'assets', 'index-OLDOLD00.js')));
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')), 'the failed output is cleaned up');
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('vite exited code=1')),
      'the reason is at error level',
    );
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('Could not resolve')),
      'with the bounded output tail beside it',
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: a build that exits 0 but produced no build-id.json is NOT swapped in', async () => {
  for (const missing of ['build-id.json', 'index.html', join('assets', 'index-NEWNEW00.js')]) {
    const fx = buildFixture();
    try {
      await assert.rejects(
        buildFrontend({
          repoRoot: fx.root,
          webDistDir: fx.dist,
          log: (level, message) => fx.lines.push(`[${level}] ${message}`),
          spawnFn: fakeVite({
            code: 0,
            write: (outDir) => {
              writeBuild(outDir, '20260908-1200-newnew1');
              rmSync(join(outDir, missing));
            },
          }),
        }),
        (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_BUILD,
        `a build output without ${missing} must refuse`,
      );
      assert.equal(
        readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
        '{"id":"20260101-0000-oldold0"}',
      );
      assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')));
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});
