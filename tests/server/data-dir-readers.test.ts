/**
 * Every reader of a data-dir file opens it the FIFO-safe way (Quality Q8,
 * `.claude/plans/PLAN-QUALITY.md` § Q8; the house rule in
 * memory/knowledge/fifo-open-blocks-main-thread.md): prefs.json,
 * projects.json, history.json, keys.json, github.json, update-check.json and
 * the restart's poll of runtime.json all go through `readSmallRegularFile`
 * (server/config.ts). Per reader: a FIFO at the path returns at once, a
 * symlink to a perfectly good file is refused (not followed), a file one byte
 * over the reader's cap is refused — each time the store acts as if the file
 * were absent and says so in exactly ONE warn line naming the file and the
 * reason. A valid file at the same kind of path loads (the control: without
 * it "acts as absent" would pass for a reader that never reads). A store that
 * rewrites its file after load first renames the refused entry to
 * `<file>.refused-<UTC stamp>` right before its FIRST write (Q8 fix round),
 * never at load — so a refusal never destroys data, and a standby boot, which
 * loads every store but writes nothing, leaves the file where it is. A parse
 * failure keeps its old behaviour (no rename).
 *
 * How: each store's real load runs in a CHILD process with a hard spawnSync
 * timeout. The reads are synchronous, so a blocking open freezes this
 * process's event loop too — no in-process timer or `--test-timeout` can cut
 * it (measured 2026-09-22, tests/server/last-port.test.ts). A killed child is
 * the failure "it blocked", in bounded time. The helper's own edges (exact
 * cap, a read past one chunk, a directory) run in-process on regular files,
 * which cannot block; a /proc file stands in for a file grown after its
 * fstat, a spy on fs.readSync proves the fstat cap reads nothing, and the
 * restart wiring in server/index-restart.ts is a source pin (Q8 test gate).
 *
 * Why it matters: a plain readFileSync on a planted FIFO hangs the backend's
 * boot (or the restart's poll) forever with no log line; on a symlink it reads
 * whatever the link names, /dev/zero without end.
 *
 * NOT claimed: server/statusline.mjs's own copy of the read
 * (tests/server/statusline-script-fifo.test.ts); the snapshot and agents
 * readers (tests/server/telemetry.test.ts, the agents tests); runtime.json on
 * the way out (tests/server/runtime-file.test.ts); last-port.json
 * (tests/server/last-port.test.ts).
 */
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs, {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readSmallRegularFile, type Logger } from '../../server/config.ts';
import { SessionHistory } from '../../server/history.ts';
import { PrefsStore } from '../../server/prefs.ts';
import { ProjectStore } from '../../server/projects.ts';
import { KeyStore } from '../../server/keys.ts';
import { GithubConnection } from '../../server/github.ts';
import { createReleaseChecker } from '../../server/update-release.ts';
import { runtimeInfoReader } from '../../server/runtime-file.ts';
import { makeTempDirSync, mkHistoryEntry, projectRoot, readSource, removeTempDir } from '../helpers/helpers.ts';
import { infoOf } from '../helpers/history-fixture.ts';
import { jsonResponse } from '../helpers/github-fixture.ts';
import { PASTED } from '../helpers/github-token-fixture.ts';

const root = makeTempDirSync('ai-sm-datadir-readers-');
after(() => removeTempDir(root));

/** A child that has not answered in this long blocked; a normal run takes well under 2 s. */
const CHILD_DEADLINE_MS = 10_000;

/** One data-dir reader: how to load it, what "absent" looks like, its cap. */
interface Reader {
  file: string;
  module: string;
  /** A JS expression over `m` (the module), `file` and `log`; its value is the outcome. */
  probe: string;
  /** The outcome for a missing file — what every refusal must look like too. */
  absent: unknown;
  /** Contents the reader would load: the control, and the symlink's target. */
  valid: string;
  /** The reader's byte cap (its named constant in the module). */
  cap: number;
}

