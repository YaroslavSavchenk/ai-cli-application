/**
 * Manual restart, preflight step 2 — how the frontend build + swap
 * (server/webbuild.ts) FAILS without taking the served UI with it: no vite
 * (the dependency message, nothing spawned), a hung build killed at the
 * timeout (and SIGKILLed when it ignores SIGTERM), either rename failing (the
 * old frontend restored — never a window without a UI; the loud line when the
 * restore fails too), a leftover dist-next wiped first, a repo with no web/dist
 * yet, a spawn that never starts, the bounded log tail of vite's output, and
 * the staging dirs being gitignored.
 *
 * How: a stubbed or scripted vite on a real temp filesystem
 * (`fakeVite`, `buildFixture` in `tests/helpers/restart-fixture.ts`); each
 * rename failure is staged on the real tree (the output removed between build
 * and swap, an unwritable parent, a squatter directory) — the unwritable-parent
 * case proves nothing as root and returns early there.
 *
 * NOT claimed here: the good path — `tests/server/restart-webbuild.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RestartRefusal, REFUSED_BUILD, REFUSED_DEPENDENCIES } from '../../server/restart.ts';
import {
  buildFrontend,
  swapFrontend,
  BUILD_KILL_GRACE_MS,
  BUILD_OUTPUT_TAIL_BYTES,
} from '../../server/webbuild.ts';
import { waitUntil, IS_ROOT, readSource } from '../helpers/helpers.ts';
import { tempDir, fakeVite, writeBuild, buildFixture } from '../helpers/restart-fixture.ts';

// ---------------------------------------------------------------------------
// 1c. The frontend build + swap (server/webbuild.ts) — the failure modes
// ---------------------------------------------------------------------------

test('web build: no node_modules/vite/bin/vite.js refuses with the DEPENDENCY message, spawning nothing', async () => {
  const root = tempDir();
  try {
    const dist = join(root, 'web', 'dist');
    writeBuild(dist, '20260101-0000-oldold0', 'index-OLDOLD00.js');
    let spawned = 0;
    await assert.rejects(
      buildFrontend({
        repoRoot: root,
        webDistDir: dist,
        log: () => undefined,
        spawnFn: (): ChildProcess => {
          spawned += 1;
          return fakeVite({ code: 0 })('node', []);
        },
      }),
      (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_DEPENDENCIES,
    );
    assert.equal(spawned, 0, 'nothing is executed when the tree is not installed');
    assert.ok(existsSync(join(dist, 'build-id.json')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('web build: a build that hangs is killed at the timeout and refuses', async () => {
  const fx = buildFixture();
  const idle = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await assert.rejects(
      buildFrontend({
        repoRoot: fx.root,
        webDistDir: fx.dist,
        log: (level, message) => fx.lines.push(`[${level}] ${message}`),
        timeoutMs: 150,
        spawnFn: () => idle, // A REAL process that never finishes.
      }),
      (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_BUILD,
    );
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('did not finish within 150ms')),
      `the timeout is logged: ${fx.lines.join(' | ')}`,
    );
    await waitUntil(() => (idle.killed || idle.exitCode !== null ? true : undefined), 'the hung build to be killed');
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'and the old build still stands',
    );
    assert.ok(
      !existsSync(join(fx.root, 'web', 'dist-next')),
      'and the half-written output of the killed build is cleaned up — the NEXT restart ' +
        'must not verify leftovers from this one',
    );
  } finally {
    idle.kill('SIGKILL');
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: the second rename failing RESTORES the old frontend — never a window without a UI', async () => {
  // The one genuinely dangerous moment in the whole feature: `dist` has already
  // been moved to `dist-prev`, so if `dist-next` -> `dist` fails and nothing
  // puts it back, the app serves NOTHING until someone rebuilds by hand.
  // Sabotage = the verified build output vanishes between the two renames.
  const fx = buildFixture();
  const nextDir = join(fx.root, 'web', 'dist-next');
  const prevDir = join(fx.root, 'web', 'dist-prev');
  try {
    const opts = {
      repoRoot: fx.root,
      webDistDir: fx.dist,
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
        fx.lines.push(`[${level}] ${message}`),
      spawnFn: fakeVite({
        code: 0,
        write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
      }),
    };
    await buildFrontend(opts);
    rmSync(nextDir, { recursive: true, force: true }); // The verified output vanishes.
    assert.throws(
      () => swapFrontend(opts),
      (err: unknown) => {
        assert.ok(err instanceof RestartRefusal);
        assert.equal(err.refusal, REFUSED_BUILD);
        assert.equal(err.message, 'the new build could not be moved into place');
        return true;
      },
    );

    // THE assertion of this test: the app the user is looking at is back.
    assert.ok(existsSync(fx.dist), 'web/dist exists again');
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'and it is the OLD build, restored byte-for-byte',
    );
    assert.ok(existsSync(join(fx.dist, 'assets', 'index-OLDOLD00.js')), 'with its own entry bundle');
    assert.ok(!existsSync(prevDir), 'the backup was consumed by the restore, not left lying around');
    assert.ok(!existsSync(nextDir), 'and no scratch dir survives either');
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('could not move the new frontend into place')),
      `the failure is one error line: ${fx.lines.join(' | ')}`,
    );
    assert.ok(
      !fx.lines.some((l) => l.includes('the OLD frontend could not be restored')),
      'and the loud "both renames failed" line is NOT printed when the restore worked',
    );
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: the FIRST rename failing refuses without touching the served build', async () => {
  // `dist` -> `dist-prev` is refused (the parent directory is not writable), so
  // the swap never starts. Nothing has moved, so there is nothing to restore —
  // and the refusal must still name the build reason, not a crash.
  if (IS_ROOT) return; // root ignores the mode bits; nothing to prove.
  const fx = buildFixture();
  const webDir = join(fx.root, 'web');
  try {
    const opts = {
      repoRoot: fx.root,
      webDistDir: fx.dist,
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
        fx.lines.push(`[${level}] ${message}`),
      spawnFn: fakeVite({
        code: 0,
        write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
      }),
    };
    await buildFrontend(opts);
    chmodSync(webDir, 0o500); // web/ is no longer writable: no rename can happen.
    assert.throws(
      () => swapFrontend(opts),
      (err: unknown) => {
        assert.ok(err instanceof RestartRefusal);
        assert.equal(err.refusal, REFUSED_BUILD);
        assert.equal(err.message, 'the old build could not be moved aside');
        return true;
      },
    );
    chmodSync(webDir, 0o700);
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'the served build never moved',
    );
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('could not move the old frontend aside')),
      `the failure is one error line: ${fx.lines.join(' | ')}`,
    );
  } finally {
    chmodSync(webDir, 0o700);
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: a repo with NO web/dist yet builds straight into place', async () => {
  // A fresh checkout (web/dist is gitignored): there is nothing to move aside,
  // so `hadDist` is false and the restore path must never be entered.
  const root = tempDir();
  try {
    mkdirSync(join(root, 'node_modules', 'vite', 'bin'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '// not run');
    const dist = join(root, 'web', 'dist');
    mkdirSync(join(root, 'web'), { recursive: true });
    assert.ok(!existsSync(dist), 'the starting point: nothing built');

    const lines: string[] = [];
    const opts = {
      repoRoot: root,
      webDistDir: dist,
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string) =>
        lines.push(`[${level}] ${message}`),
      spawnFn: fakeVite({
        code: 0,
        write: (outDir: string) => writeBuild(outDir, '20260908-1200-first01'),
      }),
    };
    const result = await buildFrontend(opts);
    swapFrontend(opts);

    assert.equal(result.buildId, '20260908-1200-first01');
    assert.ok(existsSync(join(dist, 'index.html')));
    assert.ok(existsSync(join(dist, 'assets', 'index-NEWNEW00.js')));
    assert.ok(!existsSync(join(root, 'web', 'dist-next')));
    assert.ok(!existsSync(join(root, 'web', 'dist-prev')));
    assert.ok(
      !lines.some((l) => l.startsWith('[error]')),
      `nothing failed: ${lines.join(' | ')}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('web build: a leftover dist-next from a crashed earlier run is wiped BEFORE the build, never inherited', async () => {
  // If a previous restart died between "vite wrote dist-next" and the swap, a
  // complete-looking stale output is sitting there. Two ways it could be
  // promoted, both refused:
  for (const [why, behaviour] of [
    // 1. this build FAILS and the only complete output on disk is the leftover;
    ['a failed build', { code: 1, stderr: 'boom\n' }],
    // 2. this build "succeeds" but writes only part of its output — without the
    //    pre-build wipe the stale index.html and stale bundle fill the gaps and
    //    a verified-looking mix of two builds gets swapped in.
    [
      'a partial build',
      {
        code: 0,
        write: (outDir: string): void => {
          mkdirSync(outDir, { recursive: true });
          writeFileSync(join(outDir, 'build-id.json'), '{"id":"20260908-1200-partial"}\n');
        },
      },
    ],
  ] as [string, Parameters<typeof fakeVite>[0]][]) {
    const fx = buildFixture();
    const nextDir = join(fx.root, 'web', 'dist-next');
    try {
      writeBuild(nextDir, '20260102-0000-stale00', 'index-STALE000.js');
      await assert.rejects(
        buildFrontend({
          repoRoot: fx.root,
          webDistDir: fx.dist,
          log: () => undefined,
          spawnFn: fakeVite(behaviour),
        }),
        (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_BUILD,
        why,
      );
      assert.equal(
        readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
        '{"id":"20260101-0000-oldold0"}',
        `${why}: the stale output was never promoted`,
      );
      assert.ok(
        !existsSync(join(fx.dist, 'assets', 'index-STALE000.js')),
        `${why}: and its bundle never reached web/dist`,
      );
      assert.ok(!existsSync(nextDir));
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  }
});

test('web build: a vite that IGNORES SIGTERM is SIGKILLed after the grace — never left writing into dist-next', async () => {
  // The timeout kill is two steps: SIGTERM now, SIGKILL BUILD_KILL_GRACE_MS
  // later, and the escalation deliberately outlives the refusal (the promise
  // resolves at the SIGTERM). A vite that traps SIGTERM would otherwise keep
  // writing into web/dist-next long after the restart was refused — and the
  // NEXT restart wipes dist-next before building, so the two would race.
  assert.equal(BUILD_KILL_GRACE_MS, 2_000, 'the shipped grace');
  const fx = buildFixture();
  const stubborn = spawn(
    process.execPath,
    ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  try {
    await assert.rejects(
      buildFrontend({
        repoRoot: fx.root,
        webDistDir: fx.dist,
        log: (level, message) => fx.lines.push(`[${level}] ${message}`),
        timeoutMs: 100,
        spawnFn: () => stubborn,
      }),
      (err: unknown) => err instanceof RestartRefusal && err.refusal === REFUSED_BUILD,
    );
    assert.equal(stubborn.exitCode, null, 'the SIGTERM alone did not move it: that is the point');
    const how = await waitUntil(
      () => (stubborn.signalCode === null && stubborn.exitCode === null ? undefined : stubborn.signalCode),
      `the stubborn build to be SIGKILLed ${BUILD_KILL_GRACE_MS}ms after the SIGTERM`,
    );
    assert.equal(how, 'SIGKILL', 'the escalation is real, not a comment');
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'and the served build never moved',
    );
  } finally {
    stubborn.kill('SIGKILL');
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("web build: vite's output is logged as a BOUNDED tail with the full byte count beside it", async () => {
  // vite draws progress with control characters and a broken build can print
  // megabytes. Only the last BUILD_OUTPUT_TAIL_BYTES reach server.log — bounded
  // on the way IN, so a runaway build cannot grow this process either — and the
  // count is the FULL size, so the log never lies about how much was dropped.
  assert.equal(BUILD_OUTPUT_TAIL_BYTES, 4_096, 'the shipped bound');
  const fx = buildFixture();
  const stdout = `HEADMARKER${'a'.repeat(5_000)}\n`; // 5011 bytes
  const stderr = `${'b'.repeat(100)}TAILMARKER\n`; //    111 bytes
  const total = Buffer.byteLength(stdout) + Buffer.byteLength(stderr);
  assert.equal(total, 5_122, 'the fixture is the arithmetic this test asserts');
  try {
    await buildFrontend({
      repoRoot: fx.root,
      webDistDir: fx.dist,
      log: (level, message) => fx.lines.push(`[${level}] ${message}`),
      spawnFn: fakeVite({
        code: 0,
        stdout,
        stderr,
        write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
      }),
    });
    const line = fx.lines.find((l) => l.includes('vite output'));
    assert.ok(line !== undefined, `the tail is logged: ${fx.lines.join(' | ')}`);
    const marker = `vite output ${total} bytes, last ${BUILD_OUTPUT_TAIL_BYTES} bytes: `;
    assert.ok(line.includes(marker), `both counts are named verbatim: ${line.slice(0, 120)}`);
    const tail = line.slice(line.indexOf(marker) + marker.length);
    assert.ok(
      Buffer.byteLength(tail) <= BUILD_OUTPUT_TAIL_BYTES,
      `the logged tail is ${Buffer.byteLength(tail)} bytes, over the ${BUILD_OUTPUT_TAIL_BYTES} bound`,
    );
    assert.ok(tail.includes('TAILMARKER'), 'it is the LAST bytes, across both streams');
    assert.ok(!tail.includes('HEADMARKER'), 'and the first 1026 bytes were dropped, not kept');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: a spawn that never starts (child `error`) refuses with `could not run vite`', async () => {
  // The `close` path covers a vite that ran and failed. This is the other one:
  // ENOENT/EACCES on the binary itself, where no exit code ever arrives — an
  // unhandled 'error' on a ChildProcess is an uncaught exception that would
  // take the whole backend down instead of refusing the restart.
  const fx = buildFixture();
  try {
    await assert.rejects(
      buildFrontend({
        repoRoot: fx.root,
        webDistDir: fx.dist,
        log: (level, message) => fx.lines.push(`[${level}] ${message}`),
        spawnFn: (): ChildProcess => {
          const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter;
            stderr: EventEmitter;
            kill: () => boolean;
          };
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          child.kill = (): boolean => true;
          setImmediate(() => child.emit('error', new Error('spawn EACCES')));
          return child as unknown as ChildProcess;
        },
      }),
      (err: unknown) => {
        assert.ok(err instanceof RestartRefusal);
        assert.equal(err.refusal, REFUSED_BUILD);
        assert.match(err.message, /could not run vite: .*spawn EACCES/);
        return true;
      },
    );
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('could not run vite')),
      `the reason is one error line: ${fx.lines.join(' | ')}`,
    );
    assert.equal(
      readFileSync(join(fx.dist, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'the app the user is looking at is untouched',
    );
    assert.ok(!existsSync(join(fx.root, 'web', 'dist-next')), 'and nothing is staged');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('web build: when the restore ALSO fails, the loud both-renames-failed line is printed', async () => {
  // The worst outcome in the feature: dist is already at dist-prev, the new
  // build cannot be moved in, AND putting the old one back fails too. The line
  // that names it is the only thing standing between the user and a silently
  // empty web/dist, so it is asserted rather than assumed.
  //
  // Staging it needs two failures. The first: the verified output vanishes
  // (same sabotage as the restore-works test). The second: something occupies
  // web/dist as a NON-EMPTY directory before the restore runs — rename(2) onto
  // a non-empty directory is ENOTEMPTY. The only code that runs between the two
  // is the injected logger, which is exactly where a real racing process would
  // have fitted, so the squatter is created from there.
  const fx = buildFixture();
  const nextDir = join(fx.root, 'web', 'dist-next');
  const prevDir = join(fx.root, 'web', 'dist-prev');
  try {
    const opts = {
      repoRoot: fx.root,
      webDistDir: fx.dist,
      log: (level: 'debug' | 'info' | 'warn' | 'error', message: string): void => {
        fx.lines.push(`[${level}] ${message}`);
        if (message.includes('could not move the new frontend into place')) {
          mkdirSync(join(fx.dist, 'assets'), { recursive: true });
          writeFileSync(join(fx.dist, 'assets', 'squatter.js'), '//');
        }
      },
      spawnFn: fakeVite({
        code: 0,
        write: (outDir: string) => writeBuild(outDir, '20260908-1200-newnew1'),
      }),
    };
    await buildFrontend(opts);
    rmSync(nextDir, { recursive: true, force: true });
    assert.throws(
      () => swapFrontend(opts),
      (err: unknown) =>
        err instanceof RestartRefusal &&
        err.refusal === REFUSED_BUILD &&
        err.message === 'the new build could not be moved into place',
    );
    assert.ok(
      fx.lines.some((l) => l.startsWith('[error]') && l.includes('and the OLD frontend could not be restored')),
      `the both-failed line is written at error level: ${fx.lines.join(' | ')}`,
    );
    // And the old build is still ON DISK, not deleted: dist-prev is what a
    // human (or the next restart) can put back by hand.
    assert.ok(existsSync(prevDir), 'dist-prev survives a failed restore — nothing was destroyed');
    assert.equal(
      readFileSync(join(prevDir, 'build-id.json'), 'utf8').trim(),
      '{"id":"20260101-0000-oldold0"}',
      'and it is the old build, intact',
    );
    assert.ok(!existsSync(nextDir), 'the staged output is still cleaned up');
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test('the staging directories a restart creates are gitignored — a crashed restart leaves no commit bait', () => {
  // web/dist-next lives for the length of a build (up to 120 s) and web/dist-prev
  // for the length of two renames; a restart that dies in between leaves one on
  // disk. Neither is ever committed — and an ignored path is the only thing that
  // keeps `git status` honest for the developer who looks right after a crash.
  const ignore = readSource('.gitignore')
    .split('\n')
    .map((line) => line.trim());
  for (const entry of ['web/dist/', 'web/dist-next/', 'web/dist-prev/']) {
    assert.ok(ignore.includes(entry), `.gitignore must list ${entry}: ${ignore.join(' | ')}`);
  }
});
