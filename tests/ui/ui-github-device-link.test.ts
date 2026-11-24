/**
 * The connecting card's address (2026-11-24, user: "is het mogelijk om die
 * link dat je daarop klikt en een browser opent?"): `github.com/login/device`
 * is a button that opens GitHub's fixed device page in the user's own browser
 * through the one sanctioned door (`openExternal`, a real click, `_blank`,
 * `noopener`), and puts the shown code on the clipboard so it only needs a
 * paste. The page opened is the app's constant, never the server's
 * `verificationUri` text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { byClass, installDom, type FakeElement } from '../helpers/fake-dom.ts';
import { drainMicrotasks } from '../helpers/helpers.ts';

const dom = installDom();

const STUB_SRC: Record<string, string> = {
  api: `
    export class ApiError extends Error {
      constructor(status, message) { super(message); this.status = status; }
    }
    export async function fsList() { return { path: '/home/you', dirs: [], empty: false }; }
    export async function githubStatus() {
      return { deviceFlowAvailable: true, state: 'connecting', userCode: 'WDJB-MJHT',
        verificationUri: 'https://evil.example/login/device',
        expiresAt: new Date(Date.now() + 600000).toISOString() };
    }
    export async function githubDevice() { throw new Error('not used'); }
    export async function githubDisconnect() { throw new Error('not used'); }
    export async function githubRepos() { return { repos: [] }; }
    export async function githubToken() { throw new Error('not used'); }
    export async function githubClone() { throw new Error('not used'); }
    export async function githubCreateRepo() { throw new Error('not used'); }`,
  state: `
    export const state = { projects: [], sessions: new Map() };
    export function setProjects() {}`,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? '';
    const mine = /\/web\/src\/ui\/github(-state|-token|-newrepo)?\.ts$/.test(parent);
    if (mine) {
      const m = /^\.\.\/(api|state)\.ts$/.exec(specifier);
      if (m !== null) return { url: `gh-device-stub:${m[1] as string}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('gh-device-stub:')) {
      const name = url.slice('gh-device-stub:'.length);
      return { format: 'module', source: STUB_SRC[name], shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});


const opened: Array<{ url: string; target: string; features: string }> = [];
const copied: string[] = [];
const g = globalThis as unknown as Record<string, unknown>;
const win = (g['window'] ?? g) as Record<string, unknown>;
win['open'] = (url: string, target: string, features: string) => {
  opened.push({ url, target, features });
  return null;
};
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { clipboard: { writeText: (t: string) => { copied.push(t); return Promise.resolve(); } } },
});

interface GithubModule {
  createGithubPanel(): { el: FakeElement; setActive(active: boolean): void };
  GITHUB_DEVICE_URL: string;
}
const GH = (await import(new URL('../../web/src/ui/github.ts', import.meta.url).href)) as GithubModule;
const panel = GH.createGithubPanel();
dom.body.append(panel.el);

test('the address is a button: one click opens GitHub\'s device page in the browser and copies the code', async () => {
  panel.setActive(true);
  await drainMicrotasks(6);
  const link = byClass(panel.el, 'gh-uri')[0];
  assert.ok(link !== undefined, 'the connecting card shows the address');
  assert.equal(link.tagName, 'BUTTON', 'a button — the host drops an <a href>');
  assert.equal(byClass(panel.el, 'gh-code')[0]?.textContent, 'WDJB-MJHT');
  link.click();
  await drainMicrotasks(2);
  assert.deepEqual(opened, [{ url: 'https://github.com/login/device', target: '_blank', features: 'noopener,noreferrer' }],
    "the app's own constant, never the server's verificationUri text");
  assert.equal(GH.GITHUB_DEVICE_URL, 'https://github.com/login/device');
  assert.deepEqual(copied, ['WDJB-MJHT'], 'the code is on the clipboard, ready to paste');
});