const READERS: Reader[] = [
  {
    file: 'prefs.json',
    module: 'prefs.ts',
    probe: 'new m.PrefsStore(file, log).get()',
    absent: {},
    valid: JSON.stringify({ theme: 'planted' }),
    cap: 4 * 1024 * 1024, // PREFS_FILE_MAX_BYTES
  },
  {
    file: 'projects.json',
    module: 'projects.ts',
    probe: 'new m.ProjectStore(file, log).list()',
    absent: [],
    valid: JSON.stringify([{ id: 'p1', name: 'planted', path: '/' }]),
    cap: 16 * 1024 * 1024, // PROJECTS_FILE_MAX_BYTES
  },
  {
    file: 'history.json',
    module: 'history.ts',
    // readOnly: the probe must not write; get() skips list()'s transcript prune.
    probe: "(() => { const h = new m.SessionHistory(file, log); h.load({ readOnly: true }); return h.get('h1') ?? null; })()",
    absent: null,
    valid: JSON.stringify([mkHistoryEntry('h1')]),
    cap: 32 * 1024 * 1024, // HISTORY_FILE_MAX_BYTES
  },
  {
    file: 'keys.json',
    module: 'keys.ts',
    probe: "new m.KeyStore(file, log).get('claude') ?? null",
    absent: null,
    valid: JSON.stringify({ claude: 'sk-planted' }),
    cap: 64 * 1024, // KEYS_FILE_MAX_BYTES
  },
  {
    file: 'github.json',
    module: 'github.ts',
    probe: 'new m.GithubConnection({ file, log }).status().state',
    absent: 'disconnected',
    valid: JSON.stringify({ accessToken: 'gho_planted' }),
    cap: 64 * 1024, // GITHUB_FILE_MAX_BYTES
  },
  {
    file: 'update-check.json',
    module: 'update-release.ts',
    probe: "m.readUpdateCheckCache(file, { assetBase: 'https://example.invalid' }, log)",
    absent: null,
    valid: JSON.stringify({ etag: '"planted"', checkedAt: '2026-09-06T10:00:00.000Z', latest: null }),
    cap: 8 * 1024, // MAX_CACHE_BYTES
  },
  {
    file: 'runtime.json',
    module: 'runtime-file.ts',
    probe: 'm.runtimeInfoReader(file, log)() ?? null',
    absent: null,
    valid: JSON.stringify({ port: 41_000, token: 'ab', pid: 1, startedAt: '2026-09-06T10:00:00.000Z' }),
    cap: 16 * 1024, // MAX_RUNTIME_FILE_BYTES
  },
];

/** What the child saw per file: the probe's outcome and every log line. */
type Outcomes = Record<string, { result: unknown; lines: string[] }>;

/**
 * Run `expr` (by default `reader.probe`) once per file in a child process.
 * Fails when the child had to be killed — that is the hang this file exists
 * to catch.
 */
function probeInChild(reader: Reader, files: string[], expr = reader.probe): Outcomes {
  const helper = join(root, `probe-${reader.file}.mjs`);
  const moduleUrl = pathToFileURL(join(projectRoot, 'server', reader.module)).href;
  writeFileSync(
    helper,
    `import * as m from ${JSON.stringify(moduleUrl)};\n` +
      'const out = {};\n' +
      'for (const file of JSON.parse(process.argv[2])) {\n' +
      '  const lines = [];\n' +
      "  const log = (level, message) => lines.push(level + ': ' + message);\n" +
      `  const result = ${expr};\n` +
      '  out[file] = { result: result === undefined ? null : result, lines };\n' +
      '}\n' +
      'process.stdout.write(JSON.stringify(out));\n',
  );
  const res = spawnSync(process.execPath, [helper, JSON.stringify(files)], {
    timeout: CHILD_DEADLINE_MS,
    encoding: 'utf8',
  });
  const output = `status=${String(res.status)} signal=${String(res.signal)} ${res.stdout}${res.stderr}`;
  assert.ok(res.signal === null && res.status === 0, `${reader.file}: the child blocked or died: ${output}`);
  return JSON.parse(res.stdout) as Outcomes;
}

/** True when `path` is a symlink (existsSync follows links, so a dangling one reads as absent). */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/** A fresh directory holding `<name>` as whatever `plant` puts there. */
function planted(reader: Reader, kind: string, plant: (path: string) => void): string {
  const dir = join(root, kind, reader.file.replace('.json', ''));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, reader.file);
  plant(path);
  return path;
}

