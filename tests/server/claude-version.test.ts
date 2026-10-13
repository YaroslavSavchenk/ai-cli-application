/**
 * server/claude-version.ts — `probeClaudeVersion`, the dev override's
 * refusals and the re-probe of `ClaudeVersionWatch` (Nocturne D6,
 * `.claude/plans/nocturne/PLAN-D6.md` § Test gate, "Probe"); plus the
 * `onProbe` hook of server/tools.ts `cachedProbe` the watch hangs off, and
 * the shared `runCapture` (server/config.ts) it spawns through.
 *
 * How: in-process calls against `claude` doubles (sh scripts) in temp PATH
 * directories — a real spawn of a real file, with the environment passed in,
 * so nothing reads the user's own `claude`. The budgets are pinned by
 * behaviour: the hang case waits out the real 5 s, the cap case prints past
 * 4 KiB, the re-probe window runs on a stepped clock.
 *
 * Why it matters: this is a NEW SPAWN SITE (PROJECT-SCOPE § Hard technical
 * constraints). A probe that went through a shell would let a PATH entry's
 * name run code; one without a timeout or a cap would hold a child forever.
 *
 * NOT claimed: the boot wiring (after listen, the runtime body) — that is
 * tests/server/claude-version-route.test.ts against a real server child.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ClaudeVersionWatch,
  probeClaudeVersion,
  resolveClaudeVersionOverride,
} from '../../server/claude-version.ts';
import { runCapture } from '../../server/config.ts';
import { cachedProbe } from '../../server/tools.ts';
import { makeTempDir, readSource, removeTempDir, waitUntil } from '../helpers/helpers.ts';
import { CLAUDE_DOUBLE_VERSION } from '../helpers/history-fixture.ts';

let root: string;

/** `<root>/<name>/claude` holding `script`; resolves the directory. */
async function binWith(name: string, script: string): Promise<string> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'claude'), script, { mode: 0o755 });
  return dir;
}

/** How many times `upgrade` ran: each one stamps its own mtime. */
let upgrades = 0;

/**
 * Replace `<dir>/claude` the way an upgrade does, as the watch's fingerprint
 * sees it: new content AND a new mtime. The mtime is SET, not left to the
 * clock: the kernel stamps file times from a coarse clock (one tick is
 * milliseconds), so a rewrite in the same tick as the create keeps the old
 * mtime — under suite load that is exactly what happened, and the watch
 * rightly saw no change. Stamps count up from a fixed past instant, so every
 * one differs from the create's own (now) and from each other.
 */
async function upgrade(dir: string, script: string): Promise<void> {
  const file = join(dir, 'claude');
  await writeFile(file, script, { mode: 0o755 });
  upgrades += 1;
  const at = 1_700_000_000 + upgrades;
  await utimes(file, at, at);
}

/** Captured log lines, `<level> <message>`. */
function capture(): { lines: string[]; log: (level: string, msg: string) => void } {
  const lines: string[] = [];
  return { lines, log: (level, msg) => void lines.push(`${level} ${msg}`) };
}

before(async () => {
  root = await makeTempDir('ai-sm-claude-version-');
});

after(async () => {
  if (root !== undefined) await removeTempDir(root);
});

test('a double answering a version is ok, and it was run with exactly one argument: --version', async () => {
  const out = join(root, 'argv-ok');
  const dir = await binWith(
    'ok',
    `#!/bin/sh\nprintf '%s\\n' "$#" "$@" > "${out}"\nprintf '2.1.287 (Claude Code)\\n'\n`,
  );
  const { lines, log } = capture();
  const answer = await probeClaudeVersion({ env: { PATH: dir }, log });
  assert.deepEqual(answer, { version: '2.1.287', compat: 'ok' });
  assert.equal(await readFile(out, 'utf8'), '1\n--version\n', 'argc 1, argv[1] --version');
  assert.ok(
    lines.some((l) => l.startsWith('info Claude Code 2.1.287 (ok; supported 2.1.263, tested up to 2.1.287) at ')),
    lines.join('\n'),
  );
});

test('the shared history double answers --version from $AI_SM_TEST_CLAUDE_VERSION, default 2.1.287', async () => {
  const dir = await binWith('shared', `${CLAUDE_DOUBLE_VERSION}exit 9\n`);
  const { log } = capture();
  assert.deepEqual(await probeClaudeVersion({ env: { PATH: dir }, log }), { version: '2.1.287', compat: 'ok' });
  assert.deepEqual(
    await probeClaudeVersion({ env: { PATH: dir, AI_SM_TEST_CLAUDE_VERSION: '2.1.300 (Claude Code)' }, log }),
    { version: '2.1.300', compat: 'newer' },
  );
  assert.deepEqual(
    await probeClaudeVersion({ env: { PATH: dir, AI_SM_TEST_CLAUDE_VERSION: '2.1.250' }, log }),
    { version: '2.1.250', compat: 'older' },
  );
});

