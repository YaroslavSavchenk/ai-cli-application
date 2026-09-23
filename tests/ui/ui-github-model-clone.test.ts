/**
 * `web/src/ui/github-model.ts` — the pure presentation logic extracted from
 * `ui/github.ts`. DOM-free by construction, so `node --test` imports it
 * directly (same split as theme-model / newproject-model); fixtures (a fixed
 * `now`, repo and project builders) in `tests/helpers/ui-github-model-fixture.ts`.
 * This file: the clone destination (`defaultDest`, `ownerDest`), already-cloned
 * detection (`clonedProject`, its tiers and residual limits), the clone-error
 * copy, and the cross-module agreement with the New Project suggestions.
 * Split from `tests/ui/ui-github-model.test.ts`.
 *
 * Why: if the destination and the detection drift apart, a repo already
 * cloned offers `clone` again and the server answers 409 for the existing
 * folder; an owner-blind match marks another owner's repo as cloned.
 *
 * NOT claimed: the server's own owner-directory rules and the real clone
 * (`tests/server/`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  clonedProject,
  cloneErrText,
  defaultDest,
  ownerDest,
} from '../../web/src/ui/github-model.ts';
import {
  repoBasename,
  suggestDestPath,
  suggestProjectPath,
} from '../../web/src/ui/newproject-model.ts';
import { type Project } from '../../shared/protocol.ts';
import { repo, project } from '../helpers/ui-github-model-fixture.ts';

// ---------------------------------------------------------------------------
// defaultDest / ownerDest / clonedProject
// ---------------------------------------------------------------------------

test('defaultDest: <home>/projects/<name>, with a trailing slash on home tolerated', () => {
  assert.equal(defaultDest('/home/you', 'ai-cli-application'), '/home/you/projects/ai-cli-application');
  assert.equal(defaultDest('/home/you/', 'x'), '/home/you/projects/x');
  assert.equal(defaultDest('/', 'x'), '/projects/x');
});

test('ownerDest: <home>/projects/<owner>/<repo> — the destination every app clone now uses', () => {
  assert.equal(ownerDest('/home/you', 'acme', 'api'), '/home/you/projects/acme/api');
  assert.equal(ownerDest('/home/you/', 'acme', 'api'), '/home/you/projects/acme/api', 'trailing slash');
  assert.equal(ownerDest('/', 'acme', 'api'), '/projects/acme/api', 'root home');
});

test('ownerDest: the SAME repo name under two owners produces two different destinations', () => {
  // This is the whole point of the 2026-07-25 decision: the old shared
  // <home>/projects/api made the second clone 409 and mis-resolve to the first.
  assert.notEqual(ownerDest('/home/you', 'acme', 'api'), ownerDest('/home/you', 'myorg', 'api'));
  assert.equal(ownerDest('/home/you', 'acme', 'api'), '/home/you/projects/acme/api');
  assert.equal(ownerDest('/home/you', 'myorg', 'api'), '/home/you/projects/myorg/api');
});

test('ownerDest: its owner segment is the ONLY difference from the legacy defaultDest', () => {
  // Pins the two conventions against silent drift: same home, same leaf.
  assert.equal(ownerDest('/home/you', 'acme', 'api'), `${defaultDest('/home/you', 'acme')}/api`);
});

test('clonedProject: no local projects at all → null (the row offers clone)', () => {
  assert.equal(clonedProject(repo(), '/home/you', []), null);
});

test('clonedProject: matches by NAME even before home resolves (home null)', () => {
  const p = project({ path: '/somewhere/else/entirely' });
  assert.equal(clonedProject(repo(), null, [p]), p);
});

test('clonedProject: matches by the LEGACY clone path when the name differs', () => {
  const p = project({ id: 'p2', name: 'renamed-locally' });
  assert.equal(clonedProject(repo(), '/home/you', [p]), p);
});

test('clonedProject: an app clone at the OWNER-QUALIFIED path is matched, and needs no home', () => {
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  const p = project({ id: 'p-owner', name: 'api', path: ownerDest('/home/you', 'acme', 'api') });
  assert.equal(clonedProject(r, '/home/you', [p]), p);
  assert.equal(clonedProject(r, null, [p]), p, 'path-tail matching does not depend on home');
});

test('clonedProject: the owner-qualified path tail wins over a bare-named LEGACY project', () => {
  const legacy = project({ id: 'legacy', name: 'api', path: '/home/you/projects/api' });
  const owned = project({ id: 'owned', name: 'my api', path: '/home/you/projects/myorg/api' });
  const r = repo({ fullName: 'myorg/api', name: 'api', owner: 'myorg' });
  assert.equal(clonedProject(r, '/home/you', [legacy, owned]), owned, 'tail match is checked FIRST');
});

test('clonedProject: a path tail under a DIFFERENT owner is never a match (segment-exact)', () => {
  const other = project({ id: 'other', name: 'x', path: '/home/you/projects/myorg/api' });
  const suffix = project({ id: 'suffix', name: 'y', path: '/home/you/projects/notacme/api' });
  const deeper = project({ id: 'deeper', name: 'z', path: '/home/you/projects/acme/api/sub' });
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  assert.equal(clonedProject(r, '/home/you', [other, suffix, deeper]), null);
});

test('clonedProject: the OWNER segment matches case-insensitively — the same rule the server applies', () => {
  // server/github.ts compares the dest's parent basename to the url owner with
  // toLowerCase(), so `<projects>/Acme/api` is a folder it would accept (and
  // then refuse to clone into again, 409). A case-SENSITIVE client would keep
  // offering `clone` for it. The repo segment stays exact — it is a real
  // filesystem name, and the server's vacancy check is exact.
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  const upper = project({ id: 'p-upper', name: 'x', path: '/home/you/projects/Acme/api' });
  assert.equal(clonedProject(r, '/home/you', [upper]), upper, 'owner case is ignored');
  const mixed = repo({ fullName: 'AcMe/api', name: 'api', owner: 'AcMe' });
  const lower = project({ id: 'p-lower', name: 'y', path: '/home/you/projects/acme/api' });
  assert.equal(clonedProject(mixed, '/home/you', [lower]), lower, 'in both directions');
  // The repo segment is NOT case-folded.
  const upperRepo = project({ id: 'p-repo', name: 'z', path: '/home/you/projects/acme/API' });
  assert.equal(clonedProject(r, '/home/you', [upperRepo]), null, 'a different repo folder is not ours');
});

test('clonedProject: a trailing slash on a stored path does not break the tail match', () => {
  const p = project({ id: 'slash', name: 'x', path: '/home/you/projects/acme/api/' });
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  assert.equal(clonedProject(r, '/home/you', [p]), p);
});

test('clonedProject: a hand-placed checkout following the same convention is matched too', () => {
  // /srv/src/<owner>/<repo> is the same owner-qualified shape, just not under
  // <home>/projects — the tail match is deliberately home-independent.
  const p = project({ id: 'srv', name: 'work api', path: '/srv/src/acme/api' });
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  assert.equal(clonedProject(r, '/home/you', [p]), p);
});

test('clonedProject: a path-only match needs home — without it the row still offers clone', () => {
  const p = project({ id: 'p2', name: 'renamed-locally' });
  assert.equal(clonedProject(repo(), null, [p]), null);
});

test('clonedProject: a project elsewhere with a different name is NOT a match', () => {
  const p = project({ id: 'p3', name: 'unrelated', path: '/home/you/work/unrelated' });
  assert.equal(clonedProject(repo(), '/home/you', [p]), null);
});

test('clonedProject: the FIRST match in project order wins', () => {
  const byName = project({ id: 'first', name: 'ai-cli-application', path: '/opt/checkout' });
  const byPath = project({ id: 'second', name: 'other' });
  assert.equal(clonedProject(repo(), '/home/you', [byName, byPath]), byName);
});

test('clonedProject: an OWNER-QUALIFIED project (named `<owner>/<name>`) wins over a bare-name one', () => {
  // GET /user/repos also returns repos you only collaborate on, so one list can
  // hold acme/api AND myorg/api. A user who disambiguates by naming the project
  // `<owner>/<name>` must get THAT project for THAT repo — never the other one.
  const acme = project({ id: 'acme', name: 'acme/api', path: '/home/you/work/acme-api' });
  const myorg = project({ id: 'myorg', name: 'myorg/api', path: '/home/you/work/myorg-api' });
  const bare = project({ id: 'bare', name: 'api', path: '/home/you/projects/api' });
  const acmeRepo = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  const myorgRepo = repo({ fullName: 'myorg/api', name: 'api', owner: 'myorg' });

  assert.equal(clonedProject(acmeRepo, '/home/you', [bare, acme, myorg]), acme);
  assert.equal(clonedProject(myorgRepo, '/home/you', [bare, acme, myorg]), myorg);
  assert.equal(
    clonedProject(acmeRepo, null, [bare, acme]),
    acme,
    'owner-qualified matching needs no home',
  );
});

test('clonedProject: the bare-name fallback applies only when NO owner-qualified project exists', () => {
  const bare = project({ id: 'bare', name: 'api', path: '/home/you/projects/api' });
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  assert.equal(clonedProject(r, '/home/you', [bare]), bare, 'no `acme/api` project → fall back');
});

test('two same-basename repos from different owners are BOTH cloneable and each identified correctly', () => {
  // WAS A `KNOWN LIMIT` TEST (pinning the mis-identification recorded as an open
  // decision on 2026-07-24). The user settled it on 2026-07-25 with
  // owner-qualified clone paths, so this is now real behaviour:
  // <home>/projects/<owner>/<repo> per clone, and clonedProject resolves each
  // GitHub row to ITS OWN project — never the other owner's folder.
  const home = '/home/you';
  const acmeRepo = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  const myorgRepo = repo({ fullName: 'myorg/api', name: 'api', owner: 'myorg' });

  // Before either clone, both rows offer `clone`.
  assert.equal(clonedProject(acmeRepo, home, []), null);
  assert.equal(clonedProject(myorgRepo, home, []), null);

  // Clone #1 (acme/api): destination + registered name exactly as the flow does
  // it — dest = ownerDest, name = repo basename while it is still free.
  const acmeProject: Project = {
    id: 'p-acme',
    name: 'api',
    path: ownerDest(home, 'acme', 'api'),
    createdAt: '2026-07-25T10:00:00.000Z',
  };
  assert.equal(acmeProject.path, '/home/you/projects/acme/api');
  assert.equal(clonedProject(acmeRepo, home, [acmeProject]), acmeProject, 'acme row → its own clone');
  assert.equal(
    clonedProject(myorgRepo, home, [acmeProject]),
    null,
    'the myorg row must still offer clone — NOT open acme’s folder (the old bug)',
  );

  // Clone #2 (myorg/api): a DIFFERENT directory (no 409), and because the name
  // "api" is now taken the server registers it owner-qualified.
  const myorgProject: Project = {
    id: 'p-myorg',
    name: 'myorg/api',
    path: ownerDest(home, 'myorg', 'api'),
    createdAt: '2026-07-25T10:05:00.000Z',
  };
  assert.notEqual(myorgProject.path, acmeProject.path, 'two directories, so no collision to 409 on');

  const both = [acmeProject, myorgProject];
  assert.equal(clonedProject(acmeRepo, home, both), acmeProject);
  assert.equal(clonedProject(myorgRepo, home, both), myorgProject);
  // Order-independent (the list arrives in GitHub's push order, not ours).
  assert.equal(clonedProject(acmeRepo, home, [...both].reverse()), acmeProject);
  assert.equal(clonedProject(myorgRepo, home, [...both].reverse()), myorgProject);
  // And before $HOME resolves, too.
  assert.equal(clonedProject(acmeRepo, null, both), acmeProject);
  assert.equal(clonedProject(myorgRepo, null, both), myorgProject);
});

test('clonedProject: another owner’s app clone is excluded from the owner-blind tier even when it holds the bare name', () => {
  // The first of two same-basename clones legitimately registers as `api` (the
  // name was free), so the bare-NAME tier would otherwise return it for the
  // OTHER owner's row. Its path says whose it is, and that wins.
  const home = '/home/you';
  const acme = project({ id: 'p-acme', name: 'api', path: ownerDest(home, 'acme', 'api') });
  const myorgRepo = repo({ fullName: 'myorg/api', name: 'api', owner: 'myorg' });
  assert.equal(clonedProject(myorgRepo, home, [acme]), null, 'offers clone, not acme’s folder');
  // The exclusion is EXACT: only `<home>/projects/<other>/<repo>` is excluded.
  const elsewhere = project({ id: 'p-else', name: 'api', path: '/home/you/dev/checkouts/api' });
  assert.equal(
    clonedProject(myorgRepo, home, [elsewhere]),
    elsewhere,
    'an ordinary local folder named after the repo still matches by name',
  );
  const deeper = project({ id: 'p-deep', name: 'api', path: ownerDest(home, 'acme', 'api') + '/sub' });
  assert.equal(clonedProject(myorgRepo, home, [deeper]), deeper, 'deeper than our convention → not ours');
});

test('clonedProject: RESIDUAL LIMIT — before $HOME resolves the owner-blind tier is unguarded', () => {
  // The exclusion above compares against <home>/projects, so with home still
  // null a bare-named clone of another owner can satisfy a row for one repaint.
  // github.ts resolves home on tab open and rebuilds the list when it lands, and
  // the server's dest/409 rules are owner-qualified regardless.
  const acme = project({ id: 'p-acme', name: 'api', path: '/home/you/projects/acme/api' });
  const myorgRepo = repo({ fullName: 'myorg/api', name: 'api', owner: 'myorg' });
  assert.equal(clonedProject(myorgRepo, null, [acme]), acme, 'transient, home-null only');
  assert.equal(clonedProject(myorgRepo, '/home/you', [acme]), null, 'corrected as soon as home is known');
});

test('clonedProject: a LEGACY bare clone (pre-2026-07-25) is still recognized — existing users keep working', () => {
  // What the flow produced BEFORE owner-qualified paths: name = repo basename at
  // <home>/projects/<repo>. Recognized by the fallback tier, by name and by path.
  const home = '/home/you';
  const legacy: Project = {
    id: 'p-legacy',
    name: 'api',
    path: defaultDest(home, 'api'),
    createdAt: '2026-07-20T00:00:00.000Z',
  };
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  assert.equal(clonedProject(r, home, [legacy]), legacy, 'by bare name');
  const renamed: Project = { ...legacy, name: 'renamed after cloning' };
  assert.equal(
    clonedProject(r, home, [renamed]),
    renamed,
    'and by the legacy path even after a local rename',
  );
});

test('clonedProject: RESIDUAL LIMIT — the LEGACY fallback tier is still owner-blind', () => {
  // Unchanged by the 2026-07-25 fix and deliberately still pinned: a Project
  // records no remote (shared/protocol.ts is id/name/path), so a project created
  // BEFORE owner-qualified paths carries no owner evidence at all. A foreign repo
  // whose basename collides with such a project still resolves to it.
  // NEW clones no longer join that set — their path carries the owner.
  const r = repo({ fullName: 'someoneelse/ai-cli-application', owner: 'someoneelse' });
  const legacyBare = project(); // name/path from before the change
  assert.equal(
    clonedProject(r, '/home/you', [legacyBare]),
    legacyBare,
    'indistinguishable from the pre-change clone of the same basename',
  );
  // The moment the SAME repo is cloned owner-qualified, the ambiguity is gone.
  const owned = project({
    id: 'owned',
    name: 'someoneelse/ai-cli-application',
    path: ownerDest('/home/you', 'someoneelse', 'ai-cli-application'),
  });
  assert.equal(clonedProject(r, '/home/you', [legacyBare, owned]), owned);
  assert.equal(
    clonedProject(repo(), '/home/you', [legacyBare, owned]),
    legacyBare,
    'and sava/ai-cli-application still resolves to the legacy project, not someoneelse’s',
  );
});

// ---------------------------------------------------------------------------
// cloneErrText
// ---------------------------------------------------------------------------

test('cloneErrText: a real server message is preferred over any friendly fallback', () => {
  assert.equal(cloneErrText(409, 'dest exists and is not empty'), 'dest exists and is not empty');
  assert.equal(cloneErrText(502, 'git exited with code 128'), 'git exited with code 128');
  assert.equal(cloneErrText(400, 'cloneUrl host must be github.com'), 'cloneUrl host must be github.com');
});

test('cloneErrText: a bare `HTTP 409` (no body) becomes the folder-exists copy', () => {
  assert.equal(cloneErrText(409, 'HTTP 409'), 'a folder already exists there');
});

test('cloneErrText: a bare `HTTP 502` (no body) becomes the clone-failed copy', () => {
  assert.equal(cloneErrText(502, 'HTTP 502'), 'clone failed');
});

test('cloneErrText: a bare `HTTP 403` (no body) becomes the permission copy — the status the owner-directory mkdir can now fail with', () => {
  assert.equal(cloneErrText(403, 'HTTP 403'), 'no permission to create that folder');
  // A 403 that DOES carry a server message still shows that message verbatim.
  assert.equal(cloneErrText(403, 'permission denied'), 'permission denied');
});

test('cloneErrText: other bare statuses keep the raw `HTTP <n>` (never an invented cause)', () => {
  for (const s of [400, 401, 404, 422, 500]) {
    assert.equal(cloneErrText(s, `HTTP ${s}`), `HTTP ${s}`);
  }
});

test('cloneErrText: the `HTTP <n>` test is status-matched — a mismatched body is a real message', () => {
  assert.equal(cloneErrText(409, 'HTTP 502'), 'HTTP 502', 'body from a different status passes through');
});

// ---------------------------------------------------------------------------
// CROSS-MODULE: the three <home>/projects/<name> call sites must agree
//
// github-model.defaultDest, newproject-model.suggestProjectPath and
// newproject-model.suggestDestPath now share one projectsPath helper, and the
// already-cloned detection above compares a stored project path against
// defaultDest. If any of the three ever drifts, a repo cloned through the URL
// panel stops being recognized in the GitHub list (its row would offer `clone`
// again and the server would answer 409 for the existing folder). Nothing
// asserted that agreement across the two modules before this test.
// ---------------------------------------------------------------------------

test('defaultDest agrees BYTE-FOR-BYTE with both New Project suggestions (one <home>/projects convention)', () => {
  const cases: [string, string][] = [
    ['/home/you', 'api'],
    ['/home/you/', 'api'], // trailing slash on home
    ['/', 'api'], // root home
    ['/home/you', 'name with spaces'],
    ['/home/you', '.dotted'],
  ];
  for (const [home, name] of cases) {
    const dest = defaultDest(home, name);
    assert.equal(suggestProjectPath(home, name), dest, `blank-project suggestion for ${home} + ${name}`);
    assert.equal(
      suggestDestPath(home, `https://github.com/acme/${name}.git`),
      dest,
      `url-clone suggestion for ${home} + ${name}`,
    );
  }
});

test('a repo cloned through the URL panel is detected in the GitHub list (both flows land on one path)', () => {
  // The URL-clone path the New Project dialog proposes (newproject.ts:283) and
  // the name the server registers for it (server/api.ts: repoNameFromUrl(url)
  // -> the bare basename) — the GitHub list must recognize THAT project.
  const home = '/home/you';
  const url = 'https://github.com/acme/api.git';
  const urlCloned: Project = {
    id: 'p-url',
    name: repoBasename(url),
    path: suggestDestPath(home, url),
    createdAt: '2026-07-24T00:00:00.000Z',
  };
  assert.equal(urlCloned.path, '/home/you/projects/api', 'the url flow lands in <home>/projects/<basename>');
  const r = repo({ fullName: 'acme/api', name: 'api', owner: 'acme' });
  assert.equal(clonedProject(r, home, [urlCloned]), urlCloned, 'the row must offer `open`, not a 409 `clone`');
  // And by PATH alone, i.e. even if the project was renamed after cloning.
  const renamed: Project = { ...urlCloned, name: 'my api checkout' };
  assert.equal(clonedProject(r, home, [renamed]), renamed, 'path match survives a local rename');
});
