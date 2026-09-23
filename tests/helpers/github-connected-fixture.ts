/**
 * The shared stub of the `tests/server/github-connected*.test.ts` files — the
 * CONNECTED GitHub HTTP surface, exercised OFFLINE.
 *
 * `StubApi` is a local node:http server standing in for the GitHub REST API
 * (reached through the loopback-only AI_SM_GITHUB_API_BASE); `rawRepo` one raw
 * repo payload of which only the mapped subset may reach the browser;
 * `seedConnectedDataDir` a data dir with a pre-seeded github.json (StoredToken
 * shape, 0600) so a freshly booted server starts CONNECTED; `SECRET` the fake
 * token every assertion treats as a real credential.
 *
 * Moved here out of `tests/server/github-connected.test.ts` when it was split
 * by topic (PLAN-RESTRUCTURE O6); the code is unchanged.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from './helpers.ts';

/** Fake token: never a real credential, but treated as one by every assertion. */
export const SECRET = 'gho_STUB_ONLY_NEVER_A_REAL_TOKEN';
export const CLIENT_ID = 'Iv1.stubclientid';

// ---------------------------------------------------------------------------
// Local stub for the GitHub REST API (node:http, no new deps)
// ---------------------------------------------------------------------------

export interface StubRequest {
  method: string;
  /** Full request target incl. query, e.g. /user/repos?per_page=100&sort=pushed&page=1 */
  path: string;
  authorization: string | undefined;
  accept: string | undefined;
  userAgent: string | undefined;
  apiVersion: string | undefined;
  contentType: string | undefined;
  body: string;
}

export interface StubReply {
  status: number;
  /** Objects/arrays are JSON-encoded; a string is sent verbatim (malformed-body cases). */
  body: unknown;
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

export class StubApi {
  readonly requests: StubRequest[] = [];
  handler: (req: StubRequest) => StubReply = () => ({
    status: 500,
    body: { message: 'stub handler not set' },
  });

  #server: Server = createServer((req, res) => {
    this.#onRequest(req, res);
  });
  #origin = '';

  get origin(): string {
    return this.#origin;
  }

  #onRequest(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const record: StubRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: header(req, 'authorization'),
        accept: header(req, 'accept'),
        userAgent: header(req, 'user-agent'),
        apiVersion: header(req, 'x-github-api-version'),
        contentType: header(req, 'content-type'),
        body: Buffer.concat(chunks).toString('utf8'),
      };
      this.requests.push(record);
      const reply = this.handler(record);
      const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(payload);
    });
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.listen(0, '127.0.0.1', () => {
        const addr = this.#server.address() as AddressInfo;
        this.#origin = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.close(() => resolve());
    });
  }

  reset(): void {
    this.requests.length = 0;
  }
}

/** One raw GitHub repo payload; only the mapped subset may reach the browser. */
export function rawRepo(n: number): Record<string, unknown> {
  return {
    id: n,
    node_id: `R_${n}`,
    full_name: `octocat/repo-${n}`,
    name: `repo-${n}`,
    owner: { login: 'octocat', id: 1, avatar_url: 'https://example.invalid/a.png' },
    private: n % 2 === 0,
    description: `repo number ${n}`,
    language: 'TypeScript',
    pushed_at: '2026-07-20T10:00:00Z',
    clone_url: `https://github.com/octocat/repo-${n}.git`,
    // Fields that MUST be dropped by mapRepo:
    ssh_url: `git@github.com:octocat/repo-${n}.git`,
    default_branch: 'main',
    permissions: { admin: true },
  };
}

/**
 * Create a data dir holding a pre-seeded github.json (StoredToken shape, 0600) so
 * a freshly booted server loads it and starts CONNECTED.
 */
export async function seedConnectedDataDir(prefix: string): Promise<{ root: string; dataDir: string }> {
  const root = await makeTempDir(prefix);
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { mode: 0o700 });
  await writeFile(
    join(dataDir, 'github.json'),
    JSON.stringify(
      { accessToken: SECRET, login: 'octocat', scope: 'repo', connectedAt: '2026-07-24T00:00:00Z' },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
  return { root, dataDir };
}