test('the probe reads at most 4 KiB: a version past the first 4096 bytes is never seen', async () => {
  const { log } = capture();
  // 4087 filler bytes + ' 2.1.287' end at byte 4095; with 4091 the cap cuts it to ' 2.1.'.
  const within = await binWith('cap-in', "#!/bin/sh\nhead -c 4087 /dev/zero | tr '\\0' x\nprintf ' 2.1.287\\n'\n");
  assert.deepEqual(
    await probeClaudeVersion({ env: { PATH: `${within}:/usr/bin:/bin` }, log }),
    { version: '2.1.287', compat: 'ok' },
    'a version ending inside the first 4096 bytes is read',
  );
  const past = await binWith('cap-out', "#!/bin/sh\nhead -c 4091 /dev/zero | tr '\\0' x\nprintf ' 2.1.287\\n'\n");
  const answer = await probeClaudeVersion({ env: { PATH: `${past}:/usr/bin:/bin` }, log });
  assert.equal(answer.compat, 'unknown', 'byte 4097 on is never read: the cut `2.1.` is no version');
});

test('garbage is unknown and keeps at most 40 control-stripped characters of its first line', async () => {
  const dir = await binWith(
    'garbage',
    `#!/bin/sh\nprintf '\\n\\033[31mSomething went sideways in a way that is quite long indeed\\033[0m\\nsecond\\n'\n`,
  );
  const { lines, log } = capture();
  const answer = await probeClaudeVersion({ env: { PATH: dir }, log });
  assert.equal(answer.compat, 'unknown');
  assert.equal(answer.version, 'Something went sideways in a way that is', 'escape sequences go whole');
  assert.equal(answer.version?.length, 40);
  assert.ok(!/[\u0000-\u001f]/.test(answer.version ?? ''), 'no control character survives');
  assert.ok(lines.some((l) => l.startsWith('warn claude --version printed no version: ')), lines.join('\n'));
});

test('empty output and a non-zero exit are unknown with no version', async () => {
  const { log } = capture();
  const empty = await binWith('empty', '#!/bin/sh\nexit 0\n');
  assert.deepEqual(await probeClaudeVersion({ env: { PATH: empty }, log }), { version: null, compat: 'unknown' });
  const failing = await binWith('failing', "#!/bin/sh\nprintf '2.1.287\\n'\nexit 3\n");
  const lines: string[] = [];
  assert.deepEqual(
    await probeClaudeVersion({ env: { PATH: failing }, log: (l, m) => void lines.push(`${l} ${m}`) }),
    { version: null, compat: 'unknown' },
  );
  assert.ok(lines.some((l) => l.startsWith('warn claude --version exited with code 3 (')), lines.join('\n'));
});

test('a probe hanging past its 5 s timeout is SIGKILLed and answers unknown', async () => {
  const pidFile = join(root, 'hang.pid');
  const dir = await binWith('hang', `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 300\n`);
  const { lines, log } = capture();
  const started = performance.now();
  const answer = await probeClaudeVersion({ env: { PATH: `${dir}:/usr/bin:/bin` }, log });
  const tookMs = performance.now() - started;
  assert.deepEqual(answer, { version: null, compat: 'unknown' });
  assert.ok(tookMs >= 4900, `not before the 5 s budget, took ${tookMs}ms`);
  // Upper bound with runner headroom: the child sleeps 300 s.
  assert.ok(tookMs < 8000, `at the budget, not when the child chose to end: took ${tookMs}ms`);
  assert.ok(lines.some((l) => l.startsWith('warn claude --version timed out (')), lines.join('\n'));
  const pid = Number((await readFile(pidFile, 'utf8')).trim());
  await waitUntil(() => {
    try {
      process.kill(pid, 0);
      return undefined;
    } catch {
      return true;
    }
  }, 'the hung probe child to be gone');
});

test('no claude on PATH is missing, and a relative or empty PATH entry is never searched', async () => {
  const { lines, log } = capture();
  for (const PATH of [undefined, '', join(root, 'nowhere'), '.:bin::']) {
    const env = PATH === undefined ? {} : { PATH };
    assert.deepEqual(await probeClaudeVersion({ env, log }), { version: null, compat: 'missing' }, `PATH=${PATH}`);
  }
  assert.ok(lines.includes("info Claude Code not found on the sessions' PATH"));
});