test('every data-dir reader: a FIFO, a symlink and an over-cap file read as absent, with one warn line each', () => {
  for (const reader of READERS) {
    const control = planted(reader, 'control', (p) => writeFileSync(p, reader.valid));
    const fifo = planted(reader, 'fifo', (p) => execFileSync('mkfifo', [p]));
    const link = planted(reader, 'link', (p) => {
      // The target is a file the reader WOULD load: refusing it proves the
      // link itself is refused, not its content.
      const target = join(root, `real-${reader.file}`);
      writeFileSync(target, reader.valid);
      symlinkSync(target, p);
    });
    // Sparse: one byte past the cap costs no disk, and fstat().size refuses it
    // before any byte is read.
    const big = planted(reader, 'big', (p) => {
      writeFileSync(p, '');
      truncateSync(p, reader.cap + 1);
    });

    const out = probeInChild(reader, [control, fifo, link, big]);
    assert.equal(readFileSync(join(root, `real-${reader.file}`), 'utf8'), reader.valid, `${reader.file}: the link's target is untouched`);

    assert.notDeepEqual(out[control]?.result, reader.absent, `${reader.file}: the control loads`);
    assert.deepEqual(
      out[control]?.lines.filter((l) => l.startsWith('warn:')),
      [],
      `${reader.file}: a valid file warns nothing`,
    );
    const cases: Array<[string, string]> = [
      [fifo, 'not a regular file'],
      [link, 'a symlink'],
      [big, `larger than ${reader.cap} bytes`],
    ];
    for (const [file, reason] of cases) {
      const seen = out[file];
      assert.deepEqual(seen?.result, reader.absent, `${reader.file} (${reason}): the store acts as absent`);
      const warns = seen?.lines.filter((l) => l.startsWith('warn:')) ?? [];
      assert.equal(warns.length, 1, `${reader.file} (${reason}): exactly one warn line, got ${JSON.stringify(seen?.lines)}`);
      assert.ok(warns[0]?.includes(file), `${reader.file} (${reason}): the warn names the file: ${warns[0]}`);
      assert.ok(warns[0]?.includes(reason), `${reader.file} (${reason}): the warn names the reason: ${warns[0]}`);
      // A LOAD changes nothing on disk (a standby boot loads every store while
      // the parent still owns the data dir): the set-aside waits for a write.
      assert.deepEqual(readdirSync(dirname(file)), [reader.file], `${reader.file} (${reason}): left in place`);
    }
  }
});

test('the restart poll of runtime.json warns once per refusal, not once per poll', () => {
  const reader = READERS.find((r) => r.file === 'runtime.json');
  assert.ok(reader !== undefined);
  const fifo = planted(reader, 'fifo-repeat', (p) => execFileSync('mkfifo', [p]));
  // One reader, polled five times — what server/restart.ts does ten times a second.
  const out = probeInChild(
    reader,
    [fifo],
    '(() => { const read = m.runtimeInfoReader(file, log); for (let i = 0; i < 4; i += 1) read(); return read() ?? null; })()',
  );
  assert.equal(out[fifo]?.result, null, 'still no runtime info');
  assert.equal(out[fifo]?.lines.length, 1, `one line for five polls: ${JSON.stringify(out[fifo]?.lines)}`);
});

