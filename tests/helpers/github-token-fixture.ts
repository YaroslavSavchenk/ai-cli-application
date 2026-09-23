/**
 * The shared stub of the `tests/server/github-token*.test.ts` files — the
 * PASTED-TOKEN credential path (POST /api/github/token, 2026-07-25).
 *
 * `StubApi` is a local node:http server standing in for api.github.com through
 * the loopback-only AI_SM_GITHUB_API_BASE seam; `acceptingHandler` its "this
 * token works" answer; `postToken` the authed POST; `PASTED` the fake token
 * every assertion treats as a real credential.
 *
 * Moved here out of `tests/server/github-token.test.ts` when it was split by
 * topic (PLAN-RESTRUCTURE O6); the code is unchanged.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { api, type TestServer } from './helpers.ts';

/** Fake pasted token used by the connected HTTP cases. */
export const PASTED = 'ghp_PASTEDdeadbeefdeadbeefdeadbeefdeadbeef';

// ---------------------------------------------------------------------------
// Local stub for the GitHub REST API. Unlike the one in github-connected-fixture.ts
// this one can set RESPONSE HEADERS — x-oauth-scopes and
// github-authentication-token-expiration are the whole point of two cases below.
// ---------------------------------------------------------------------------

export interface StubRequest {
  method: string;
  path: string;
  authorization: string | undefined;
  body: string;
}

export interface StubReply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

export class StubApi {
  readonly requests: StubRequest[] = [];
  handler: (req: StubRequest) => StubReply = () => ({ status: 500, body: { message: 'unset' } });

  #server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers['authorization'];
      const record: StubRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        authorization: Array.isArray(auth) ? auth[0] : auth,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      this.requests.push(record);
      const reply = this.handler(record);
      res.writeHead(reply.status, {
        'content-type': 'application/json',
        ...(reply.headers ?? {}),
      });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
    });
  });
  #origin = '';

  get origin(): string {
    return this.#origin;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      this.#server.listen(0, '127.0.0.1', () => {
        this.#origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
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

/** The default "this token works" stub: identity + one visible repo. */
export function acceptingHandler(headers?: Record<string, string>): (req: StubRequest) => StubReply {
  return (req) => {
    if (req.path === '/user') {
      return {
        status: 200,
        body: { login: 'octocat', id: 1 },
        ...(headers !== undefined ? { headers } : {}),
      };
    }
    if (req.path.startsWith('/user/repos')) {
      return {
        status: 200,
        body: [
          {
            full_name: 'octocat/hello',
            name: 'hello',
            owner: { login: 'octocat' },
            private: false,
            clone_url: 'https://github.com/octocat/hello.git',
          },
        ],
      };
    }
    return { status: 404, body: { message: 'unexpected' } };
  };
}

/** POST /api/github/token with the app auth token and a JSON body. */
export function postToken(
  server: TestServer,
  body: unknown,
): Promise<{ status: number; body: unknown }> {
  return api(server, 'POST', '/api/github/token', body).then((r) => ({
    status: r.status,
    body: r.body,
  }));
}
