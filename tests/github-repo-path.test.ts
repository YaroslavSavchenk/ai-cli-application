/**
 * `parseGithubRepoPath` (server/github.ts) — the owner/repo splitter behind the
 * owner-qualified clone decision (2026-07-25).
 *
 * It is exported and load-bearing in TWO places, and until this file it had no
 * direct test at all — only indirect coverage through the clone route, which
 * exercises a handful of well-formed urls:
 *
 *   1. `cloneAuthenticated` step 3b compares its `owner` against an existing
 *      path segment before creating ONE directory. A wrong answer here widens
 *      a filesystem-writing allowance.
 *   2. `server/api.ts` builds the display name `<owner>/<repo>` from it, which
 *      lands verbatim in projects.json.
 *
 * Neither use ever CONSTRUCTS a path from these strings (the dest is supplied
 * by the caller and validated separately), which is why raw, never-decoded
 * segments are safe — but the parser's refusals are what keeps it that way, so
 * they are pinned here one by one rather than assumed.
 *
 * Pure function, no server, no filesystem, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGithubRepoPath } from '../server/github.ts';

test('parseGithubRepoPath: the shapes the GitHub panel actually sends', () => {
  assert.deepEqual(parseGithubRepoPath('https://github.com/acme/api.git'), {
    owner: 'acme',
    repo: 'api',
  });
  assert.deepEqual(parseGithubRepoPath('https://github.com/acme/api'), {
    owner: 'acme',
    repo: 'api',
  });
  assert.deepEqual(parseGithubRepoPath('https://github.com/acme/api/'), {
    owner: 'acme',
    repo: 'api',
  });
});

test('parseGithubRepoPath: the `.git` suffix strip is CASE-INSENSITIVE and only applies at the end', () => {
  assert.deepEqual(parseGithubRepoPath('https://github.com/acme/api.GIT'), {
    owner: 'acme',
    repo: 'api',
  });
  assert.deepEqual(parseGithubRepoPath('https://github.com/acme/api.Git'), {
    owner: 'acme',
    repo: 'api',
  });
  // Interior ".git" is part of the name — a repo really can be called this.
  assert.deepEqual(parseGithubRepoPath('https://github.com/acme/api.github.io'), {
    owner: 'acme',
    repo: 'api.github.io',
  });
  // Only ONE suffix is stripped: `x.git.git` is a repo literally named `x.git`.
  assert.deepEqual(parseGithubRepoPath('https://github.com/acme/x.git.git'), {
    owner: 'acme',
    repo: 'x.git',
  });
  // A repo named exactly `.git` would strip to empty -> refused, never ''.
  assert.equal(parseGithubRepoPath('https://github.com/acme/.git'), undefined);
});

test('parseGithubRepoPath: OWNER CASE is preserved verbatim (the case-folding lives in the comparison, not here)', () => {
  // step 3b compares case-insensitively; the NAME written to projects.json must
  // still read the way GitHub spells it.
  assert.deepEqual(parseGithubRepoPath('https://github.com/OctoCat/Hello-World.git'), {
    owner: 'OctoCat',
    repo: 'Hello-World',
  });
});

test('parseGithubRepoPath: exactly TWO path segments — one or three is undefined', () => {
  assert.equal(parseGithubRepoPath('https://github.com/acme'), undefined, 'owner only');
  assert.equal(parseGithubRepoPath('https://github.com/'), undefined, 'no segments');
  assert.equal(parseGithubRepoPath('https://github.com'), undefined, 'no path at all');
  assert.equal(parseGithubRepoPath('https://github.com/acme/api/extra'), undefined, 'too deep');
  // Empty segments are filtered before counting, so doubled slashes still parse.
  assert.deepEqual(parseGithubRepoPath('https://github.com//acme//api'), {
    owner: 'acme',
    repo: 'api',
  });
});

test('parseGithubRepoPath: a `.`/`..` segment NEVER comes out — plain or percent-encoded', () => {
  // What actually happens is stronger than the source comment claims: WHATWG
  // URL treats `.`, `..`, `%2e` and `%2E` as dot segments and normalizes them
  // away BEFORE parseGithubRepoPath sees a path, so a traversal token cannot be
  // expressed at all — the url simply ends up with the wrong segment count.
  // The explicit `s === '.' || s === '..'` refusal in the source is therefore
  // belt-and-braces; this test pins the OUTCOME (never a dot segment, never a
  // wrong owner), which holds whichever layer enforces it.
  for (const u of [
    'https://github.com/./api',
    'https://github.com/acme/.',
    'https://github.com/../api',
    'https://github.com/acme/..',
    'https://github.com/a/b/../..',
    'https://github.com/%2e%2e/api',
    'https://github.com/acme/%2e%2e',
    'https://github.com/%2E/api',
  ]) {
    const got = parseGithubRepoPath(u);
    if (got === undefined) continue;
    for (const s of [got.owner, got.repo]) {
      assert.notEqual(s, '.', u);
      assert.notEqual(s, '..', u);
      assert.notEqual(s, '%2e%2e', u);
    }
  }
  // Spot-check the concrete answers so a future URL-parser change is loud.
  assert.equal(parseGithubRepoPath('https://github.com/%2e%2e/api'), undefined, 'normalized to /api');
  assert.equal(parseGithubRepoPath('https://github.com/acme/..'), undefined, 'normalized to /');
});

test('parseGithubRepoPath: what survives normalization is taken RAW — never percent-decoded', () => {
  // %2F is the one that matters: decoded it would be a path separator, and this
  // string becomes a project NAME in projects.json. It must stay one segment.
  assert.deepEqual(parseGithubRepoPath('https://github.com/acme/a%2Fb'), {
    owner: 'acme',
    repo: 'a%2Fb',
  });
  assert.deepEqual(parseGithubRepoPath('https://github.com/%2E%2E%2F/api'), {
    owner: '%2E%2E%2F',
    repo: 'api',
  });
  // Dots inside a segment are ordinary characters, not dot segments.
  assert.deepEqual(parseGithubRepoPath('https://github.com/acme/a%2e%2eb'), {
    owner: 'acme',
    repo: 'a%2e%2eb',
  });
  assert.deepEqual(parseGithubRepoPath('https://github.com/acme/sp%20ace'), {
    owner: 'acme',
    repo: 'sp%20ace',
  });
});

test('parseGithubRepoPath: host and scheme are locked to https + exactly github.com', () => {
  for (const u of [
    'http://github.com/acme/api.git',
    'ssh://github.com/acme/api.git',
    'git://github.com/acme/api.git',
    'https://gitlab.com/acme/api.git',
    'https://evil.com/acme/api.git',
    'https://github.com.evil.com/acme/api.git',
    'https://raw.github.com/acme/api.git',
    'https://api.github.com/acme/api.git',
  ]) {
    assert.equal(parseGithubRepoPath(u), undefined, u);
  }
  // Host case is normalized by the URL parser, so this one IS github.com.
  assert.deepEqual(parseGithubRepoPath('https://GitHub.COM/acme/api.git'), {
    owner: 'acme',
    repo: 'api',
  });
});

test('parseGithubRepoPath: query and fragment do not disturb the two segments', () => {
  assert.deepEqual(parseGithubRepoPath('https://github.com/acme/api.git?x=1#frag'), {
    owner: 'acme',
    repo: 'api',
  });
  // `:443` is not a port at all after WHATWG normalization (it is https's
  // default and is dropped), so this url IS the plain github.com origin.
  assert.deepEqual(parseGithubRepoPath('https://github.com:443/acme/api.git'), {
    owner: 'acme',
    repo: 'api',
  });
});

test('parseGithubRepoPath: a non-default PORT or embedded CREDENTIALS are refused — host-lock parity with the clone-url validator', () => {
  // The function is exported and its docstring implies the same host lock
  // #buildAuthenticatedGithubUrl enforces. That validator rejects both of these;
  // this one used to accept them, which a future caller running BEFORE the
  // strict validator would have inherited as a hole.
  for (const u of [
    'https://github.com:8443/acme/api.git',
    'https://github.com:80/acme/api.git',
    'https://user:pw@github.com/acme/api.git',
    'https://user@github.com/acme/api.git',
    'https://:pw@github.com/acme/api.git',
    'https://user:pw@github.com:8443/acme/api.git',
  ]) {
    assert.equal(parseGithubRepoPath(u), undefined, u);
  }
});

test('parseGithubRepoPath: garbage input returns undefined instead of throwing', () => {
  for (const u of ['', 'not a url', '/acme/api', 'github.com/acme/api', 'javascript:alert(1)']) {
    assert.equal(parseGithubRepoPath(u), undefined, JSON.stringify(u));
  }
});