/** A fresh directory for one readSmallRegularFile edge (regular files only: none can block). */
function helperDir(name: string): string {
  const dir = join(root, 'helper', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test('readSmallRegularFile reads a file of exactly its cap and refuses one byte more', () => {
  const exact = join(helperDir('exact'), 'exact.json');
  writeFileSync(exact, 'x'.repeat(100));
  assert.deepEqual(readSmallRegularFile(exact, 100), { kind: 'text', text: 'x'.repeat(100) }, 'a file AT the cap reads');
  assert.deepEqual(
    readSmallRegularFile(exact, 99),
    { kind: 'unreadable', reason: 'larger than 99 bytes' },
    'one byte over the cap is refused',
  );
});

test('readSmallRegularFile reads a file past one 64 KiB read step whole, byte-exact', () => {
  const long = join(helperDir('long'), 'long.json');
  const text = 'abcdefghij'.repeat(20_000);
  writeFileSync(long, text);
  const read = readSmallRegularFile(long, 1024 * 1024);
  assert.equal(read.kind === 'text' ? read.text : read.kind, text, 'a 200 KB file reads whole');
});

test('readSmallRegularFile refuses a directory as not a regular file', () => {
  const dir = helperDir('directory');
  assert.deepEqual(
    readSmallRegularFile(dir, 1024),
    { kind: 'unreadable', reason: 'not a regular file' },
    'a directory at the path is refused with the fixed reason',
  );
});

test('readSmallRegularFile reports a path with nothing at it as missing', () => {
  assert.deepEqual(
    readSmallRegularFile(join(helperDir('missing'), 'none.json'), 1024),
    { kind: 'missing' },
    'ENOENT is missing, not unreadable',
  );
});

test('a history over the cap survives a WRITING load: set aside byte for byte, history.json rewritten empty', () => {
  const dir = join(root, 'history-rewrite');
  mkdirSync(dir);
  const file = join(dir, 'history.json');
  // A marker, then sparse to one byte past HISTORY_FILE_MAX_BYTES: refused on
  // fstat, so nothing is read — and load() writes the repaired file after.
  const cap = 32 * 1024 * 1024;
  writeFileSync(file, 'ORIGINAL-HISTORY');
  truncateSync(file, cap + 1);
  const lines: string[] = [];
  const log: Logger = (level, message) => lines.push(`${level}: ${message}`);
  const history = new SessionHistory(file, log);
  history.load();
  assert.equal(readFileSync(file, 'utf8'), '[]\n', 'history.json is the repaired, empty file');
  const asides = readdirSync(dir).filter((n) => n.startsWith('history.json.refused-'));
  assert.equal(asides.length, 1, `one set-aside file: ${JSON.stringify(readdirSync(dir))}`);
  assert.match(asides[0] ?? '', /^history\.json\.refused-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/, 'a UTC stamp');
  const kept = readFileSync(join(dir, asides[0] ?? ''));
  assert.equal(kept.length, cap + 1, 'every byte of the original survives');
  assert.equal(kept.subarray(0, 16).toString('utf8'), 'ORIGINAL-HISTORY', 'the original content, not a copy of the new file');
  const warns = lines.filter((l) => l.startsWith('warn:'));
  assert.deepEqual(warns, [
    `warn: history file ${file} refused: larger than ${cap} bytes — starting empty, set aside at the first write`,
    `warn: ${file} (refused at load) kept as ${join(dir, asides[0] ?? '')} before the first write`,
  ]);
});

test('a corrupt (unparsable) history is NOT set aside: the old behaviour stands', () => {
  const dir = join(root, 'history-corrupt');
  mkdirSync(dir);
  const file = join(dir, 'history.json');
  writeFileSync(file, '{ not json');
  const history = new SessionHistory(file, () => undefined);
  history.load();
  assert.deepEqual(readdirSync(dir), ['history.json'], 'no .refused- file for a parse failure');
  assert.equal(readFileSync(file, 'utf8'), '[]\n', 'rewritten as before');
});

/** A store that rewrites its file: build it on `file`, then make its first write. */
interface Writer {
  file: string;
  /** `write` is the store's first write; `again` a second one, after it. */
  build: (file: string, log: Logger) => { write: () => Promise<void> | void; again: () => void };
}

const WRITERS: Writer[] = [
  {
    file: 'prefs.json',
    build: (file, log) => {
      const store = new PrefsStore(file, log);
      return {
        write: () => store.replace({ mascot: { enabled: true } }),
        again: () => store.replace({ mascot: { enabled: false } }),
      };
    },
  },
  {
    file: 'projects.json',
    build: (file, log) => {
      const store = new ProjectStore(file, log);
      return {
        write: () => void store.create({ name: 'new', path: root }),
        again: () => void store.create({ name: 'newer', path: root }),
      };
    },
  },
  {
    file: 'keys.json',
    build: (file, log) => {
      const store = new KeyStore(file, log);
      return { write: () => void store.save('claude', 'sk-new'), again: () => void store.save('claude', 'sk-newer') };
    },
  },
  {
    // disconnect() UNLINKS github.json: that would destroy a refused file too.
    file: 'github.json',
    build: (file, log) => {
      const gh = new GithubConnection({ file, log });
      return { write: () => gh.disconnect(), again: () => gh.disconnect() };
    },
  },
  {
    // A read-only load is the standby boot; the writing load() is `go`.
    file: 'history.json',
    build: (file, log) => {
      const history = new SessionHistory(file, log);
      history.load({ readOnly: true });
      // `again` is not a load(): a load re-reads the file and judges it afresh.
      const info = infoOf({ id: 'again-1' });
      return {
        write: () => history.load(),
        again: () => history.recordCreate(info, { id: info.id, conversation: false, baseArgs: [] }),
      };
    },
  },
];

test('a refused store file stays in place through the load and is set aside right before the first write', async () => {
  for (const writer of WRITERS) {
    // Regular files and links only, in-process: neither can block (the FIFO
    // case is the child-process test above).
    const target = join(root, `write-target-${writer.file}`);
    writeFileSync(target, 'TARGET');
    const plants: Array<[string, (p: string) => void]> = [
      ['over the cap', (p) => {
        writeFileSync(p, 'ORIGINAL');
        truncateSync(p, 64 * 1024 * 1024); // past every writer's cap
      }],
      ['a symlink', (p) => symlinkSync(target, p)],
    ];
    for (const [what, plant] of plants) {
      const dir = join(root, 'write', writer.file.replace('.json', ''), what.replaceAll(' ', '-'));
      mkdirSync(dir, { recursive: true });
      const file = join(dir, writer.file);
      plant(file);
      const lines: string[] = [];
      const store = writer.build(file, (level, message) => lines.push(`${level}: ${message}`));
      assert.deepEqual(readdirSync(dir), [writer.file], `${writer.file} (${what}): the load moved nothing`);
      await store.write();
      const asides = readdirSync(dir).filter((n) => n.startsWith(`${writer.file}.refused-`));
      assert.equal(asides.length, 1, `${writer.file} (${what}): set aside once: ${JSON.stringify(readdirSync(dir))}`);
      const aside = join(dir, asides[0] ?? '');
      if (what === 'a symlink') {
        assert.ok(isLink(aside), `${writer.file}: the LINK itself was moved`);
      } else {
        assert.equal(readFileSync(aside).subarray(0, 8).toString('utf8'), 'ORIGINAL', `${writer.file}: the original bytes survive`);
      }
      assert.equal(readFileSync(target, 'utf8'), 'TARGET', `${writer.file} (${what}): the link's target is untouched`);
      assert.ok(
        lines.includes(`warn: ${file} (refused at load) kept as ${aside} before the first write`),
        `${writer.file} (${what}): the warn names the new path: ${JSON.stringify(lines)}`,
      );
    }
  }
});

test('a PrefsStore that only loads leaves a refused prefs.json in place', () => {
  const dir = join(root, 'standby-prefs');
  mkdirSync(dir);
  const file = join(dir, 'prefs.json');
  writeFileSync(file, 'x');
  truncateSync(file, 4 * 1024 * 1024 + 1); // one byte past PREFS_FILE_MAX_BYTES
  const prefs = new PrefsStore(file, () => undefined);
  assert.deepEqual(prefs.get(), {}, 'refused: the empty bag');
  assert.deepEqual(readdirSync(dir), ['prefs.json'], 'nothing renamed, nothing written');
  assert.equal(lstatSync(file).size, 4 * 1024 * 1024 + 1, 'the file itself is untouched');
});

test('a second write sets nothing aside: the refused file is moved once, then the store writes its own', async () => {
  for (const writer of WRITERS) {
    const target = join(root, `again-target-${writer.file}`);
    writeFileSync(target, 'TARGET');
    const dir = join(root, 'again', writer.file.replace('.json', ''));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, writer.file);
    symlinkSync(target, file);
    const lines: string[] = [];
    const store = writer.build(file, (level, message) => lines.push(`${level}: ${message}`));
    await store.write();
    store.again();
    const asides = readdirSync(dir).filter((n) => n.startsWith(`${writer.file}.refused-`));
    assert.equal(asides.length, 1, `${writer.file}: one set-aside file after two writes: ${JSON.stringify(readdirSync(dir))}`);
    assert.ok(isLink(join(dir, asides[0] ?? '')), `${writer.file}: the set-aside entry is the planted link`);
    const asideLines = lines.filter((l) => l.includes('(refused at load)'));
    assert.equal(asideLines.length, 1, `${writer.file}: one set-aside warn for two writes: ${JSON.stringify(lines)}`);
  }
});

test('a refused github.json is set aside before a remembered token is persisted, once', async () => {
  const dir = join(root, 'github-persist');
  mkdirSync(dir);
  const file = join(dir, 'github.json');
  const target = join(root, 'github-persist-target.json');
  writeFileSync(target, 'TARGET');
  symlinkSync(target, file);
  const lines: string[] = [];
  const gh = new GithubConnection({
    file,
    log: (level, message) => lines.push(`${level}: ${message}`),
    clientId: '',
    fetchImpl: () => Promise.resolve(jsonResponse({ login: 'octocat' })),
  });
  for (const round of ['first', 'second']) {
    const result = await gh.connectWithToken(PASTED, true);
    assert.ok(result.ok, `${round} paste accepted`);
    assert.equal(gh.status().persisted, true, `${round} paste persisted`);
  }
  const asides = readdirSync(dir).filter((n) => n.startsWith('github.json.refused-'));
  assert.equal(asides.length, 1, `one set-aside file: ${JSON.stringify(readdirSync(dir))}`);
  assert.ok(isLink(join(dir, asides[0] ?? '')), 'the LINK itself was moved');
  assert.ok(!isLink(file), 'github.json is now the store\'s own regular file');
  assert.equal(readFileSync(target, 'utf8'), 'TARGET', 'the link\'s target is untouched');
  assert.equal(lines.filter((l) => l.includes('(refused at load)')).length, 1, `one set-aside warn: ${JSON.stringify(lines)}`);
});

test('a history refused by the read-only load but valid by `go` is loaded and written in place, nothing set aside', () => {
  const dir = join(root, 'history-fixed-by-go');
  mkdirSync(dir);
  const file = join(dir, 'history.json');
  const target = join(root, 'history-fixed-target.json');
  writeFileSync(target, JSON.stringify([mkHistoryEntry('h1')]));
  symlinkSync(target, file);
  const lines: string[] = [];
  const history = new SessionHistory(file, (level, message) => lines.push(`${level}: ${message}`));
  history.load({ readOnly: true });
  assert.equal(history.get('h1'), undefined, 'the standby load refused the link');
  // The parent replaced the entry with a regular file before handing over.
  unlinkSync(file);
  writeFileSync(file, JSON.stringify([mkHistoryEntry('h1')]));
  history.load();
  assert.equal(history.get('h1')?.id, 'h1', 'the writing load reads the now-valid file');
  assert.deepEqual(readdirSync(dir), ['history.json'], 'nothing set aside: the refusal belonged to the earlier read');
  assert.ok(readFileSync(file, 'utf8').includes('"h1"'), 'written in place with its entry');
});

test('a refused file gone before the first write: one warn says it could not be set aside, the write goes on', () => {
  const dir = join(root, 'aside-gone');
  mkdirSync(dir);
  const file = join(dir, 'keys.json');
  const target = join(root, 'aside-gone-target.json');
  writeFileSync(target, 'TARGET');
  symlinkSync(target, file);
  const lines: string[] = [];
  const store = new KeyStore(file, (level, message) => lines.push(`${level}: ${message}`));
  unlinkSync(file);
  store.save('claude', 'sk-after');
  assert.ok(
    lines.includes(`warn: ${file} (refused at load) could not be set aside (ENOENT) before the first write`),
    `the failed set-aside is one warn line: ${JSON.stringify(lines)}`,
  );
  assert.deepEqual(readdirSync(dir), ['keys.json'], 'no set-aside file, the store wrote its own');
  assert.equal(readFileSync(target, 'utf8'), 'TARGET', 'the old link\'s target is untouched');
});

test('the restart poll warns again for a refusal that comes back after the file was gone', () => {
  // In-process: a symlink cannot block, unlike the FIFO in the child above.
  const dir = join(root, 'runtime-again');
  mkdirSync(dir);
  const file = join(dir, 'runtime.json');
  const target = join(root, 'runtime-again-target.json');
  writeFileSync(target, '{}');
  const lines: string[] = [];
  const read = runtimeInfoReader(file, (level, message) => lines.push(`${level}: ${message}`));
  symlinkSync(target, file);
  assert.equal(read(), undefined, 'a link is refused');
  assert.equal(read(), undefined, 'still refused');
  unlinkSync(file);
  assert.equal(read(), undefined, 'absent');
  symlinkSync(target, file);
  assert.equal(read(), undefined, 'refused again');
  assert.equal(lines.length, 2, `one warn per refusal episode, not per poll: ${JSON.stringify(lines)}`);
});

test('the release checker hands its log to the cache read: a refused update-check.json warns at boot', () => {
  const dir = join(root, 'update-checker');
  mkdirSync(dir);
  const cacheFile = join(dir, 'update-check.json');
  const target = join(root, 'update-checker-target.json');
  writeFileSync(target, JSON.stringify({ etag: '"x"', checkedAt: '2026-09-06T10:00:00.000Z', latest: null }));
  symlinkSync(target, cacheFile);
  const lines: string[] = [];
  const checker = createReleaseChecker({
    currentVersion: 'v0.2.0',
    apiBase: 'http://127.0.0.1:9',
    cacheFile,
    log: (level, message) => lines.push(`${level}: ${message}`),
    fetchImpl: () => Promise.reject(new Error('no request expected')),
  });
  checker.stop();
  const warns = lines.filter((l) => l.startsWith('warn:'));
  assert.equal(warns.length, 1, `one warn line: ${JSON.stringify(lines)}`);
  assert.ok(warns[0]?.includes(`${cacheFile} refused: a symlink`), `names the file and the reason: ${warns[0]}`);
});

test('readSmallRegularFile: a file longer than its fstat size is refused past the cap, never truncated', () => {
  // /proc files report st_size 0 yet read hundreds of bytes: the one
  // deterministic stand-in for a file that grew between the fstat and the
  // read (Linux; the CI runner is Ubuntu). The fstat cap cannot see it, so
  // only the running total over the reads can.
  const proc = '/proc/self/status';
  assert.equal(statSync(proc).size, 0, 'the kernel reports no size for the stand-in');
  const whole = readSmallRegularFile(proc, 1024 * 1024);
  assert.ok(whole.kind === 'text' && whole.text.length > 101, `read past its fstat size: ${JSON.stringify(whole).slice(0, 80)}`);
  assert.deepEqual(
    readSmallRegularFile(proc, 100),
    { kind: 'unreadable', reason: 'larger than 100 bytes' },
    'over the cap by the reads alone: refused, not cut at the cap',
  );
});

test('readSmallRegularFile: an over-cap file is refused on its fstat size before one byte is read', () => {
  // A spy on fs.readSync (README § Mocks: a fact the outside cannot show —
  // the refusal is the same either way, only the bytes read differ, and a
  // 32 MiB history read at boot is the cost the fstat cap exists to skip).
  // syncBuiltinESMExports pushes the spy into config.ts's named import.
  const file = join(root, 'spy-big.json');
  writeFileSync(file, '');
  truncateSync(file, 1001);
  const spy = mock.method(fs, 'readSync');
  syncBuiltinESMExports();
  try {
    assert.deepEqual(readSmallRegularFile(file, 1000), { kind: 'unreadable', reason: 'larger than 1000 bytes' });
    assert.equal(spy.mock.callCount(), 0, 'no read for a file the fstat already refused');
  } finally {
    spy.mock.restore();
    syncBuiltinESMExports();
  }
});

test('the restart wiring polls runtime.json through runtimeInfoReader (source pin)', () => {
  // Source text (README § Seams, last resort): only a real restart reaches
  // this wiring, and no restart test can plant a FIFO at runtime.json while
  // the standby is renaming its own file into place.
  const src = readSource('server', 'index-restart.ts');
  assert.match(src, /readRuntime: runtimeInfoReader\(paths\.runtimeFile, log\),/, 'the judged reader is the seam');
  assert.doesNotMatch(src, /\breadFileSync\b/, 'no plain read left in the restart wiring');
});