test('never through a shell: a PATH directory named with shell syntax still runs the right file', async () => {
  // Under a shell the space and `;` would split this path into commands that
  // do not exist (and `$( )` would run one), so the probe could not answer;
  // argv-only, it is just a directory name. Nothing here writes a file.
  const dir = await binWith('odd dir;$(echo nope) `false`', "#!/bin/sh\nprintf '2.1.270\\n'\n");
  const { log } = capture();
  assert.deepEqual(await probeClaudeVersion({ env: { PATH: dir }, log }), { version: '2.1.270', compat: 'ok' });
  // The pin on the one spawn: argv array, shell explicitly off, stdin and stderr ignored.
  const config = readSource('server', 'config.ts');
  assert.match(config, /spawn\(command, args, \{\s*stdio: \['ignore', 'pipe', 'ignore'\],\s*shell: false,/);
  const probe = readSource('server', 'claude-version.ts');
  assert.match(probe, /runCapture\(binary, \['--version'\], \{/);
  assert.doesNotMatch(probe, /child_process|exec\(|execSync|spawnSync/, 'the probe spawns only through runCapture');
});

test('runCapture keeps at most maxBytes of stdout and passes the env it is given', async () => {
  const dir = await binWith('chatty', '#!/bin/sh\nprintf "%s" "$SAY"\nhead -c 100000 /dev/zero | tr "\\\\0" a\n');
  const out = await runCapture(join(dir, 'claude'), [], { env: { SAY: 'hello-', PATH: '/usr/bin:/bin' }, maxBytes: 64 });
  assert.equal(out, `hello-${'a'.repeat(58)}`);
  assert.equal(out.length, 64);
});

test('resolveClaudeVersionOverride: dev-only, X.Y.Z only, refused with a warn line otherwise', () => {
  const { lines, log } = capture();
  assert.equal(resolveClaudeVersionOverride(undefined, false, log), undefined);
  assert.equal(resolveClaudeVersionOverride('', false, log), undefined);
  assert.equal(lines.length, 0, 'unset says nothing');

  assert.equal(resolveClaudeVersionOverride('2.1.300', true, log), undefined, 'refused when installed');
  assert.deepEqual(lines, [
    'warn AI_SM_CLAUDE_VERSION_OVERRIDE is a development setting; ignored in the installed app',
  ]);
  lines.length = 0;
  for (const bad of ['v2.1.300', '2.1', '2.1.300 (Claude Code)', '2.1.300\nfake line']) {
    assert.equal(resolveClaudeVersionOverride(bad, false, log), undefined, JSON.stringify(bad));
  }
  assert.equal(lines.length, 4);
  assert.ok(lines.every((l) => l.startsWith('warn AI_SM_CLAUDE_VERSION_OVERRIDE must be a version X.Y.Z, got ')));
  assert.ok(lines.every((l) => !l.includes('\n')), 'the refused value is one-lined');
  lines.length = 0;
  assert.equal(resolveClaudeVersionOverride('2.1.300', false, log), '2.1.300');
  assert.deepEqual(lines, [
    'info Claude Code version overridden to 2.1.300 (AI_SM_CLAUDE_VERSION_OVERRIDE, development only)',
  ]);
});

test('ClaudeVersionWatch: unknown until the first probe answers; an override never probes', async () => {
  const dir = await binWith('watch-start', "#!/bin/sh\nprintf '2.1.280\\n'\n");
  const { log } = capture();
  const watch = new ClaudeVersionWatch({ env: () => ({ PATH: dir }), log });
  const range = { min: '2.1.263', testedUpTo: '2.1.287' };
  assert.deepEqual(watch.status(), { version: null, compat: 'unknown', ...range });
  assert.equal(watch.version(), null);
  await watch.start();
  assert.deepEqual(watch.status(), { version: '2.1.280', compat: 'ok', ...range });
  watch.stop();

  const marker = join(root, 'override-ran');
  const spy = await binWith('watch-override', `#!/bin/sh\ntouch "${marker}"\nprintf '2.1.280\\n'\n`);
  const overridden = new ClaudeVersionWatch({ env: () => ({ PATH: spy }), log, override: '2.1.300' });
  assert.deepEqual(overridden.status(), { version: '2.1.300', compat: 'newer', ...range });
  await overridden.start();
  await overridden.binaryChanged();
  await assert.rejects(readFile(marker), /ENOENT/, 'the override replaces the probe: nothing spawned');
});

test('ClaudeVersionWatch re-probes when the binary changes: at once past the window, at its end inside it', async () => {
  const dir = await binWith('watch-change', "#!/bin/sh\nprintf '2.1.280\\n'\n");
  const { lines, log } = capture();
  let clock = 1_000;
  const watch = new ClaudeVersionWatch({ env: () => ({ PATH: dir }), log, now: () => clock, reprobeMinMs: 150 });
  await watch.start();
  assert.equal(watch.version(), '2.1.280');

  await watch.binaryChanged();
  assert.equal(lines.filter((l) => l.includes('probing its version again')).length, 0, 'unchanged: no probe');

  // An upgrade INSIDE the window: probed when the window ends, by one timer.
  await upgrade(dir, "#!/bin/sh\nprintf '2.1.300\\n'\n");
  clock += 50;
  await watch.binaryChanged();
  await watch.binaryChanged();
  assert.equal(watch.version(), '2.1.280', 'not yet: inside the window');
  assert.equal(lines.filter((l) => l.includes('probing its version again in 100ms')).length, 1, lines.join('\n'));
  await waitUntil(() => (watch.version() === '2.1.300' ? true : undefined), 'the scheduled re-probe');
  assert.equal(watch.status().compat, 'newer');

  // Past the window: a change is probed at once.
  await upgrade(dir, "#!/bin/sh\nprintf '2.1.290 (renamed)\\n'\n");
  clock += 1_000;
  await watch.binaryChanged();
  assert.equal(watch.version(), '2.1.290');

  // The binary going away is a change too.
  await rm(join(dir, 'claude'));
  clock += 1_000;
  await watch.binaryChanged();
  assert.equal(watch.status().compat, 'missing');
  watch.stop();
});

test('ClaudeVersionWatch: the default re-probe window is one minute', async () => {
  const dir = await binWith('watch-default', "#!/bin/sh\nprintf '2.1.280\\n'\n");
  const { lines, log } = capture();
  let clock = 1_000;
  const watch = new ClaudeVersionWatch({ env: () => ({ PATH: dir }), log, now: () => clock });
  try {
    await watch.start();
    await upgrade(dir, "#!/bin/sh\nprintf '2.1.281\\n'\n");
    clock += 30_000;
    await watch.binaryChanged();
    assert.ok(
      lines.includes('info the claude on PATH changed; probing its version again in 30000ms'),
      lines.join('\n'),
    );
    assert.equal(watch.version(), '2.1.280', 'half a minute in: still waiting');
  } finally {
    watch.stop(); // drops the 30 s timer
  }
});

test('the probe raw text drops bidi controls as well as escapes and controls', async () => {
  const dir = await binWith(
    'bidi',
    "#!/bin/sh\nprintf 'ok \\342\\200\\256evil\\342\\201\\246 \\342\\200\\217x\\n'\n",
  );
  const { lines, log } = capture();
  const answer = await probeClaudeVersion({ env: { PATH: dir }, log });
  assert.deepEqual(answer, { version: 'ok evil x', compat: 'unknown' });
  assert.ok(!lines.join('\n').includes('‮'), 'no RLO reaches the log');
});

test('cachedProbe calls onProbe after every probe that really ran, never on a cache hit', async () => {
  let clock = 0;
  let calls = 0;
  const probe = cachedProbe({ env: () => ({ PATH: '' }), now: () => clock, cacheMs: 100, onProbe: () => void calls++ });
  await probe();
  assert.equal(calls, 1);
  clock = 50;
  await probe();
  assert.equal(calls, 1, 'a cache hit is no new evidence');
  clock = 200;
  await probe();
  assert.equal(calls, 2);
});

test('the probe runs the FIRST claude on PATH, the one a bare `claude` session launches', async () => {
  // Two executables named claude: PATH order decides, as it does for the
  // session's spawn. A probe that picked any other would report a version the
  // sessions never run.
  const first = await binWith('order-first', "#!/bin/sh\nprintf '2.1.270\\n'\n");
  const second = await binWith('order-second', "#!/bin/sh\nprintf '2.1.300\\n'\n");
  const { log } = capture();
  assert.deepEqual(await probeClaudeVersion({ env: { PATH: `${first}:${second}` }, log }), {
    version: '2.1.270',
    compat: 'ok',
  });
  assert.deepEqual(await probeClaudeVersion({ env: { PATH: `${second}:${first}` }, log }), {
    version: '2.1.300',
    compat: 'newer',
  });
});

test('ClaudeVersionWatch: a probe still out when stop() runs never writes its answer', async () => {
  // stop() is the shutdown path (server/index.ts): what a probe answers after
  // it is not the state of a running app. stop() runs synchronously after
  // start(), so the probe is certainly still out — no timing involved.
  const dir = await binWith('watch-stopped', "#!/bin/sh\nprintf '2.1.280\\n'\n");
  const { log } = capture();
  const watch = new ClaudeVersionWatch({ env: () => ({ PATH: dir }), log });
  const started = watch.start();
  watch.stop();
  await started;
  assert.deepEqual(watch.status(), { version: null, compat: 'unknown', min: '2.1.263', testedUpTo: '2.1.287' });
});
