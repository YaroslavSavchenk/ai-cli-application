/**
 * `launcher/config-common.ps1` — the shared distro / repo-path resolution the
 * Windows launcher and the shortcut maker both dot-source.
 *
 * Why this file exists: both scripts used to hardcode the author's distro and
 * clone, so a downloaded copy started the wrong repo. They now DERIVE both
 * values from their own location under the WSL share
 * (`\\wsl.localhost\<distro>\<linux path>\launcher`). That makes the derivation
 * an injection-relevant surface: those two strings are the only ones that ever
 * reach a WSL command line, and they are gated by an allow-list regex, not by
 * escaping. So what is pinned here is:
 *
 *   - which shapes derive, and which ones must derive NOTHING (`$null`) so the
 *     caller keeps its defaults — including the look-alike hosts
 *     `\\wsl.localhost.evil\…` and `\\wsl.localhostx\…`;
 *   - that segments come back VERBATIM: no decoding, no unescaping, no
 *     normalization can smuggle a character past the caller's allow-list;
 *   - the precedence env var > launcher-config.json > launcher location >
 *     built-in default, with the `source` labels the error hints are phrased
 *     from - including that a CORRUPT config file throws instead of falling
 *     through to a guess, and that the built-in defaults are EMPTY, so a
 *     launcher that resolves nothing fails with a message;
 *
 * The end-to-end runs (`launch.ps1`, WSLENV, `make-shortcut.ps1 -DryRun`) are
 * `launcher-config-e2e.test.ts`; the host promotion `Move-AiSmHostNext` is
 * `launcher-config-host-next.test.ts` (restructure O6). The batched probe and
 * the spawn helpers are `tests/helpers/launcher-config-fixture.ts`.
 *
 * Everything runs `powershell.exe` through WSL interop against the real
 * scripts. Skipped cleanly wherever `powershell.exe` / `wslpath` are absent
 * (CI's ubuntu runner has no Windows side), so `npm test` stays one command.
 *
 * NOT claimed: a real launch on Windows (the user's Windows check).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  D_DISTRO,
  D_REPO,
  fileCase,
  location,
  LOCATION_INPUTS,
  probe,
  resolved,
  skip,
} from '../helpers/launcher-config-fixture.ts';

// --- Get-AiSmLocationConfig: what derives -----------------------------------

test('Get-AiSmLocationConfig: a \\\\wsl.localhost launcher path states both the distro and the repo', { skip }, async () => {
  const c = await location(0);
  assert.deepEqual(c.result, {
    Distro: 'Ubuntu-22.04',
    RepoPath: '/home/them/ai-cli-application',
    RepoOk: true,
    DistroOk: true,
  });
});

test('Get-AiSmLocationConfig: the legacy \\\\wsl$ prefix derives identically', { skip }, async () => {
  const c = await location(1);
  assert.equal(c.result?.Distro, 'Ubuntu-22.04');
  assert.equal(c.result?.RepoPath, '/home/them/ai-cli-application');
});

test('Get-AiSmLocationConfig: a provider-qualified location is stripped before matching', { skip }, async () => {
  const c = await location(2);
  assert.equal(c.result?.Distro, 'Ubuntu-22.04');
  assert.equal(c.result?.RepoPath, '/home/them/ai-cli-application');
});

test('Get-AiSmLocationConfig: host, provider prefix and the trailing `launcher` folder all match case-insensitively', { skip }, async () => {
  // Windows hands back whatever casing the user typed; the derivation must not
  // depend on it. The DISTRO segment keeps its own casing — it is a name, not a
  // keyword.
  for (const index of [3, 4]) {
    const c = await location(index);
    assert.equal(c.result?.Distro, 'Ubuntu-22.04', `case ${index}`);
    assert.equal(c.result?.RepoPath, '/home/them/ai-cli-application', `case ${index}`);
  }
});

test('Get-AiSmLocationConfig: a trailing backslash does not invent an empty segment', { skip }, async () => {
  const c = await location(5);
  assert.equal(c.result?.RepoPath, '/home/them/ai-cli-application');
});

test('Get-AiSmLocationConfig: a folder that is NOT named `launcher` is kept as the repo', { skip }, async () => {
  // Only a trailing 'launcher' is dropped; anything else is where the caller
  // actually runs from and stays part of the path.
  const c = await location(20);
  assert.equal(c.result?.RepoPath, '/home/them/ai-cli-application');
});

// --- Get-AiSmLocationConfig: what must derive NOTHING ------------------------

test('Get-AiSmLocationConfig: a non-WSL location derives nothing, so the caller keeps its defaults', { skip }, async () => {
  for (const index of [6, 7]) {
    const c = await location(index);
    assert.equal(c.result, null, `${LOCATION_INPUTS[index]} must derive nothing`);
  }
});

test('Get-AiSmLocationConfig: a bare \\\\wsl.localhost\\<distro> states no repo at all -> null', { skip }, async () => {
  const c = await location(8);
  assert.equal(c.result, null);
});

test('Get-AiSmLocationConfig: an empty or absent ScriptRoot derives nothing', { skip }, async () => {
  assert.equal((await location(9)).result, null);
  assert.equal((await location(10)).result, null);
});

test('Get-AiSmLocationConfig: look-alike hosts (wsl.localhost.evil, wsl.localhostx, wsl$evil) derive NOTHING', { skip }, async () => {
  // A prefix match without the trailing separator would let any UNC share the
  // attacker controls name a distro and a repo path. The separator is part of
  // the compared prefix, so these are not WSL paths at all.
  for (const index of [11, 12, 13]) {
    const c = await location(index);
    assert.equal(c.result, null, `${LOCATION_INPUTS[index]} must not look like a WSL path`);
  }
});

// --- verbatim segments: the allow-list is the only gate ----------------------

test('Get-AiSmLocationConfig: a path with spaces comes back VERBATIM and fails the allow-list', { skip }, async () => {
  const c = await location(14);
  assert.equal(c.result?.RepoPath, '/home/a b/my repo');
  assert.equal(c.result?.RepoOk, false, 'a spaced path must be rejected by the caller allow-list');
});

test('Get-AiSmLocationConfig: `$(`, a backtick and `%20` are neither decoded nor escaped', { skip }, async () => {
  // Nothing here unescapes or normalizes; the segments are exactly what Windows
  // reported. Whatever survives has to die on the caller's allow-list — that
  // regex is the injection gate, since these strings reach a WSL command line.
  const dollar = await location(16);
  assert.equal(dollar.result?.RepoPath, '/home/$(whoami)/repo');
  assert.equal(dollar.result?.RepoOk, false);

  const tick = await location(17);
  assert.equal(tick.result?.RepoPath, '/home/a`b/repo');
  assert.equal(tick.result?.RepoOk, false);

  const encoded = await location(18);
  assert.equal(encoded.result?.RepoPath, '/home/a%20b/repo', 'percent-encoding must NOT be decoded');
  assert.equal(encoded.result?.RepoOk, false, '% is outside the allow-list, so the literal form is rejected');
});

test('Get-AiSmLocationConfig: a distro name with a space is returned as-is and fails the distro allow-list', { skip }, async () => {
  const c = await location(21);
  assert.equal(c.result?.Distro, 'Ubuntu 24.04');
  assert.equal(c.result?.DistroOk, false);
});

test('Get-AiSmLocationConfig: `..` survives verbatim AND passes the allow-list (documented limit)', { skip }, async () => {
  // KNOWN, ACCEPTED: '.' is inside the allow-list character class, so a '..'
  // segment is not rejected. It is not a traversal hole — the value describes
  // where the launcher itself already lives, and Windows never reports a real
  // location in that form — but it IS the one shape that gets through, so it is
  // pinned rather than assumed.
  const c = await location(15);
  assert.equal(c.result?.RepoPath, '/home/x/../y');
  assert.equal(c.result?.RepoOk, true);
});

test('Get-AiSmLocationConfig: a `..` DISTRO segment passes the distro allow-list — the installed-distro check is the second gate', { skip }, async () => {
  // '.' is inside the distro allow-list class, so '..' gets through the regex.
  // It is stopped one step later in launch.ps1, which requires the name to be
  // in `wsl.exe -l -q` (exactly, or as a unique prefix) before any `wsl.exe -d`
  // runs. Pinned here because the regex alone does NOT reject it; the
  // membership check is what does, and that half is not exercised by this file
  // (it would need a real wsl.exe call).
  const c = await location(22);
  assert.equal(c.result?.Distro, '..');
  assert.equal(c.result?.DistroOk, true);
  assert.equal(c.result?.RepoPath, '/home/them/repo');
});

test('Get-AiSmLocationConfig: a launcher at the distro ROOT derives `/`, which the allow-list rejects', { skip }, async () => {
  const c = await location(19);
  assert.equal(c.result?.Distro, 'Ubuntu-24.04');
  assert.equal(c.result?.RepoPath, '/');
  assert.equal(c.result?.RepoOk, false, '`/` must never be accepted as a repo path');
});

// --- Resolve-AiSmConfig: precedence + source labels --------------------------

test('Resolve-AiSmConfig: with no env vars, the launcher location wins over the built-in defaults', { skip }, async () => {
  const r = await resolved('derived');
  assert.equal(r.Distro, 'Ubuntu-22.04');
  assert.equal(r.DistroSource, 'launcher location');
  assert.equal(r.RepoPath, '/home/them/ai-cli-application');
  assert.equal(r.RepoPathSource, 'launcher location');
  assert.notEqual(r.RepoPath, D_REPO);
});

test('Resolve-AiSmConfig: only an underivable location falls back to the built-in defaults', { skip }, async () => {
  const r = await resolved('no-derivation');
  assert.deepEqual(
    { d: r.Distro, ds: r.DistroSource, p: r.RepoPath, ps: r.RepoPathSource },
    { d: D_DISTRO, ds: 'built-in default', p: D_REPO, ps: 'built-in default' },
  );
});

test('Resolve-AiSmConfig: AI_SM_DISTRO beats the location, and the repo still derives', { skip }, async () => {
  const r = await resolved('distro-env-wins');
  assert.equal(r.Distro, 'Debian');
  assert.equal(r.DistroSource, 'AI_SM_DISTRO');
  assert.equal(r.RepoPath, '/home/them/ai-cli-application');
  assert.equal(r.RepoPathSource, 'launcher location');
});

test('Resolve-AiSmConfig: AI_SM_REPO_PATH beats the location, and the distro still derives', { skip }, async () => {
  const r = await resolved('repo-env-wins');
  assert.equal(r.RepoPath, '/srv/app');
  assert.equal(r.RepoPathSource, 'AI_SM_REPO_PATH');
  assert.equal(r.Distro, 'Ubuntu-22.04');
  assert.equal(r.DistroSource, 'launcher location');
});

test('Resolve-AiSmConfig: env vars beat the built-in defaults when nothing derives', { skip }, async () => {
  const r = await resolved('both-env-no-derivation');
  assert.deepEqual(
    { d: r.Distro, ds: r.DistroSource, p: r.RepoPath, ps: r.RepoPathSource },
    { d: 'Debian', ds: 'AI_SM_DISTRO', p: '/srv/app', ps: 'AI_SM_REPO_PATH' },
  );
});

test('Resolve-AiSmConfig: an EMPTY env var is ignored, it never blanks the config', { skip }, async () => {
  const derived = await resolved('empty-env-ignored');
  assert.equal(derived.Distro, 'Ubuntu-22.04');
  assert.equal(derived.DistroSource, 'launcher location');
  assert.equal(derived.RepoPath, '/home/them/ai-cli-application');
  assert.equal(derived.RepoPathSource, 'launcher location');

  const fallback = await resolved('empty-env-no-derivation');
  assert.equal(fallback.Distro, D_DISTRO);
  assert.equal(fallback.DistroSource, 'built-in default');
  assert.equal(fallback.RepoPath, D_REPO);
  assert.equal(fallback.RepoPathSource, 'built-in default');
});

// --- launcher-config.json (what the Windows Setup writes) --------------------

test('Get-AiSmFileConfig: the installer config beats the launcher location, and an env var beats both', { skip }, async () => {
  const present = await fileCase('present');
  assert.equal(present.error, null);
  assert.equal(present.distro, 'Deb');
  assert.equal(present.repo, '/srv/app/current');
  // Derivation would have produced Ubuntu-22.04 + /home/them/ai-cli-application.
  assert.deepEqual(
    { d: present.rDistro, ds: present.rDistroSrc, p: present.rRepo, ps: present.rRepoSrc },
    { d: 'Deb', ds: 'config file', p: '/srv/app/current', ps: 'config file' },
  );

  const env = await fileCase('env-wins');
  assert.equal(env.rDistro, 'FromEnv');
  assert.equal(env.rDistroSrc, 'AI_SM_DISTRO');
  assert.equal(env.rRepo, '/srv/app/current', 'the file still supplies what the env does not');
  assert.equal(env.rRepoSrc, 'config file');
});

test('Get-AiSmFileConfig: an installed launcher (no derivable location) reads its config file', { skip }, async () => {
  // The real installed shape: scripts on a plain Windows path, so nothing can
  // be derived and the built-in defaults are empty. Only the file answers.
  const c = await fileCase('no-derivation');
  assert.deepEqual(
    { d: c.rDistro, ds: c.rDistroSrc, p: c.rRepo, ps: c.rRepoSrc },
    { d: 'Deb', ds: 'config file', p: '/srv/app/current', ps: 'config file' },
  );
});

test('Get-AiSmFileConfig: no file at all is not an error - derivation still wins', { skip }, async () => {
  const absent = await fileCase('absent');
  assert.equal(absent.error, null);
  assert.equal(absent.present, false, 'an absent file must resolve to $null, not to an empty config');
  assert.equal(absent.rDistro, 'Ubuntu-22.04');
  assert.equal(absent.rDistroSrc, 'launcher location');
});

test('Get-AiSmFileConfig: a config stating nothing states nothing - it does not blank the config', { skip }, async () => {
  const empty = await fileCase('empty-object');
  assert.equal(empty.error, null);
  assert.equal(empty.distro, null);
  assert.equal(empty.repo, null);
  assert.equal(empty.rDistroSrc, 'launcher location', '{} must fall through, not override');

  const half = await fileCase('only-distro');
  assert.equal(half.error, null);
  assert.equal(half.rDistro, 'Deb');
  assert.equal(half.rDistroSrc, 'config file');
  assert.equal(half.rRepo, '/home/them/ai-cli-application');
  assert.equal(half.rRepoSrc, 'launcher location');
});

test('Get-AiSmFileConfig: keys it does not know are ignored', { skip }, async () => {
  const c = await fileCase('extra-keys');
  assert.equal(c.error, null);
  assert.equal(c.distro, 'Deb');
  assert.equal(c.repo, '/srv/app/current');
});

test('Get-AiSmFileConfig: a config file that cannot be believed THROWS - it never falls through', { skip }, async () => {
  // This is the whole point of the file being an error instead of a hint: an
  // installed launcher whose config is damaged must stop, not quietly start a
  // backend for whatever it can still derive or default to.
  const cases: [string, RegExp][] = [
    ['corrupt', /is not valid JSON/],
    ['non-string', /"distro" must be a non-empty string/],
    ['null-value', /"appPath" must be a non-empty string/],
    ['blank-string', /"appPath" must be a non-empty string/],
    ['json-array', /must contain a JSON object/],
    ['json-scalar', /must contain a JSON object/],
    ['empty-file', /is empty/],
  ];
  for (const [name, reason] of cases) {
    const c = await fileCase(name);
    assert.ok(c.error, `${name}: expected a throw, got distro=${c.distro} repo=${c.repo}`);
    assert.match(c.error, reason, name);
    assert.match(c.error, /re-run the Setup \(or reinstall\)/, `${name}: must say how to fix it`);
    // Resolve-AiSmConfig propagates it rather than answering with a guess.
    assert.ok(c.resolveError, `${name}: Resolve-AiSmConfig must throw too`);
    assert.equal(c.rDistro, null, name);
  }
});

test('Get-AiSmFileConfig: file values are returned verbatim and gated by the SAME allow-list', { skip }, async () => {
  // A hand-edited config file is no way around the injection gate: what it
  // says arrives unchanged and is judged by the same two functions.
  const c = await fileCase('unsafe-values');
  assert.equal(c.error, null);
  assert.equal(c.distro, 'Ubuntu 24');
  assert.equal(c.repo, '/home/a b/app/current');
  assert.equal(c.distroOk, false);
  assert.equal(c.repoOk, false);
});

test('Resolve-AiSmConfig: nothing anywhere resolves to EMPTY, never to a built-in guess', { skip }, async () => {
  const c = await fileCase('nothing-at-all');
  assert.equal(c.error, null);
  assert.equal(c.rDistro, '');
  assert.equal(c.rRepo, '');
  assert.equal(c.rDistroSrc, 'built-in default');
  assert.equal(c.rRepoSrc, 'built-in default');
});

// --- Format-AiSmConfigLine ---------------------------------------------------

test('Format-AiSmConfigLine: one shared source collapses into a single `(from …)`', { skip }, async () => {
  assert.equal(
    (await resolved('derived')).line,
    "Config: distro 'Ubuntu-22.04', repo '/home/them/ai-cli-application' (from launcher location)",
  );
  assert.equal(
    (await resolved('no-derivation')).line,
    `Config: distro '${D_DISTRO}', repo '${D_REPO}' (from built-in default)`,
  );
});

test('Format-AiSmConfigLine: mixed sources are named per value', { skip }, async () => {
  assert.equal(
    (await resolved('distro-env-wins')).line,
    "Config: distro 'Debian' (from AI_SM_DISTRO), repo '/home/them/ai-cli-application' (from launcher location)",
  );
  assert.equal(
    (await resolved('repo-env-wins')).line,
    "Config: distro 'Ubuntu-22.04' (from launcher location), repo '/srv/app' (from AI_SM_REPO_PATH)",
  );
});

// --- Get-AiSmConfigHint ------------------------------------------------------

test('Get-AiSmConfigHint: the advice is phrased for where the bad value actually came from', { skip }, async () => {
  const { hint } = await probe();
  const text = (source: string, kind: string) => {
    const h = hint.find((x) => x.source === source && x.kind === kind);
    assert.ok(h, `no hint for ${source}/${kind}`);
    return h.text;
  };

  const derivedRepo = text('launcher location', 'RepoPath');
  assert.match(derivedRepo, /derived from where the launcher itself lives/);
  // The override is NOT an escape hatch: it passes the same allow-list, so the
  // hint must point at re-cloning rather than at AI_SM_REPO_PATH.
  assert.match(derivedRepo, /Clone the repo into a path built only from letters, digits/);
  assert.match(derivedRepo, /Setting AI_SM_REPO_PATH is no way around this/);
  assert.doesNotMatch(derivedRepo, /Edit the defaults/, 'editing a default cannot fix a derived value');

  const derivedDistro = text('launcher location', 'Distro');
  assert.match(derivedDistro, /distro name was derived from where the launcher itself lives/);
  assert.match(derivedDistro, /wsl\.exe -l -q lists them/);
  assert.match(derivedDistro, /AI_SM_DISTRO is checked against exactly the same character set/);

  assert.equal(text('AI_SM_REPO_PATH', 'RepoPath'), 'Fix or unset the AI_SM_REPO_PATH environment variable.');
  assert.equal(text('AI_SM_DISTRO', 'Distro'), 'Fix or unset the AI_SM_DISTRO environment variable.');

  // The built-in defaults are EMPTY now, so "edit the default" is no longer
  // advice anyone can act on: the two real fixes are an env var or a proper
  // installation.
  assert.equal(
    text('built-in default', 'RepoPath'),
    'Set AI_SM_REPO_PATH, or run the launcher from inside its own installation (the Setup writes launcher-config.json next to these scripts).',
  );
  assert.equal(
    text('built-in default', 'Distro'),
    'Set AI_SM_DISTRO, or run the launcher from inside its own installation (the Setup writes launcher-config.json next to these scripts).',
  );

  // A value that came from the installer's own config file: neither
  // re-cloning nor an env var is the point, re-running the Setup is.
  const configRepo = text('config file', 'RepoPath');
  assert.match(configRepo, /This path comes from "appPath" in launcher-config\.json next to the launcher\./);
  assert.match(configRepo, /re-run the Setup \(or reinstall\)/);
  const configDistro = text('config file', 'Distro');
  assert.match(configDistro, /This distro name comes from "distro" in launcher-config\.json next to the launcher\./);
  assert.match(configDistro, /re-run the Setup \(or reinstall\)/);
});
