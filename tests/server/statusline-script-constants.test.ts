/**
 * The numbers and names `server/statusline.mjs` copies from the server
 * (Quality Q8 fix round): the script imports nothing from `server/` on
 * purpose (it runs standalone as Claude Code's status-line child), so every
 * value it shares with a server module is written twice. This file pins each
 * copy to its original:
 *   - the prefs.json read cap (`MAX_PREFS_FILE_BYTES` = server/prefs.ts
 *     `PREFS_FILE_MAX_BYTES`);
 *   - the snapshot read cap (`MAX_SNAPSHOT_BYTES`, both sides) and its schema
 *     version (`SNAPSHOT_VERSION` = the `v` server/telemetry.ts believes);
 *   - the branch cache's file name (= `statuslineCacheFile` in
 *     server/config.ts, which the backend wipes at boot).
 *
 * How: source text (tests/README.md § Seams, last resort): the script's
 * constants are module-private and the script cannot be imported for them
 * without running its main. A pin, not behaviour — the behaviour of each
 * read is in tests/server/statusline-script-fifo.test.ts and
 * tests/server/statusline-script-snapshot.test.ts.
 *
 * Why it matters: two caps that drift apart fail silently — a prefs file the
 * server accepts but the script refuses draws the status line with factory
 * defaults, with no log line anywhere.
 *
 * NOT claimed: any value the script does not copy.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readSource } from '../helpers/helpers.ts';

const script = readSource('server', 'statusline.mjs');

/**
 * The value of `const <name> = <a> * <b> ...;` in `src` — the only constant
 * shape these files use for a size (digits with `_` separators, `*`).
 */
function constValue(src: string, name: string, where: string): number {
  const m = new RegExp(`\\bconst ${name} = ([0-9_ *]+);`).exec(src);
  assert.ok(m?.[1] !== undefined, `${where} declares const ${name} as a product of integers`);
  return m[1].split('*').reduce((acc, part) => acc * Number(part.trim().replaceAll('_', '')), 1);
}

test('the script reads prefs.json with the same cap as server/prefs.ts', () => {
  assert.equal(
    constValue(script, 'MAX_PREFS_FILE_BYTES', 'statusline.mjs'),
    constValue(readSource('server', 'prefs.ts'), 'PREFS_FILE_MAX_BYTES', 'prefs.ts'),
  );
});

test('the script reads the snapshot with the same cap and version as server/telemetry.ts', () => {
  const telemetry = readSource('server', 'telemetry.ts');
  assert.equal(
    constValue(script, 'MAX_SNAPSHOT_BYTES', 'statusline.mjs'),
    constValue(telemetry, 'MAX_SNAPSHOT_BYTES', 'telemetry.ts'),
  );
  const version = constValue(script, 'SNAPSHOT_VERSION', 'statusline.mjs');
  const believed = [...telemetry.matchAll(/raw\['v'\] !== (\d+)\)/g)].map((m) => Number(m[1]));
  assert.ok(believed.length >= 1, 'telemetry.ts checks the snapshot version');
  for (const v of believed) assert.equal(v, version, 'every version check telemetry.ts makes');
});

test('the script names the branch cache file as server/config.ts does', () => {
  const declared = /statuslineCacheFile: join\(dataDir, '([^']+)'\)/.exec(readSource('server', 'config.ts'))?.[1];
  assert.ok(declared !== undefined, 'config.ts declares statuslineCacheFile');
  assert.ok(script.includes(`join(dirname(prefsPath), '${declared}')`), `the script derives ${declared} beside prefs.json`);
});
